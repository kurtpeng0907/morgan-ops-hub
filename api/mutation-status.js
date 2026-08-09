"use strict";

const { callAppsScript } = require("./_lib/apps-script");
const { dataSourceMode } = require("./_lib/database");
const { requestId, sendJson, logRequest, methodNotAllowed } = require("./_lib/http");
const { verifySession } = require("./_lib/session");
const sqlRepository = require("./_lib/sql-repository");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const id = requestId(req);
  const startedAt = Date.now();
  const session = verifySession(req);
  if (!session) return sendJson(res, 401, { success: false, error: "unauthorized", requestId: id });
  const mutationId = String(req.query?.mutationId || "").trim();
  if (!mutationId) return sendJson(res, 400, { success: false, error: "missing_mutation_id", requestId: id });
  try {
    if (dataSourceMode() === "sql") {
      const sqlStartedAt = Date.now();
      const result = await sqlRepository.mutationStatus(session, mutationId);
      const sqlMs = Date.now() - sqlStartedAt;
      const response = { success: true, ...result, mutationId, requestId: id };
      logRequest({ id, route: "/api/mutation-status", status: 200, startedAt, sqlMs, bytes: Buffer.byteLength(JSON.stringify(response)) });
      return sendJson(res, 200, response, { "Server-Timing": `sql;dur=${sqlMs}` });
    }
    const { payload, upstreamMs } = await callAppsScript("mutationStatus", { mutationId, id: session.sub, role: session.role }, { timeoutMs: 6000 });
    const response = { success: true, found: payload.found === true, status: payload.status || null, result: payload.result || null, mutationId, requestId: id };
    logRequest({ id, route: "/api/mutation-status", status: 200, startedAt, upstreamMs, bytes: Buffer.byteLength(JSON.stringify(response)) });
    return sendJson(res, 200, response);
  } catch (error) {
    logRequest({ id, route: "/api/mutation-status", status: 502, startedAt, error: error.message });
    return sendJson(res, 502, { success: false, error: "mutation_status_unavailable", mutationId, requestId: id });
  }
};
