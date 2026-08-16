"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.MORGAN_SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";
process.env.MORGAN_GATEWAY_SECRET = "test-gateway-secret-at-least-24-chars";
process.env.MORGAN_APPS_SCRIPT_URL = "https://example.test/apps-script";

const sessionHandler = require("../api/_lib/routes/session");
const bootstrapHandler = require("../api/_lib/routes/bootstrap");
const cloudHandler = require("../api/_lib/routes/cloud");
const customerRecordsHandler = require("../api/_lib/routes/customer-records");
const sqlReadHandler = require("../api/_lib/routes/sql-read");
const lineDailyHandler = require("../api/_lib/routes/line-daily");
const lineWebhook = require("../api/_lib/routes/line-webhook");
const systemHealthHandler = require("../api/_lib/routes/system-health");
const publicBookingHandler = require("../api/_lib/routes/public-booking");
const publicScheduleHandler = require("../api/_lib/routes/public-schedule");
const { safeErrorCategory } = systemHealthHandler;
const { therapistOwnsWrite, validateBookingCommands } = cloudHandler;
const { createSession, verifySession } = require("../api/_lib/session");
const sqlRepository = require("../api/_lib/sql-repository");
const { transform } = require("../scripts/_lib/transform-sheets");
const { projectSelectedDay, digest } = require("../api/_lib/shadow");
const { canTransition, assertBookingTransition } = require("../api/_lib/domain-contracts");
const { isActionAllowed } = require("../api/_lib/policy");
const { publicSnapshot, validateSubmission } = require("../api/_lib/public-booking");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const { Readable } = require("node:stream");
const appCore = require("../app-core");
const appApi = require("../app-api");
const appBooking = require("../app-booking");
const appBookingViews = require("../app-booking-view");

test("browser domain helpers preserve leading-zero IDs and normalize legacy date/time values", () => {
  assert.equal(appCore.cleanPin("'0007"), "0007");
  assert.equal(appCore.sheetText("0007"), "'0007");
  assert.equal(appCore.pinMatches("'0007", "7"), true);
  assert.equal(appCore.normalizeDateField("2030/1/2"), "2030-01-02");
  assert.equal(appCore.normalizeTimeField(0.5), "12:00");
  assert.equal(appCore.minsToTime(appCore.timeToMinutes("23:45")), "23:45");
});

test("operations page loads the shared browser helpers before the main application", () => {
  const source = readFileSync(resolve(__dirname, "../index.html"), "utf8");
  assert.ok(source.indexOf('src="./app-core.js') < source.indexOf('src="./app.js'));
  assert.ok(source.indexOf('src="./app-api.js') < source.indexOf('src="./app.js'));
  assert.ok(source.indexOf('src="./app-booking.js') < source.indexOf('src="./app.js'));
  assert.ok(source.indexOf('src="./app-booking-view.js') < source.indexOf('src="./app.js'));
  assert.match(readFileSync(resolve(__dirname, "../app.js"), "utf8"), /window\.MorganAppCore/);
  assert.match(readFileSync(resolve(__dirname, "../app.js"), "utf8"), /window\.MorganAppApi/);
  assert.match(readFileSync(resolve(__dirname, "../app.js"), "utf8"), /window\.MorganBooking/);
});

test("booking renderer fragments preserve escaped booking content", () => {
  const card = appBookingViews.bookingCardHtml({
    appointment: { id: "A<1", date: "2030-01-02", time: "10:00", bookingStage: "confirmed", phone: "P", customerName: "<客>", therapistId: "001", service: "A60", room: "R", price: 1800 },
    nextActionMeta: () => ({ label: "完成行前通知" }), stageClass: () => "ok", stageLabel: () => "已確認", customerDisplay: () => "<客>", therapistName: () => "師傅", courseName: () => "A60", money: (value) => `$${value}`, esc: (value) => String(value).replace(/</g, "&lt;")
  });
  assert.match(card, /data-open-appt="A&lt;1"/);
  assert.match(card, /&lt;客>/);
  const board = appBookingViews.bookingStageBoardHtml({
    appointments: [{ id: "first", bookingStage: "confirmed" }, { id: "done", bookingStage: "completed" }],
    nextActionMeta: (appointment) => appointment.id === "first" ? { key: "pre_notice" } : { key: "complete" },
    urgencyValue: () => 0, renderCard: (appointment) => `<article>${appointment.id}</article>`
  });
  assert.match(board, /待行前通知/);
  assert.match(board, /first/);
  assert.doesNotMatch(board, /done<\/article>/);
  const rail = appBookingViews.bookingStageRailHtml({ currentStage: "confirmed", workflow: [{ label: "建立" }, { label: "通知" }], workflowIndex: () => 1, esc: (value) => value });
  assert.match(rail, /建立/);
  assert.match(rail, /aria-current="step"/);
});

test("browser booking helpers retain the existing workflow and safe fallback stage", () => {
  assert.equal(appBooking.normalizeBookingStage("", { isCompleted: true }), "completed");
  assert.equal(appBooking.normalizeBookingStage("unknown", {}), "confirmed");
  assert.equal(appBooking.BOOKING_STAGE_NEXT.confirmed[0], "pre_notice");
  assert.equal(appBooking.bookingWorkflowIndex("therapist_match"), 0);
  assert.equal(appBooking.bookingWorkflowIndex("completed"), 4);
  assert.equal(appBooking.isBookingConfirmed({ bookingStage: "pre_notice" }), true);
  assert.equal(appBooking.isBookingUnconfirmed({ bookingStage: "customer_confirm" }), true);
  assert.equal(appBooking.bookingNextActionMeta({ bookingStage: "completed" }, {}).key, "payment_record");
  assert.equal(appBooking.bookingNextActionMeta({ bookingStage: "completed", collectedPrice: "100" }, { notes: "" }).reminder, true);
  assert.ok(appBooking.bookingUrgencyValue({ date: "2030-01-01", time: "10:00" }) < appBooking.bookingUrgencyValue({ date: "2030-01-02", time: "10:00" }));
  const list = appBooking.buildBookingListModel({
    appointments: [
      { id: "day-confirmed", date: "2030-01-02", bookingStage: "confirmed" },
      { id: "month-followup", date: "2030-01-03", bookingStage: "completed", isCompleted: true, collectedPrice: "100" },
      { id: "outside", date: "2030-02-01", bookingStage: "inquiry" }
    ],
    monthDateKeys: ["2030-01-02", "2030-01-03"], activeDate: "2030-01-02", scope: "month",
    recordForAppointment: () => ({ notes: "" })
  });
  assert.equal(list.monthAppointments.length, 2);
  assert.equal(list.dayAppointments[0].id, "day-confirmed");
  assert.equal(list.visibleConfirmed.length, 2);
  assert.equal(list.visibleFollowup[0].id, "month-followup");
  const detail = appBooking.buildBookingDetailModel({
    appointment: { time: "23:30", duration: 90, room: "OUT" },
    course: { therapistCut: 1600 }, remittanceDue: 1200, editMode: true, editSection: "financial"
  });
  assert.equal(detail.endTime, "01:00");
  assert.equal(detail.roomLabel, "外出");
  assert.equal(detail.therapistCut, 1600);
  assert.equal(detail.editScope, "financial");
});

test("browser API transport uses same-origin no-store requests and clears its timeout", async () => {
  const originalFetch = global.fetch;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const timeout = {};
  let cleared = false;
  global.setTimeout = () => timeout;
  global.clearTimeout = (value) => { cleared = value === timeout; };
  global.fetch = async (_url, options) => {
    assert.equal(options.credentials, "same-origin");
    assert.equal(options.cache, "no-store");
    assert.ok(options.signal);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  };
  try {
    const result = await appApi.fetchJson("/api/example", {}, 123);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload, { success: true });
    assert.equal(cleared, true);
  } finally {
    global.fetch = originalFetch;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
});

test("booking contract separates customer selection from confirmed booking", () => {
  assert.equal(canTransition("therapist_match", "customer_confirm"), true);
  assert.equal(canTransition("customer_confirm", "confirmed"), true);
  assert.equal(canTransition("therapist_match", "confirmed"), false);
  assert.throws(() => assertBookingTransition({ from: "therapist_match", to: "confirmed", role: "admin" }), /invalid_booking_transition/);
  assert.throws(() => assertBookingTransition({ from: "confirmed", to: "pre_notice", role: "therapist" }), /booking_transition_forbidden/);
});

test("role policy allows only scoped action families", () => {
  assert.equal(isActionAllowed("admin", "deleteCustomer"), true);
  assert.equal(isActionAllowed("therapist", "saveServiceRecord"), true);
  assert.equal(isActionAllowed("therapist", "deleteCustomer"), false);
  assert.equal(isActionAllowed("customer", "saveCustomer"), false);
});

test("booking commands reject skipped stages and preserve legacy omitted expectations", () => {
  assert.throws(() => validateBookingCommands({ role: "admin" }, "addAppointment", {
    expectedBookingStage: "therapist_match", bookingStage: "confirmed"
  }), /invalid_booking_transition/);
  assert.doesNotThrow(() => validateBookingCommands({ role: "admin" }, "addAppointment", {
    bookingStage: "confirmed"
  }));
  assert.throws(() => validateBookingCommands({ role: "therapist" }, "addAppointment", {
    expectedBookingStage: "confirmed", bookingStage: "pre_notice"
  }), /booking_transition_forbidden/);
});

test("only admins may use a booking stage override and must provide a reason", () => {
  assert.throws(() => validateBookingCommands({ role: "therapist" }, "addAppointment", {
    expectedBookingStage: "confirmed", bookingStage: "completed", allowStageOverride: "true", stageOverrideReason: "補登"
  }), /booking_override_forbidden/);
  assert.throws(() => validateBookingCommands({ role: "admin" }, "addAppointment", {
    expectedBookingStage: "confirmed", bookingStage: "completed", allowStageOverride: "true", stageOverrideReason: "修正"
  }), /booking_override_reason_required/);
  assert.doesNotThrow(() => validateBookingCommands({ role: "admin" }, "addAppointment", {
    expectedBookingStage: "confirmed", bookingStage: "completed", allowStageOverride: "true", stageOverrideReason: "補登服務完成資料"
  }));
});

test("customer selection keeps a stable id for retry deduplication", () => {
  const source = readFileSync(resolve(__dirname, "../client-selection.html"), "utf8");
  assert.match(source, /const submissionId = query\.selectionId \|\| `SEL-/);
  assert.match(source, /const id = submissionId;/);
});

test("public booking only projects enabled courses, slots and minimal therapist details", () => {
  const today = "2030-01-02";
  const data = {
    therapists: { "001": { name: "公開師傅", photoUrl: "https://example.test/a.jpg", specialties: "精油按摩", pin: "0007" } },
    schedules: { "001": { [today]: "11:00-22:00" } }, appointments: {},
    customers: { SYS_OPERATIONS_CONFIG: { notes: JSON.stringify({ courses: [{ code: "A60", name: "A 60", duration: 60, price: 1800, enabled: true }, { code: "OLD", name: "停用", duration: 60, price: 1, enabled: false }], rooms: [{ code: "R", enabled: true }] }) } }
  };
  const snapshot = publicSnapshot(data, { date: today, service: "A60", time: "11:00" });
  assert.deepEqual(snapshot.courses.map((item) => item.code), ["A60"]);
  assert.equal(snapshot.therapists[0].id, "001");
  assert.equal(snapshot.therapists[0].name, "公開師傅");
  assert.equal(Object.hasOwn(snapshot.therapists[0], "pin"), false);
  assert.ok(snapshot.slots.includes("11:00"));
});

test("public booking validates a stable request id and reserves a pending confirmation request", () => {
  const next = new Date(); next.setDate(next.getDate() + 1);
  const future = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
  const data = { therapists: { "001": { name: "公開師傅" } }, schedules: { "001": { [future]: "11:00-22:00" } }, appointments: {}, customers: {} };
  const selection = validateSubmission(data, { requestId: "PUB-12345678", date: future, time: "11:00", service: "A60", therapistId: "001", customerContact: "0900000000" });
  assert.equal(selection.status, "pending");
  assert.equal(selection.actorType, "customer_public");
  assert.equal(selection.selectedTherapistId, "001");
  assert.throws(() => validateSubmission(data, { requestId: "bad", date: future, time: "11:00", service: "A60", therapistId: "001", customerContact: "0900000000" }), /invalid_request_id/);
});

test("public booking page is a fixed API-only confirmation-request flow", () => {
  const source = readFileSync(resolve(__dirname, "../customer-booking.html"), "utf8");
  assert.match(source, /\/api\/public-booking/);
  assert.match(source, /已送出預約需求/);
  assert.match(source, /尚未成立正式預約/);
  assert.match(source, /正在確認可用性/);
  assert.doesNotMatch(source, /script\.google\.com/);
});

test("Apps Script preserves the distinct public-booking source inside the legacy selection record", () => {
  const source = readFileSync(resolve(__dirname, "../apps-script-secure-Code.gs"), "utf8");
  assert.match(source, /source: String\(data\.source \|\| 'public-client-selection'\)/);
  assert.match(source, /actorType: String\(data\.actorType \|\| 'customer_public'\)/);
  assert.match(source, /SYS_PUBLIC_BOOKING_SLOT_/);
  assert.match(source, /throw new Error\('booking_conflict'\)/);
});

test("public booking API writes a pending demand and verifies it by a server read-back", async () => {
  const next = new Date(); next.setDate(next.getDate() + 1);
  const date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
  const db = { therapists: { "001": { name: "公開師傅" } }, schedules: { "001": { [date]: "11:00-22:00" } }, appointments: {}, customers: {} };
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => {
    const request = JSON.parse(options.body || "{}");
    if (request.action === "submitClientSelection") db.customers[`SYS_CLIENT_SELECTION_${request.data.id}`] = { notes: JSON.stringify(request.data) };
    return new Response(JSON.stringify({ success: true, data: db, verified: true }), { status: 200 });
  };
  const headers = {};
  const response = { setHeader(key, value) { headers[key] = value; }, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
  try {
    await publicBookingHandler({ method: "POST", headers: {}, body: { requestId: "PUB-98765432", date, time: "11:00", service: "A60", therapistId: "001", customerContact: "0900000000" }, query: {} }, response);
    assert.equal(response.statusCode, 201);
    assert.equal(response.payload.success, true);
    assert.equal(response.payload.verified, true);
    assert.equal(JSON.parse(db.customers["SYS_CLIENT_SELECTION_PUB-98765432"].notes).status, "pending");
    const retry = { setHeader() {}, status(code) { this.statusCode = code; return this; }, json(payload) { this.payload = payload; return this; } };
    await publicBookingHandler({ method: "POST", headers: {}, body: { requestId: "PUB-98765432", date, time: "11:00", service: "A60", therapistId: "001", customerContact: "0900000000" }, query: {} }, retry);
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.payload.duplicate, true);
  } finally { global.fetch = originalFetch; }
});

test("SQL public booking reserves a therapist slot through a unique legacy system record", () => {
  const source = readFileSync(resolve(__dirname, "../api/_lib/sql-repository.js"), "utf8");
  assert.match(source, /SYS_PUBLIC_BOOKING_SLOT_/);
  assert.match(source, /ON CONFLICT \(key\) DO NOTHING/);
  assert.match(source, /new Error\("booking_conflict"\)/);
});

test("customer selection page blocks expired links before and during submission", () => {
  const source = readFileSync(resolve(__dirname, "../client-selection.html"), "utf8");
  assert.match(source, /function isSelectionExpired\(date, time\)/);
  assert.match(source, /if \(isSelectionExpired\(query\.date, query\.time\)\)/);
  assert.match(source, /showUnavailableSelection\("這筆客選連結已超過預約時段/);
});

test("customer selection rejects a link without date or time before fetching candidates", () => {
  const source = readFileSync(resolve(__dirname, "../client-selection.html"), "utf8");
  const invalidLinkCheck = source.indexOf('if (!query.date || !query.time)');
  const loadingStart = source.indexOf("showCandidateLoading();");
  assert.ok(invalidLinkCheck >= 0);
  assert.ok(loadingStart > invalidLinkCheck);
  assert.match(source, /缺少日期或時間參數/);
  assert.match(source, /selectionFormCard"\)\.classList\.add\("hidden"\)/);
});

test("customer selection hides the contact form when no candidate can be arranged", () => {
  const source = readFileSync(resolve(__dirname, "../client-selection.html"), "utf8");
  assert.match(source, /function showNoCandidateState\(\)/);
  assert.match(source, /目前無可安排的師傅/);
  assert.match(source, /selectionFormCard"\)\.classList\.add\("hidden"\)/);
  assert.match(source, /showNoCandidateState\(\);/);
});

test("customer selection revalidates candidate availability immediately before submit", () => {
  const source = readFileSync(resolve(__dirname, "../client-selection.html"), "utf8");
  assert.match(source, /async function refreshCandidateAvailability\(\)/);
  assert.match(source, /const stillAvailable = await refreshCandidateAvailability\(\)/);
  assert.match(source, /這位師傅的時段剛剛已變更/);
});

test("admin client-selection queue exposes availability and guards quick confirmation", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /function clientSelectionAvailability\(selection = \{\}\)/);
  assert.match(source, /const availability = clientSelectionAvailability\(selection\)/);
  assert.match(source, /const availability = clientSelectionAvailability\(selection\);\n  if \(!availability\.available\)/);
});

test("quick client selection confirmation requires both appointment and selection read-back", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /function clientSelectionConfirmationVerified\(selectionId, appointmentId, cloudDb\)/);
  assert.match(source, /requireReadBack: true/);
  assert.match(source, /selection\.status === "confirmed"/);
  assert.match(source, /appointment\.selectionId === selectionId/);
});

test("pre-notice action opens an editable notice editor before completion", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /function openNoticeEditorModal\(appt\)/);
  assert.match(source, /id="noticeEditorTherapist"/);
  assert.match(source, /id="copyTherapistNoticeBtn"/);
  assert.match(source, /id="copyAndCompleteNoticeBtn"/);
  assert.match(source, /openNoticeEditorModal\(appt\)/);
});

test("service result focuses payment and leaves service notes optional", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  const bookingSource = readFileSync(resolve(__dirname, "../app-booking.js"), "utf8");
  assert.match(source, /data-focus-service-result/);
  assert.match(source, /const payment = form\?\.querySelector\('\[name="collectedPrice"\]/);
  assert.match(source, /const notes = form\?\.querySelector\('\[name="recordNotes"\]/);
  assert.match(source, /normalizeBookingStage\(old\.bookingStage, old\) === "pre_notice" && String\(data\.collectedPrice \|\| ""\)\.trim\(\) !== ""/);
  assert.match(bookingSource, /帳務已完成，待補服務紀錄/);
});

test("therapist and customer notices share the same editable panel layout", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /給師傅的通知內容/);
  assert.match(source, /給顧客的通知內容/);
  assert.match(source, /noticeEditorCustomer.*min-h-40/);
  assert.doesNotMatch(source, /<details class=\\"rounded-xl border border-slate-200 bg-slate-50 p-3\\"><summary[^>]*>顧客通知/);
});

test("mobile layout constrains modal and appointment content to viewport", () => {
  const source = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
  assert.match(source, /#modalRoot \.modal-backdrop \{ width:100vw; max-width:100vw; padding:0; overflow:hidden; \}/);
  assert.match(source, /#modalRoot \.modal textarea \{ display:block; width:100%; min-width:0; max-width:100%;/);
  assert.match(source, /#view-dispatch \.appointment-detail-view,\n  #view-dispatch \.appointment-detail-layout/);
});

test("mobile navigation consolidates accounting and system under an explicit more action", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /const mobilePrimary = ADMIN_NAV_ITEMS\.filter/);
  assert.match(source, /data-mobile-more/);
  assert.match(source, /function openMobileMoreMenu\(\)/);
  assert.match(source, /const mobileMoreButton = closestFromEvent\(event, "\[data-mobile-more\]"\)/);
});

test("personnel schedule calculates each therapist's selected-range working hours", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /function shiftScheduledMinutes\(shift = ""\)/);
  assert.match(source, /function therapistScheduledHours\(id, dates = currentScheduleViewDates\)/);
  assert.match(source, /指定區間排班時數/);
  assert.match(source, /合計 \$\{formatScheduledHours\(totalScheduledMinutes\)\}/);
  assert.match(source, /指定區間排班時數\\n/);
  assert.match(source, /schedule-table-wrap[\s\S]*?<details id="scheduleHoursDetails"/);
  assert.match(source, /<details id="scheduleHoursDetails"/);
});

test("mobile personnel schedule keeps five navigation slots and contains its wide matrix", () => {
  const script = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  const styles = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
  assert.match(script, /schedule-mobile-scroll-hint/);
  assert.match(styles, /#mobileBottomNav \{ grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(styles, /#view-personnel \.schedule-table-wrap \{ width:100%; max-width:100%; overscroll-behavior-x:contain; \}/);
  assert.match(styles, /#view-personnel \.schedule-filter-bar > span \{ display:none; \}/);
  assert.equal(styles.lastIndexOf("#mobileBottomNav { grid-template-columns:repeat(5,minmax(0,1fr))"), styles.lastIndexOf("#mobileBottomNav { grid-template-columns:"));
});

test("booking detail keeps operational facts in the hero and limits the supplemental card", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /appointment-info-grid--supplemental/);
  assert.match(source, /<h4>補充資訊<\/h4>/);
  assert.match(source, /服務紀錄<\/span><p>\$\{esc\(record\.notes \|\| "可稍後補"/);
});

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test("signed sessions preserve leading-zero staff IDs and reject tampering", () => {
  const session = createSession({ id: "002", name: "測試師傅", role: "therapist" });
  const req = { headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` } };
  assert.equal(verifySession(req).sub, "002");
  const tampered = { headers: { cookie: `morgan_session=${encodeURIComponent(session.token + "x")}` } };
  assert.equal(verifySession(tampered), null);
});

test("session endpoint returns identity without returning the PIN", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.data.id, "002");
    assert.equal(request.data.pin, "0007");
    assert.equal(request.gatewayToken, process.env.MORGAN_GATEWAY_SECRET);
    return new Response(JSON.stringify({ success: true, authenticated: true, identity: { id: "002", name: "測試師傅", role: "therapist" } }), { status: 200 });
  };
  try {
    const req = { method: "POST", headers: {}, body: { id: "002", pin: "0007" } };
    const res = responseMock();
    await sessionHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.identity.sub, "002");
    assert.equal(JSON.stringify(res.body).includes("0007"), false);
    assert.match(res.headers["set-cookie"], /HttpOnly/);
    assert.match(res.headers["set-cookie"], /SameSite=Lax/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("bootstrap endpoint requires a valid session", async () => {
  const res = responseMock();
  await bootstrapHandler({ method: "GET", headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "unauthorized");
});

test("system health is admin-only and classifies errors without exposing connection details", async () => {
  assert.equal(safeErrorCategory({ code: "database_not_configured", message: "DATABASE_URL is not configured" }), "not_configured");
  assert.equal(safeErrorCategory({ message: "request timeout" }), "timeout");
  const therapist = createSession({ id: "002", name: "測試師傅", role: "therapist" });
  const forbidden = responseMock();
  await systemHealthHandler({ method: "GET", headers: { cookie: `morgan_session=${encodeURIComponent(therapist.token)}` }, query: {} }, forbidden);
  assert.equal(forbidden.statusCode, 403);
  const admin = createSession({ id: "admin", name: "管理員", role: "admin" });
  const allowed = responseMock();
  await systemHealthHandler({ method: "GET", headers: { cookie: `morgan_session=${encodeURIComponent(admin.token)}` }, query: {} }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.body.success, true);
  assert.equal(allowed.body.status, "not_checked");
  assert.equal(allowed.body.components.some((item) => item.name === "LINE／Cron" && item.status === "not_configured"), true);
  assert.equal(JSON.stringify(allowed.body).includes("DATABASE_URL"), false);
});

test("operations config is shared by admin, frontdesk, and customer selection without replacing legacy defaults", () => {
  const admin = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  const frontdesk = readFileSync(resolve(__dirname, "../frontdesk.html"), "utf8");
  const selection = readFileSync(resolve(__dirname, "../client-selection.html"), "utf8");
  assert.match(admin, /const OPERATIONS_CONFIG_KEY = "SYS_OPERATIONS_CONFIG"/);
  assert.match(admin, /function activeCourses\(\)/);
  assert.match(frontdesk, /function applyOperationsConfigFromDb\(\)/);
  assert.match(selection, /const OPERATIONS_CONFIG_KEY = "SYS_OPERATIONS_CONFIG"/);
  assert.match(selection, /config\.courses\.forEach/);
  assert.match(admin, /既有預約金額與時長不會變動/);
});

test("operations settings make ordering, disabling, and confirmation explicit without deleting legacy codes", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /排序數字小的先顯示/);
  assert.match(source, /不提供刪除/);
  assert.match(source, /儲存本頁營運設定/);
  assert.match(source, /confirmAction\("儲存本頁營運設定？"/);
  assert.match(source, /取消啟用後，新預約不能選擇/);
});

test("LINE webhook signature verification accepts only the original signed payload", () => {
  const originalSecret = process.env.LINE_CHANNEL_SECRET;
  process.env.LINE_CHANNEL_SECRET = "line-test-secret";
  try {
    const body = Buffer.from('{"events":[]}');
    const signature = require("node:crypto").createHmac("sha256", process.env.LINE_CHANNEL_SECRET).update(body).digest("base64");
    assert.equal(lineWebhook.validSignature(body, signature), true);
    assert.equal(lineWebhook.validSignature(Buffer.from('{"events":[1]}'), signature), false);
    assert.equal(lineWebhook.validSignature(body, "not-a-line-signature"), false);
  } finally { process.env.LINE_CHANNEL_SECRET = originalSecret; }
});

test("LINE webhook rejects unsigned requests before parsing or writing a recipient", async () => {
  const req = Readable.from([Buffer.from('{"events":[]}')]);
  req.method = "POST";
  req.headers = {};
  const res = responseMock();
  await lineWebhook(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "invalid_signature");
});

test("LINE manual reminder endpoint requires its independent cron secret", async () => {
  const originalSecret = process.env.LINE_CRON_SECRET;
  process.env.LINE_CRON_SECRET = "line-cron-test-secret";
  try {
    const res = responseMock();
    await lineDailyHandler({ method: "POST", headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, "unauthorized");
  } finally { process.env.LINE_CRON_SECRET = originalSecret; }
});

test("bootstrap forwards only signed identity and date", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.data, { id: "admin", role: "admin", date: "2026-08-07" });
    return new Response(JSON.stringify({
      success: true,
      data: { therapists: {}, schedules: {}, appointments: {}, customers: {} },
      meta: { partial: true, cache: "hit" }
    }), { status: 200 });
  };
  try {
    const session = createSession({ id: "admin", name: "管理員", role: "admin" });
    const req = { method: "GET", headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` }, query: { date: "2026-08-07" } };
    const res = responseMock();
    await bootstrapHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.partial, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("therapist sessions cannot call administrative write actions", async () => {
  const session = createSession({ id: "002", name: "測試師傅", role: "therapist" });
  const req = {
    method: "POST",
    headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` },
    body: { action: "deleteTherapist", data: { id: "003" } }
  };
  const res = responseMock();
  await cloudHandler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "forbidden");
});

test("therapist gateway writes are constrained to the signed staff ID", () => {
  const session = { sub: "002", role: "therapist" };
  assert.equal(therapistOwnsWrite(session, "saveSchedule", { id: "002", schedule: {} }), true);
  assert.equal(therapistOwnsWrite(session, "saveSchedule", { id: "003", schedule: {} }), false);
  assert.equal(therapistOwnsWrite(session, "addAppointment", { appId: "A1", therapistId: "003" }), false);
});

test("therapist report batch permits only its own appointment and related records", () => {
  const session = { sub: "002", role: "therapist" };
  const allowed = {
    actions: [
      { action: "saveCustomer", data: { phone: "0912345678", name: "客人" } },
      { action: "addAppointment", data: { appId: "A1", therapistId: "002", phone: "0912345678" } },
      { action: "saveCustomer", data: { phone: "SYS_APPT_META_A1", notes: "{}" } }
    ]
  };
  assert.equal(therapistOwnsWrite(session, "batch", allowed), true);
  allowed.actions[1].data.therapistId = "003";
  assert.equal(therapistOwnsWrite(session, "batch", allowed), false);
});

test("therapist service records must belong to the signed therapist", () => {
  const session = { sub: "002", role: "therapist" };
  assert.equal(therapistOwnsWrite(session, "saveServiceRecord", { record_id: "A1", customer_key_legacy: "0912", therapistId: "002" }), true);
  assert.equal(therapistOwnsWrite(session, "saveServiceRecord", { record_id: "A1", customer_key_legacy: "0912", therapistId: "003" }), false);
});

test("cloud writes forward mutation IDs and return targeted verification", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.mutationId, "MUT-001");
    assert.deepEqual(request.actor, { id: "admin", role: "admin" });
    return new Response(JSON.stringify({ success: true, verified: true, mutationId: "MUT-001", changedEntities: [{ action: "saveCustomer", id: "0912" }], cacheVersion: "8" }), { status: 200 });
  };
  try {
    const session = createSession({ id: "admin", name: "管理員", role: "admin" });
    const req = { method: "POST", headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` }, body: { action: "saveCustomer", data: { phone: "0912" }, mutationId: "MUT-001" } };
    const res = responseMock();
    await cloudHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.mutationId, "MUT-001");
    assert.equal(res.body.changedEntities.length, 1);
  } finally { global.fetch = originalFetch; }
});

test("customer record pagination requires a signed session and preserves leading-zero identity", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.data, { customerKey: "0912", cursor: 0, limit: 50, id: "002", role: "therapist" });
    return new Response(JSON.stringify({ success: true, records: [{ id: "A1", therapistId: "002" }], nextCursor: null, total: 1 }), { status: 200 });
  };
  try {
    const session = createSession({ id: "002", name: "測試師傅", role: "therapist" });
    const req = { method: "GET", headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` }, query: { customerKey: "0912", cursor: "0", limit: "50" } };
    const res = responseMock();
    await customerRecordsHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.records[0].therapistId, "002");
  } finally { global.fetch = originalFetch; }
});

test("SQL session combines authentication and selected-day bootstrap in one API response", async () => {
  const originalMode = process.env.MORGAN_DATA_SOURCE;
  const originalMethod = sqlRepository.authenticateAndBootstrap;
  process.env.MORGAN_DATA_SOURCE = "sql";
  sqlRepository.authenticateAndBootstrap = async (id, pin, date) => {
    assert.equal(id, "002");
    assert.equal(pin, "0007");
    assert.equal(date, "2026-08-10");
    return {
      authenticated: true,
      identity: { id: "002", name: "測試師傅", role: "therapist" },
      bootstrap: { therapists: { "002": { name: "測試師傅", pin: "" } }, schedules: {}, admins: {}, appointments: {}, customers: {} },
      meta: { source: "neon-postgres", partial: true },
      sqlMs: 12
    };
  };
  try {
    const req = { method: "POST", headers: {}, body: { id: "002", pin: "0007", date: "2026-08-10" } };
    const res = responseMock();
    await sessionHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.identity.sub, "002");
    assert.equal(res.body.bootstrap.therapists["002"].name, "測試師傅");
    assert.equal(res.body.meta.source, "neon-postgres");
    assert.equal(JSON.stringify(res.body).includes("0007"), false);
    assert.match(res.headers["server-timing"], /^sql;dur=/);
  } finally {
    sqlRepository.authenticateAndBootstrap = originalMethod;
    process.env.MORGAN_DATA_SOURCE = originalMode;
  }
});

test("SQL cloud returns the original result for the same mutation ID", async () => {
  const originalMode = process.env.MORGAN_DATA_SOURCE;
  const originalMethod = sqlRepository.applyMutation;
  process.env.MORGAN_DATA_SOURCE = "sql";
  const stored = new Map();
  let writes = 0;
  sqlRepository.applyMutation = async (_identity, mutationId) => {
    if (stored.has(mutationId)) return stored.get(mutationId);
    writes += 1;
    const result = { success: true, verified: true, mutationId, changedEntities: [{ action: "saveCustomer", id: "0912" }], version: "1" };
    stored.set(mutationId, result);
    return result;
  };
  try {
    const session = createSession({ id: "admin", name: "管理員", role: "admin" });
    for (let index = 0; index < 2; index += 1) {
      const req = { method: "POST", headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` }, body: { action: "saveCustomer", data: { phone: "0912" }, mutationId: "MUT-001" } };
      const res = responseMock();
      await cloudHandler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.verified, true);
    }
    assert.equal(writes, 1);
  } finally {
    sqlRepository.applyMutation = originalMethod;
    process.env.MORGAN_DATA_SOURCE = originalMode;
  }
});

test("migration transform preserves leading-zero IDs and splits a critical-size customer record cell", () => {
  const notes = "x".repeat(49700);
  const source = {
    therapists: { "002": { name: "測試師傅", pin: "0007" } },
    schedules: { "002": { "2026-08-10": "13:00-21:00" } },
    appointments: { "0007": { id: "0007", date: "2026-08-10", time: "13:00", therapistId: "002", phone: "0912", customerName: "客人" } },
    customers: { "0912": { name: "客人", notes: "", records: [{ id: "0007", date: "2026-08-10", therapistId: "002", notes }] } }
  };
  assert.ok(JSON.stringify(source.customers["0912"].records).length > 49700);
  const result = transform(source);
  assert.equal(result.users[0].accountId, "002");
  assert.equal(result.users[0].pin, "0007");
  assert.equal(result.appointments[0].id, "0007");
  assert.equal(result.serviceRecords.length, 1);
  assert.equal(result.serviceRecords[0].notes.length, 49700);
});

test("database migration enforces advisory mutation locking and never defines LINE objects", () => {
  const migration = readFileSync(resolve(__dirname, "../drizzle/0000_morgan_sql.sql"), "utf8");
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /mutation_id text PRIMARY KEY/);
  assert.equal(/LINE_TOKEN|LINE_STAFF_RECIPIENTS|doPostLine|Webhook/i.test(migration), false);
});

test("SQL outage is labeled so the browser does not fall back to Apps Script", async () => {
  const originalMode = process.env.MORGAN_DATA_SOURCE;
  const originalMethod = sqlRepository.authenticateAndBootstrap;
  process.env.MORGAN_DATA_SOURCE = "sql";
  sqlRepository.authenticateAndBootstrap = async () => { throw new Error("connection timeout"); };
  try {
    const res = responseMock();
    await sessionHandler({ method: "POST", headers: {}, body: { id: "002", pin: "0007", date: "2026-08-10" } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.dataSource, "sql");
    assert.equal(res.body.error, "authentication_service_unavailable");
  } finally {
    sqlRepository.authenticateAndBootstrap = originalMethod;
    process.env.MORGAN_DATA_SOURCE = originalMode;
  }
});

test("public frontdesk schedule is SQL-only and exposes only the requested therapist's shifts", async () => {
  const originalMode = process.env.MORGAN_DATA_SOURCE;
  const originalMethod = sqlRepository.publicTherapistSchedule;
  process.env.MORGAN_DATA_SOURCE = "sql";
  sqlRepository.publicTherapistSchedule = async (therapistId, from, to) => ({
    therapist: { id: "002", name: "測試師傅" }, schedules: { "2026-08-10": "13:00-21:00" }, from, to, requested: therapistId
  });
  try {
    const res = responseMock();
    await publicScheduleHandler({ method: "GET", headers: {}, query: { therapistId: "2", from: "2026-08-01", to: "2026-08-31" } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.therapist, { id: "002", name: "測試師傅" });
    assert.deepEqual(res.body.schedules, { "2026-08-10": "13:00-21:00" });
    assert.equal(Object.hasOwn(res.body, "appointments"), false);
    assert.equal(Object.hasOwn(res.body, "customers"), false);
    assert.match(res.headers["server-timing"], /^sql;dur=/);
  } finally {
    sqlRepository.publicTherapistSchedule = originalMethod;
    process.env.MORGAN_DATA_SOURCE = originalMode;
  }
});

test("public frontdesk schedule keeps an explicit bounded date range", () => {
  const source = readFileSync(resolve(__dirname, "../api/_lib/sql-repository.js"), "utf8");
  assert.match(source, /rangeDays > 62/);
  assert.match(source, /It never returns appointments or customer data/);
});

test("frontdesk stays on scoped SQL APIs and never falls back to Apps Script or admin full-data", () => {
  const source = readFileSync(resolve(__dirname, "../frontdesk.html"), "utf8");
  assert.match(source, /\/api\/public-schedule/);
  assert.match(source, /const mutationId = String\(payload\?\.mutationId \|\| `FD-/);
  assert.match(source, /body: JSON\.stringify\(\{ \.\.\.payload, mutationId \}\)/);
  assert.match(source, /\/api\/schedules\?from=/);
  assert.match(source, /\/api\/appointments\?from=/);
  assert.doesNotMatch(source, /script\.google\.com/);
  assert.doesNotMatch(source, /\/api\/full-data/);
});

test("browser enables fast API on Preview and explicitly blocks SQL fallback", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /FAST_API_ENABLED = URL_OPTIONS\.get\("fastApi"\) === "1" \|\| !LOCAL_TEST_MODE/);
  assert.match(source, /payload\?\.dataSource === "sql"/);
  assert.match(source, /本次不切回舊版資料源/);
});

test("legacy remittance compatibility does not replace scoped booking editors", () => {
  const source = readFileSync(resolve(__dirname, "../remittance-fields-patch.js"), "utf8");
  assert.equal(source.includes("enhanceAppointmentDetailForm"), false);
  assert.equal(source.includes("saveAppointmentDetailWithRemittance"), false);
  assert.equal(source.includes("amountContainer.innerHTML"), false);
  assert.equal(source.includes("renderAppointmentDetail = function patchedRenderAppointmentDetail"), false);
  assert.match(source, /openTherapistReport = function patchedOpenTherapistReport/);
});

test("scoped booking editors have isolated visible field contracts", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /basic: new Set\(\["date", "time", "therapistId", "room", "bookingStage", "service", "duration", "price"\]\)/);
  assert.match(source, /customer: new Set\(\["phone", "customerName", "notes", "recordNotes"\]\)/);
  assert.match(source, /financial: new Set\(\["price", "remittanceDue", "collectedPrice", "remittanceMethod", "remittanceNote", "remittanceAccountLast5"\]\)/);
  assert.match(source, /<label class="label">服務金額<\/label>/);
  assert.match(source, /<label class="label">應回帳款<\/label>/);
  assert.match(source, /師傅抽成<\/span>/);
  assert.match(source, /選擇轉帳時，請填寫正確的帳戶末五碼。/);
  assert.match(source, /\.filter\(\(\[name, value\]\) => !visibleFields\.has\(name\)/);
});

test("customer selection links always use the public Morgan origin", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /PUBLIC_CLIENT_SELECTION_ORIGIN\s*=\s*"https:\/\/morgan-ops-hub\.vercel\.app"/);
  assert.match(source, /new URL\("\/client-selection\.html", PUBLIC_CLIENT_SELECTION_ORIGIN\)/);
});

test("customer selection makes a slow candidate read visible before the response returns", () => {
  const source = readFileSync(resolve(__dirname, "../client-selection.html"), "utf8");
  assert.match(source, /正在讀取可選師傅/);
  assert.match(source, /function showCandidateLoading\(\)/);
  assert.match(source, /showCandidateLoading\(\);/);
  assert.match(source, /aria-busy="true"/);
  assert.match(source, /prefers-reduced-motion: reduce/);
});

test("shadow comparison projects legacy 30-day data to the selected-day SQL contract", () => {
  const projected = projectSelectedDay({
    therapists: { "002": { name: "A" }, "003": { name: "B" } },
    schedules: { "002": { "2026-08-10": "13:00-21:00" }, "003": {} },
    admins: {},
    appointments: {
      A1: { id: "A1", date: "2026-08-10", therapistId: "002", phone: "0912" },
      A2: { id: "A2", date: "2026-08-11", therapistId: "002", phone: "0913" }
    },
    customers: {
      "0912": { name: "今天", records: [{ id: "OLD" }] },
      "0913": { name: "明天", records: [] },
      SYS_APPT_META_A1: { notes: "{}", records: [] },
      SYS_APPT_META_A2: { notes: "{}", records: [] },
      SYS_THERAPIST_PROFILE_002: { notes: "{}", records: [] },
      SYS_THERAPIST_PROFILE_003: { notes: "{}", records: [] }
    }
  }, "2026-08-10", { id: "002", role: "therapist" });
  assert.deepEqual(Object.keys(projected.therapists), ["002"]);
  assert.deepEqual(Object.keys(projected.appointments), ["A1"]);
  assert.equal(projected.customers["0912"].records.length, 0);
  assert.ok(projected.customers.SYS_APPT_META_A1);
  assert.equal(projected.customers.SYS_APPT_META_A2, undefined);
  assert.equal(projected.customers.SYS_THERAPIST_PROFILE_003, undefined);
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
});

test("consolidated Vercel routers preserve existing URLs behind three function entries", async () => {
  const res = responseMock();
  await sqlReadHandler({ method: "GET", headers: {}, query: { route: "appointments" } }, res);
  assert.equal(res.statusCode, 401);
  const config = JSON.parse(readFileSync(resolve(__dirname, "../vercel.json"), "utf8"));
  assert.equal(config.rewrites.find((item) => item.source === "/api/appointments").destination, "/api/ops?endpoint=sql-read&route=appointments");
  assert.equal(config.rewrites.find((item) => item.source === "/api/cloud").destination, "/api/ops?endpoint=cloud");
  assert.equal(config.rewrites.find((item) => item.source === "/api/public-booking").destination, "/api/public?endpoint=public-booking");
  assert.equal(config.rewrites.find((item) => item.source === "/api/line/webhook").destination, "/api/line?endpoint=webhook");
});

test("Vercel schedules LINE daily digest at 09:00 Taiwan and checks upcoming reminders daily at 10:00 Taiwan", () => {
  const config = JSON.parse(readFileSync(resolve(__dirname, "../vercel.json"), "utf8"));
  assert.deepEqual(config.crons, [
    { path: "/api/cron/line-daily", schedule: "0 1 * * *" },
    { path: "/api/cron/line-upcoming", schedule: "0 2 * * *" }
  ]);
});
