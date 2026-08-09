"use strict";

const { requestId, sendJson, logRequest, methodNotAllowed } = require("./_lib/http");
const { verifySession } = require("./_lib/session");
const { dataSourceMode } = require("./_lib/database");
const sqlRepository = require("./_lib/sql-repository");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const id = requestId(req);
  const startedAt = Date.now();
  const session = verifySession(req);
  if (!session) return sendJson(res, 401, { success: false, error: "unauthorized", requestId: id });
  if (dataSourceMode() !== "sql") return sendJson(res, 503, { success: false, error: "sql_not_enabled", requestId: id });
  try {
    const sqlStartedAt = Date.now();
    const result = await sqlRepository.listSchedules(session, req.query?.from, req.query?.to);
    const sqlMs = Date.now() - sqlStartedAt;
    const response = { success: true, ...result, requestId: id };
    logRequest({ id, route: "/api/schedules", status: 200, startedAt, sqlMs, bytes: Buffer.byteLength(JSON.stringify(response)) });
    return sendJson(res, 200, response, { "Server-Timing": `sql;dur=${sqlMs}` });
  } catch (error) {
    logRequest({ id, route: "/api/schedules", status: 502, startedAt, error: error.message });
    return sendJson(res, 502, { success: false, error: "schedules_unavailable", requestId: id });
  }
};
