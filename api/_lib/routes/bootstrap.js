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
  if (!session) {
    logRequest({ id, route: "/api/bootstrap", status: 401, startedAt });
    return sendJson(res, 401, { success: false, error: "unauthorized", requestId: id });
  }
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query?.date || "")) ? String(req.query.date) : new Date().toISOString().slice(0, 10);
  try {
    if (dataSourceMode() === "sql") {
      const sqlStartedAt = Date.now();
      const result = await sqlRepository.bootstrap(session, date);
      const sqlMs = Date.now() - sqlStartedAt;
      const response = { success: true, data: result.data, meta: result.meta, requestId: id };
      const bytes = Buffer.byteLength(JSON.stringify(response));
      logRequest({ id, route: "/api/bootstrap", status: 200, startedAt, sqlMs, bytes });
      return sendJson(res, 200, response, { "Server-Timing": `sql;dur=${sqlMs}` });
    }
    let upstream;
    try {
      upstream = await callAppsScript("bootstrap", { id: session.sub, role: session.role, date }, { timeoutMs: 4000 });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 800 + Math.floor(Math.random() * 701)));
      upstream = await callAppsScript("bootstrap", { id: session.sub, role: session.role, date }, { timeoutMs: 12000 });
    }
    const { payload, upstreamMs } = upstream;
    const response = { success: true, data: payload.data, meta: payload.meta || {}, requestId: id };
    const bytes = Buffer.byteLength(JSON.stringify(response));
    logRequest({ id, route: "/api/bootstrap", status: 200, startedAt, upstreamMs, bytes });
    return sendJson(res, 200, response, { "Server-Timing": `apps-script;dur=${upstreamMs}` });
  } catch (error) {
    logRequest({ id, route: "/api/bootstrap", status: 502, startedAt, error: error.message });
    return sendJson(res, 502, { success: false, error: "bootstrap_unavailable", requestId: id });
  }
};
