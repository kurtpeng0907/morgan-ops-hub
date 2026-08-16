"use strict";

const { callAppsScript } = require("../apps-script");
const { dataSourceMode } = require("../database");
const { requestId, sendJson, logRequest, methodNotAllowed } = require("../http");
const { verifySession } = require("../session");
const sqlRepository = require("../sql-repository");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const id = requestId(req);
  const startedAt = Date.now();
  const session = verifySession(req);
  if (!session) return sendJson(res, 401, { success: false, error: "unauthorized", requestId: id });
  if (session.role !== "admin") return sendJson(res, 403, { success: false, error: "forbidden", requestId: id });
  try {
    if (dataSourceMode() === "sql") {
      const sqlStartedAt = Date.now();
      const result = await sqlRepository.fullData(session);
      const sqlMs = Date.now() - sqlStartedAt;
      const response = { success: true, data: result.data, meta: result.meta, requestId: id };
      const bytes = Buffer.byteLength(JSON.stringify(response));
      logRequest({ id, route: "/api/full-data", status: 200, startedAt, sqlMs, bytes });
      return sendJson(res, 200, response, { "Server-Timing": `sql;dur=${sqlMs}` });
    }
    const { payload, upstreamMs } = await callAppsScript("fullData", { id: session.sub, role: session.role }, { timeoutMs: 20000 });
    const response = { success: true, data: payload.data, meta: payload.meta || {}, requestId: id };
    const bytes = Buffer.byteLength(JSON.stringify(response));
    logRequest({ id, route: "/api/full-data", status: 200, startedAt, upstreamMs, bytes });
    return sendJson(res, 200, response, { "Server-Timing": `apps-script;dur=${upstreamMs}` });
  } catch (error) {
    logRequest({ id, route: "/api/full-data", status: 502, startedAt, error: error.message });
    return sendJson(res, 502, { success: false, error: "full_data_unavailable", requestId: id });
  }
};
