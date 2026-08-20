"use strict";

const { sqlClient } = require("./database");

const LINE_PUSH_ENDPOINT = "https://api.line.me/v2/bot/message/push";
const LINE_REPLY_ENDPOINT = "https://api.line.me/v2/bot/message/reply";
const TAIPEI_TIME_ZONE = "Asia/Taipei";

function taipeiParts(value = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TAIPEI_TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(value).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return parts;
}

function taipeiDate(value = new Date()) {
  const parts = taipeiParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function taipeiMinute(value = new Date()) {
  const parts = taipeiParts(value);
  return Number(parts.hour) * 60 + Number(parts.minute);
}

function configured(value) {
  const result = String(value || "").trim();
  if (!result) throw Object.assign(new Error("LINE is not configured"), { code: "line_not_configured" });
  return result;
}

async function boundGroupId() {
  const rows = await sqlClient()`SELECT recipient_id FROM line_staff_recipients WHERE recipient_key = 'staff-group' LIMIT 1`;
  return rows[0] ? String(rows[0].recipient_id) : "";
}

async function bindStaffGroup(groupId) {
  const id = String(groupId || "").trim();
  if (!id || id.length > 255) return { status: "invalid" };
  const sql = sqlClient();
  const inserted = await sql`
    INSERT INTO line_staff_recipients (recipient_key, recipient_id)
    VALUES ('staff-group', ${id})
    ON CONFLICT (recipient_key) DO NOTHING
    RETURNING recipient_id
  `;
  if (inserted[0]) return { status: "bound" };
  const existing = await boundGroupId();
  return { status: existing === id ? "already_bound" : "different_group_bound" };
}

async function lineApi(url, payload) {
  const token = configured(process.env.LINE_CHANNEL_ACCESS_TOKEN);
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw Object.assign(new Error(`LINE API returned ${response.status}`), { code: "line_api_failed" });
}

async function replyLine(replyToken, text) {
  if (!replyToken) return;
  await lineApi(LINE_REPLY_ENDPOINT, { replyToken: String(replyToken), messages: [{ type: "text", text: String(text).slice(0, 5000) }] });
}

async function pushLine(groupId, text) {
  await lineApi(LINE_PUSH_ENDPOINT, { to: String(groupId), messages: [{ type: "text", text: String(text).slice(0, 5000) }] });
}

async function pushLineMessage(groupId, message) {
  await lineApi(LINE_PUSH_ENDPOINT, { to: String(groupId), messages: [message] });
}

async function dailyBrief(now = new Date()) {
  const date = taipeiDate(now);
  const rows = await sqlClient()`
    SELECT a.id, a.time, a.customer_name, a.service, a.room, a.is_completed, a.therapist_id,
           coalesce(t.display_name, '') AS therapist_name
    FROM appointments a
    LEFT JOIN therapists t ON t.therapist_id = a.therapist_id
    WHERE a.date = ${date}::date
    ORDER BY a.time, a.id
  `;
  const minute = taipeiMinute(now);
  const active = rows.filter((row) => !row.is_completed);
  const next = active.filter((row) => {
    const match = String(row.time || "").match(/^(\d{1,2}):(\d{2})/);
    return match && Number(match[1]) * 60 + Number(match[2]) >= minute;
  }).slice(0, 3);
  const attention = active.filter((row) => !row.customer_name || !row.therapist_id || !row.time || !row.room);
  const lines = [`☀️ 今日營運重點｜${date}`, `預約 ${rows.length} 筆｜待服務 ${active.length} 筆｜已完成 ${rows.length - active.length} 筆`];
  lines.push("", "接下來行程：");
  if (!next.length) lines.push("• 今日已無待服務預約");
  next.forEach((row) => lines.push(`• ${String(row.time).slice(0, 5)} ${String(row.customer_name || "未填姓名")}｜${String(row.therapist_name || row.therapist_id || "未排師傅")}｜${String(row.service || "未填服務")}｜${String(row.room || "未排房")}`));
  if (attention.length) lines.push("", `⚠️ 待確認 ${attention.length} 筆：缺少必要排程欄位`);
  return lines.join("\n");
}

function appointmentMinute(row) {
  const match = String(row.time || "").match(/^(\d{1,2}):(\d{2})/);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

async function sendDailyBrief(now = new Date()) {
  const groupId = await boundGroupId();
  if (!groupId) return { sent: false, reason: "recipient_not_bound" };
  await pushLine(groupId, await dailyBrief(now));
  return { sent: true };
}

async function sendUpcomingAlerts(now = new Date()) {
  const groupId = await boundGroupId();
  if (!groupId) return { sent: 0, reason: "recipient_not_bound" };
  const date = taipeiDate(now);
  const nowMinute = taipeiMinute(now);
  const lead = Math.max(15, Math.min(180, Number(process.env.LINE_REMINDER_LEAD_MINUTES || 60)));
  const rows = await sqlClient()`
    SELECT a.id, a.date, a.time, a.customer_name, a.service, a.room, a.therapist_id,
           coalesce(t.display_name, '') AS therapist_name
    FROM appointments a LEFT JOIN therapists t ON t.therapist_id = a.therapist_id
    WHERE a.date = ${date}::date AND a.is_completed = false
    ORDER BY a.time, a.id
  `;
  let sent = 0;
  for (const row of rows) {
    const minute = appointmentMinute(row);
    if (minute === null || minute - nowMinute > lead || minute - nowMinute < 0) continue;
    const slot = `${date}T${String(row.time).slice(0, 5)}:00+08:00`;
    const reservation = await sqlClient()`
      INSERT INTO line_staff_alerts (appointment_id, alert_kind, scheduled_at)
      VALUES (${String(row.id)}, 'upcoming', ${slot}::timestamptz)
      ON CONFLICT (appointment_id, alert_kind, scheduled_at) DO NOTHING
      RETURNING appointment_id
    `;
    if (!reservation[0]) continue;
    try {
      await pushLine(groupId, `⏰ 即將開始｜${String(row.time).slice(0, 5)} ${String(row.customer_name || "未填姓名")}｜${String(row.therapist_name || row.therapist_id || "未排師傅")}｜${String(row.service || "未填服務")}｜${String(row.room || "未排房")}`);
      await sqlClient()`UPDATE line_staff_alerts SET sent_at = now() WHERE appointment_id = ${String(row.id)} AND alert_kind = 'upcoming' AND scheduled_at = ${slot}::timestamptz`;
      sent += 1;
    } catch (error) {
      await sqlClient()`DELETE FROM line_staff_alerts WHERE appointment_id = ${String(row.id)} AND alert_kind = 'upcoming' AND scheduled_at = ${slot}::timestamptz AND sent_at IS NULL`;
      throw error;
    }
  }
  return { sent };
}

// A public request is an internal operational event, not a customer broadcast.
// Failure is intentionally non-blocking: the verified pending request remains in
// the admin queue even when LINE has not been configured.
async function sendPublicBookingAlert(selection, options = {}) {
  const groupId = await boundGroupId();
  if (!groupId) return { sent: false, reason: "recipient_not_bound" };
  if (!String(process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim()) return { sent: false, reason: "line_not_configured" };
  const scheduledAt = new Date(selection.createdAt || 0);
  if (!Number.isFinite(scheduledAt.getTime())) throw Object.assign(new Error("invalid_selection_created_at"), { code: "invalid_selection" });
  const reservation = await sqlClient()`
    INSERT INTO line_staff_alerts (appointment_id, alert_kind, scheduled_at)
    VALUES (${String(selection.id)}, 'public_booking_pending', ${scheduledAt.toISOString()}::timestamptz)
    ON CONFLICT (appointment_id, alert_kind, scheduled_at) DO NOTHING
    RETURNING appointment_id
  `;
  if (!reservation[0]) return { sent: false, reason: "duplicate" };
  const opsUrl = new URL(String(options.opsHubUrl || process.env.MORGAN_OPS_HUB_URL || "https://morgan-ops-hub.vercel.app/"));
  opsUrl.searchParams.set("tab", "dispatch");
  opsUrl.searchParams.set("selectionId", String(selection.id));
  opsUrl.searchParams.set("date", String(selection.date || ""));
  const field = (label, value) => ({ type: "box", layout: "baseline", spacing: "sm", contents: [
    { type: "text", text: label, color: "#708090", size: "sm", flex: 2 },
    { type: "text", text: String(value || "—"), wrap: true, color: "#17212b", size: "sm", flex: 5, weight: "bold" }
  ] });
  const message = {
    type: "flex", altText: "新的預約需求待處理",
    contents: { type: "bubble",
      header: { type: "box", layout: "vertical", backgroundColor: "#123B39", paddingAll: "20px", contents: [
        { type: "text", text: "MODERN MORGAN", color: "#CBAF84", size: "xs", weight: "bold" },
        { type: "text", text: "新的預約需求", color: "#FFFFFF", size: "xl", weight: "bold", margin: "md" },
        { type: "text", text: "待確認", color: "#F3D6A3", size: "sm", weight: "bold", margin: "sm" }
      ] },
      body: { type: "box", layout: "vertical", spacing: "md", paddingAll: "20px", contents: [
        field("日期", selection.date), field("時間", String(selection.time || "").slice(0, 5)),
        field("服務", selection.serviceName || selection.service), field("偏好師傅", selection.selectedTherapistName || selection.selectedTherapistId || "未指定"),
        field("顧客", selection.customerName || "未留姓名"), field("聯絡方式", selection.customerContact), field("狀態", "待確認")
      ] },
      footer: { type: "box", layout: "vertical", paddingAll: "16px", contents: [
        { type: "button", style: "primary", color: "#147D73", action: { type: "uri", label: "開啟 Ops Hub 處理", uri: opsUrl.toString() } }
      ] }
    }
  };
  try {
    await pushLineMessage(groupId, message);
    await sqlClient()`UPDATE line_staff_alerts SET sent_at = now() WHERE appointment_id = ${String(selection.id)} AND alert_kind = 'public_booking_pending' AND scheduled_at = ${scheduledAt.toISOString()}::timestamptz`;
    return { sent: true };
  } catch (error) {
    await sqlClient()`DELETE FROM line_staff_alerts WHERE appointment_id = ${String(selection.id)} AND alert_kind = 'public_booking_pending' AND scheduled_at = ${scheduledAt.toISOString()}::timestamptz AND sent_at IS NULL`;
    throw error;
  }
}

function customerMemberUrl() {
  const liffId = String(process.env.LINE_LIFF_ID || "").trim();
  if (liffId) return `https://liff.line.me/${encodeURIComponent(liffId)}`;
  return String(process.env.MORGAN_MEMBER_URL || "https://morgan-ops-hub.vercel.app/member.html");
}

// Customer delivery is an after-commit side effect.  Its ledger is independent
// from staff alerts so a failed Push can be retried on a later state save without
// ever undoing an already confirmed/cancelled booking.
async function sendMemberBookingAlert(selection) {
  const memberId = String(selection?.memberId || "").trim();
  const bookingId = String(selection?.id || "").trim();
  const status = String(selection?.status || "");
  const alertKind = status === "confirmed" ? "booking_confirmed" : (["rejected", "cancelled"].includes(status) ? "booking_cancelled" : "");
  if (!memberId || !bookingId || !alertKind) return { sent: false, reason: "not_applicable" };
  if (!String(process.env.LINE_CHANNEL_ACCESS_TOKEN || "").trim()) return { sent: false, reason: "line_not_configured" };
  if (!String(process.env.LINE_LIFF_ID || "").trim()) return { sent: false, reason: "liff_not_configured" };
  const sql = sqlClient();
  const members = await sql`SELECT line_user_id FROM customer_members WHERE id = ${memberId}::uuid LIMIT 1`;
  if (!members[0]?.line_user_id) return { sent: false, reason: "member_not_found" };
  const reservation = await sql`
    INSERT INTO line_customer_alerts (member_id, booking_id, alert_kind, updated_at)
    VALUES (${memberId}::uuid, ${bookingId}, ${alertKind}, now())
    ON CONFLICT (member_id, booking_id, alert_kind) DO UPDATE SET updated_at = now()
      WHERE line_customer_alerts.sent_at IS NULL
    RETURNING id
  `;
  if (!reservation[0]) return { sent: false, reason: "duplicate" };
  const confirmed = alertKind === "booking_confirmed";
  const message = {
    type: "flex",
    altText: confirmed ? "Morgan 預約已確認" : "Morgan 預約狀態已更新",
    contents: { type: "bubble", body: { type: "box", layout: "vertical", spacing: "md", contents: [
      { type: "text", text: "MODERN MORGAN", size: "xs", color: "#157D75", weight: "bold" },
      { type: "text", text: confirmed ? "預約已確認" : "預約狀態已更新", size: "xl", weight: "bold", wrap: true },
      { type: "text", text: confirmed ? "您的預約已由店家確認安排。" : "您的預約目前無法安排或已取消。", size: "sm", color: "#52606D", wrap: true },
      { type: "separator", margin: "md" },
      { type: "text", text: `${String(selection.date || "")} ${String(selection.time || "").slice(0, 5)}`, size: "sm", weight: "bold" },
      { type: "text", text: String(selection.serviceName || selection.service || "預約服務"), size: "sm", wrap: true },
      { type: "text", text: String(selection.selectedTherapistName || ""), size: "sm", color: "#52606D", wrap: true }
    ] }, footer: { type: "box", layout: "vertical", contents: [
      { type: "button", style: "primary", color: "#157D75", action: { type: "uri", label: "查看預約進度", uri: customerMemberUrl() } }
    ] } }
  };
  try {
    await pushLineMessage(String(members[0].line_user_id), message);
    await sql`UPDATE line_customer_alerts SET sent_at = now(), failed_at = NULL, error_code = '', updated_at = now() WHERE id = ${reservation[0].id}`;
    return { sent: true };
  } catch (error) {
    await sql`UPDATE line_customer_alerts SET failed_at = now(), error_code = ${String(error.code || "line_api_failed").slice(0, 80)}, updated_at = now() WHERE id = ${reservation[0].id}`;
    return { sent: false, reason: String(error.code || "line_api_failed") };
  }
}

module.exports = { bindStaffGroup, replyLine, sendDailyBrief, sendUpcomingAlerts, sendPublicBookingAlert, sendMemberBookingAlert, taipeiDate, taipeiMinute };
