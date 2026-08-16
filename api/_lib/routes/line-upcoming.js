"use strict";
const { sendUpcomingAlerts } = require("../line-staff-reminders");
const { requestId, sendJson, logRequest, methodNotAllowed } = require("../http");

function authorized(req) { return String(req.headers?.authorization || "") === `Bearer ${String(process.env.LINE_CRON_SECRET || "")}` && Boolean(process.env.LINE_CRON_SECRET); }
module.exports = async function handler(req, res) {
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST"]);
  const id = requestId(req); const startedAt = Date.now();
  if (!authorized(req)) return sendJson(res, 401, { success: false, error: "unauthorized" });
  try { const result = await sendUpcomingAlerts(); logRequest({ id, route: "/api/cron/line-upcoming", status: 200, startedAt }); return sendJson(res, 200, { success: true, ...result }); }
  catch (error) { logRequest({ id, route: "/api/cron/line-upcoming", status: 502, startedAt, error: error.message }); return sendJson(res, 502, { success: false, error: "line_delivery_failed" }); }
};
