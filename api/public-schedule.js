"use strict";

const { dataSourceMode } = require("./_lib/database");
const { requestId, sendJson, logRequest, methodNotAllowed } = require("./_lib/http");
const sqlRepository = require("./_lib/sql-repository");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const id = requestId(req);
  const startedAt = Date.now();
  if (dataSourceMode() !== "sql") {
    return sendJson(res, 503, { success: false, error: "sql_not_enabled", requestId: id });
  }
  try {
    const sqlStartedAt = Date.now();
    const result = await sqlRepository.publicTherapistSchedule(req.query?.therapistId, req.query?.from, req.query?.to);
    const sqlMs = Date.now() - sqlStartedAt;
    const response = { success: true, ...result, requestId: id };
    logRequest({ id, route: "/api/public-schedule", status: 200, startedAt, sqlMs, bytes: Buffer.byteLength(JSON.stringify(response)) });
    return sendJson(res, 200, response, { "Cache-Control": "no-store", "Server-Timing": `sql;dur=${sqlMs}` });
  } catch (error) {
    const status = error.code === "validation_error" ? 400 : (error.code === "not_found" ? 404 : 502);
    logRequest({ id, route: "/api/public-schedule", status, startedAt, error: error.code || error.message });
    return sendJson(res, status, { success: false, error: error.code === "not_found" ? "therapist_not_found" : (error.code || "public_schedule_unavailable"), requestId: id });
  }
};
