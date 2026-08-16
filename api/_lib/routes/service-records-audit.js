"use strict";

const { callAppsScript } = require("../apps-script");
const { requestId, sendJson, logRequest, methodNotAllowed } = require("../http");
const { verifySession } = require("../session");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const id = requestId(req);
  const startedAt = Date.now();
  const session = verifySession(req);
  if (!session) return sendJson(res, 401, { success: false, error: "unauthorized", requestId: id });
  if (session.role !== "admin") return sendJson(res, 403, { success: false, error: "forbidden", requestId: id });
  try {
    const { payload, upstreamMs } = await callAppsScript("serviceRecordsAudit", { id: session.sub, role: session.role }, { timeoutMs: 20000 });
    logRequest({ id, route: "/api/service-records-audit", status: 200, startedAt, upstreamMs, bytes: Buffer.byteLength(JSON.stringify(payload)) });
    return sendJson(res, 200, { ...payload, requestId: id });
  } catch (error) {
    logRequest({ id, route: "/api/service-records-audit", status: 502, startedAt, error: error.message });
    return sendJson(res, 502, { success: false, error: "service_records_audit_unavailable", requestId: id });
  }
};
