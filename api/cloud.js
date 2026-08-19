"use strict";

const { callAppsScript } = require("./_lib/apps-script");
const { dataSourceMode } = require("./_lib/database");
const { requestId, readJson, sendJson, logRequest, methodNotAllowed } = require("./_lib/http");
const { verifySession } = require("./_lib/session");
const sqlRepository = require("./_lib/sql-repository");

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

function withDefaultTherapistPin(action, data) {
  const copy = JSON.parse(JSON.stringify(data || {}));
  flattenActions(action, copy).forEach((item) => {
    if (item.action !== "addTherapist") return;
    const itemData = item.data || {};
    if (!String(itemData.pin || "").trim() && !itemData.pinHash) itemData.pin = "0000";
  });
  return copy;
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
    const actionData = withDefaultTherapistPin(action, body.data || {});
    mutationId = String(body.mutationId || "").trim();
    if (!ALLOWED_ACTIONS.has(action)) return sendJson(res, 400, { success: false, error: "unsupported_action", requestId: id });
    if (session.role !== "admin" && !therapistOwnsWrite(session, action, actionData)) {
      return sendJson(res, 403, { success: false, error: "forbidden", requestId: id });
    }
    if (mutationId.length < 6 || mutationId.length > 120) return sendJson(res, 400, { success: false, error: "invalid_mutation_id", requestId: id });
    if (dataSourceMode() === "sql") {
      const sqlStartedAt = Date.now();
      const result = await sqlRepository.applyMutation(session, mutationId, action, actionData);
      const sqlMs = Date.now() - sqlStartedAt;
      const response = { ...result, requestId: id };
      const bytes = Buffer.byteLength(JSON.stringify(response));
      logRequest({ id, route: "/api/cloud", status: 200, startedAt, sqlMs, bytes });
      return sendJson(res, 200, response, { "Server-Timing": `sql;dur=${sqlMs}` });
    }
    const { payload, upstreamMs } = await callAppsScript(action, actionData, {
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
    const status = forbidden ? 403 : (busy ? 409 : 502);
    logRequest({ id, route: "/api/cloud", status, startedAt, error: error.message });
    return sendJson(res, status, { success: false, error: forbidden ? "forbidden" : (busy ? "busy" : "cloud_write_failed"), retryable: busy, mutationId, requestId: id });
  }
};

module.exports.therapistOwnsWrite = therapistOwnsWrite;
module.exports.withDefaultTherapistPin = withDefaultTherapistPin;
