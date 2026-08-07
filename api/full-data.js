"use strict";

const { callAppsScript } = require("./_lib/apps-script");
const { requestId, sendJson, logRequest, methodNotAllowed } = require("./_lib/http");
const { verifySession } = require("./_lib/session");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const id = requestId(req);
  const startedAt = Date.now();
  const session = verifySession(req);
  if (!session) return sendJson(res, 401, { success: false, error: "unauthorized", requestId: id });
  try {
    const { payload, upstreamMs } = await callAppsScript("fullData", { id: session.sub, role: session.role }, { timeoutMs: 45000 });
    const response = { success: true, data: payload.data, meta: payload.meta || {}, requestId: id };
    const bytes = Buffer.byteLength(JSON.stringify(response));
    logRequest({ id, route: "/api/full-data", status: 200, startedAt, upstreamMs, bytes });
    return sendJson(res, 200, response, { "Server-Timing": `apps-script;dur=${upstreamMs}` });
  } catch (error) {
    logRequest({ id, route: "/api/full-data", status: 502, startedAt, error: error.message });
    return sendJson(res, 502, { success: false, error: "full_data_unavailable", requestId: id });
  }
};
