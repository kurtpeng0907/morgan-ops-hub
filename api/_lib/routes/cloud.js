"use strict";

const { callAppsScript } = require("../apps-script");
const { dataSourceMode } = require("../database");
const { requestId, readJson, sendJson, logRequest, methodNotAllowed, errorPayload } = require("../http");
const { verifySession } = require("../session");
const sqlRepository = require("../sql-repository");
const { assertActionAllowed } = require("../policy");
const { assertBookingTransition } = require("../domain-contracts");
const { sendMemberBookingAlert } = require("../line-staff-reminders");

const ALLOWED_ACTIONS = new Set([
  "batch", "saveSchedule", "addTherapist", "updatePin", "deleteTherapist",
  "addAppointment", "deleteAppointment", "saveCustomer", "deleteCustomer",
  "repairTherapists", "sendEmailNotification", "saveAdmin", "saveServiceRecord", "backfillServiceRecords"
]);

const THERAPIST_ACTIONS = new Set(["batch", "saveSchedule", "addAppointment", "saveCustomer", "saveServiceRecord"]);
const APPROVAL_PREFIX = "SYS_APPROVAL_";
const APPOINTMENT_META_PREFIX = "SYS_APPT_META_";

function flattenActions(action, data) {
  if (action !== "batch") return [{ action, data: data || {} }];
  const nested = Array.isArray(data?.actions) ? data.actions : [];
  return nested.flatMap((item) => flattenActions(String(item?.action || ""), item?.data || {}));
}

function therapistOwnsWrite(session, action, data) {
  const actorId = String(session.sub);
  const actions = flattenActions(action, data);
  if (!actions.length || actions.some((item) => !THERAPIST_ACTIONS.has(item.action) || item.action === "batch")) return false;
  const ownAppointments = actions
    .filter((item) => item.action === "addAppointment" && String(item.data?.therapistId || "") === actorId)
    .map((item) => item.data || {});
  return actions.every((item) => {
    const itemData = item.data || {};
    if (item.action === "saveSchedule") return String(itemData.id || "") === actorId;
    if (item.action === "addAppointment") return String(itemData.therapistId || "") === actorId;
    if (item.action === "saveServiceRecord") return String(itemData.therapistId || itemData.therapist_id || "") === actorId;
    if (item.action !== "saveCustomer") return false;
    const key = String(itemData.phone || "");
    if (key.startsWith(APPROVAL_PREFIX)) {
      try { return String(JSON.parse(String(itemData.notes || "{}")).therapistId || "") === actorId; } catch { return false; }
    }
    if (key.startsWith(APPOINTMENT_META_PREFIX)) {
      const appointmentId = key.slice(APPOINTMENT_META_PREFIX.length);
      return ownAppointments.some((appt) => String(appt.appId || appt.id || "") === appointmentId);
    }
    return ownAppointments.some((appt) => String(appt.phone || "") === key);
  });
}

function validateBookingCommands(session, action, data) {
  const items = action === "batch" ? (Array.isArray(data?.actions) ? data.actions : []) : [{ action, data }];
  for (const item of items) {
    if (String(item?.action || "") !== "addAppointment") continue;
    const itemData = item.data || {};
    const expected = String(itemData.expectedBookingStage || "").trim();
    const next = String(itemData.bookingStage || "").trim();
    const override = String(itemData.allowStageOverride || "") === "true";
    if (override) {
      if (session.role !== "admin") {
        const error = new Error("booking_override_forbidden");
        error.code = "forbidden";
        throw error;
      }
      if (String(itemData.stageOverrideReason || "").trim().length < 5) {
        const error = new Error("booking_override_reason_required");
        error.code = "invalid_booking_override";
        throw error;
      }
      continue;
    }
    // Existing legacy callers may omit the optimistic concurrency field. New UI writes it.
    if (!expected || !next || expected === next) continue;
    assertBookingTransition({ from: expected, to: next, role: session.role });
  }
}

function memberSelectionsFromMutation(action, data) {
  return flattenActions(action, data).flatMap((item) => {
    if (item.action !== "saveCustomer" || !String(item.data?.phone || "").startsWith("SYS_CLIENT_SELECTION_")) return [];
    try {
      const selection = JSON.parse(String(item.data?.notes || "{}"));
      return selection?.memberId && selection?.id ? [selection] : [];
    } catch { return []; }
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const id = requestId(req);
  const startedAt = Date.now();
  let mutationId = "";
  const session = verifySession(req);
  if (!session) return sendJson(res, 401, { success: false, error: "unauthorized", requestId: id });
  try {
    const body = readJson(req);
    const action = String(body.action || "");
    mutationId = String(body.mutationId || "").trim();
    if (!ALLOWED_ACTIONS.has(action)) return sendJson(res, 400, errorPayload(Object.assign(new Error("unsupported_action"), { code: "unsupported_action" }), id));
    assertActionAllowed(session.role, action);
    validateBookingCommands(session, action, body.data || {});
    if (session.role !== "admin" && !therapistOwnsWrite(session, action, body.data || {})) {
      return sendJson(res, 403, { success: false, error: "forbidden", requestId: id });
    }
    if (mutationId.length < 6 || mutationId.length > 120) return sendJson(res, 400, errorPayload(Object.assign(new Error("invalid_mutation_id"), { code: "invalid_mutation_id" }), id));
    if (dataSourceMode() === "sql") {
      const sqlStartedAt = Date.now();
      const result = await sqlRepository.applyMutation(session, mutationId, action, body.data || {});
      // Never permit a customer Push failure to change the mutation response or
      // rollback the confirmed selection.  The notification module owns its
      // own idempotency/failure ledger.
      const selections = memberSelectionsFromMutation(action, body.data || {});
      for (const selection of selections) {
        try { await sendMemberBookingAlert(selection); } catch {}
      }
      const sqlMs = Date.now() - sqlStartedAt;
      const response = { ...result, requestId: id };
      const bytes = Buffer.byteLength(JSON.stringify(response));
      logRequest({ id, route: "/api/cloud", status: 200, startedAt, sqlMs, bytes });
      return sendJson(res, 200, response, { "Server-Timing": `sql;dur=${sqlMs}` });
    }
    const { payload, upstreamMs } = await callAppsScript(action, body.data || {}, {
      timeoutMs: 15000,
      actor: { id: session.sub, role: session.role },
      mutationId
    });
    const response = { success: true, verified: payload.verified === true, mutationId: payload.mutationId || mutationId, changedEntities: payload.changedEntities || [], cacheVersion: payload.cacheVersion || null, result: payload.result || null, requestId: id };
    const bytes = Buffer.byteLength(JSON.stringify(response));
    logRequest({ id, route: "/api/cloud", status: 200, startedAt, upstreamMs, bytes });
    return sendJson(res, 200, response, { "Server-Timing": `apps-script;dur=${upstreamMs}` });
  } catch (error) {
    const busy = error.code === "busy" || /busy|資料庫忙碌/.test(error.message);
    const forbidden = error.code === "forbidden" || /forbidden/.test(error.message);
    const conflict = error.code === "booking_conflict" || /booking_conflict/.test(error.message);
    const invalidTransition = error.code === "invalid_booking_transition" || /invalid_booking_transition/.test(error.message);
    const invalidOverride = error.code === "invalid_booking_override" || /booking_override_reason_required/.test(error.message);
    const status = forbidden ? 403 : (invalidTransition || invalidOverride ? 400 : (conflict || busy ? 409 : 502));
    logRequest({ id, route: "/api/cloud", status, startedAt, error: error.message });
    const normalizedError = conflict ? Object.assign(error, { code: "booking_conflict" })
      : (invalidTransition ? Object.assign(error, { code: "invalid_booking_transition" })
        : (invalidOverride ? Object.assign(error, { code: "invalid_booking_override" }) : error));
    return sendJson(res, status, errorPayload(normalizedError, id, { retryable: busy || conflict, mutationId }));
  }
};

module.exports.therapistOwnsWrite = therapistOwnsWrite;
module.exports.validateBookingCommands = validateBookingCommands;
module.exports.memberSelectionsFromMutation = memberSelectionsFromMutation;
