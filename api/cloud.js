"use strict";

const { callAppsScript } = require("./_lib/apps-script");
const { requestId, readJson, sendJson, logRequest, methodNotAllowed } = require("./_lib/http");
const { verifySession } = require("./_lib/session");

const ALLOWED_ACTIONS = new Set([
  "batch", "saveSchedule", "addTherapist", "updatePin", "deleteTherapist",
  "addAppointment", "deleteAppointment", "saveCustomer", "deleteCustomer",
  "repairTherapists", "sendEmailNotification", "saveAdmin"
]);

const THERAPIST_ACTIONS = new Set(["batch", "saveSchedule", "addAppointment", "saveCustomer"]);
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
  const session = verifySession(req);
  if (!session) return sendJson(res, 401, { success: false, error: "unauthorized", requestId: id });
  try {
    const body = readJson(req);
    const action = String(body.action || "");
    if (!ALLOWED_ACTIONS.has(action)) return sendJson(res, 400, { success: false, error: "unsupported_action", requestId: id });
    if (session.role !== "admin" && !therapistOwnsWrite(session, action, body.data || {})) {
      return sendJson(res, 403, { success: false, error: "forbidden", requestId: id });
    }
    const { payload, upstreamMs } = await callAppsScript(action, body.data || {}, {
      timeoutMs: 45000,
      actor: { id: session.sub, role: session.role }
    });
    const response = { success: true, verified: payload.verified === true, result: payload.result || null, requestId: id };
    const bytes = Buffer.byteLength(JSON.stringify(response));
    logRequest({ id, route: "/api/cloud", status: 200, startedAt, upstreamMs, bytes });
    return sendJson(res, 200, response, { "Server-Timing": `apps-script;dur=${upstreamMs}` });
  } catch (error) {
    logRequest({ id, route: "/api/cloud", status: 502, startedAt, error: error.message });
    return sendJson(res, 502, { success: false, error: "cloud_write_failed", requestId: id });
  }
};

module.exports.therapistOwnsWrite = therapistOwnsWrite;
