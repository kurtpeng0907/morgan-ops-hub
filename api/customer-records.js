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
  const customerKey = String(req.query?.customerKey || "").trim();
  const cursor = String(req.query?.cursor || "");
  const limit = Math.max(1, Math.min(100, Number(req.query?.limit || 50)));
  try {
    if (dataSourceMode() === "sql") {
      const sqlStartedAt = Date.now();
      const result = await sqlRepository.customerRecords(session, customerKey, cursor, limit);
      const sqlMs = Date.now() - sqlStartedAt;
      const response = { success: true, records: result.records, nextCursor: result.nextCursor, requestId: id };
      logRequest({ id, route: "/api/customer-records", status: 200, startedAt, sqlMs, bytes: Buffer.byteLength(JSON.stringify(response)) });
      return sendJson(res, 200, response, { "Server-Timing": `sql;dur=${sqlMs}` });
    }
    const legacyCursor = Math.max(0, Number(cursor || 0));
    const { payload, upstreamMs } = await callAppsScript("customerRecords", { customerKey, cursor: legacyCursor, limit, id: session.sub, role: session.role }, { timeoutMs: 12000 });
    const response = { success: true, records: payload.records || [], nextCursor: payload.nextCursor ?? null, total: Number(payload.total || 0), requestId: id };
    logRequest({ id, route: "/api/customer-records", status: 200, startedAt, upstreamMs, bytes: Buffer.byteLength(JSON.stringify(response)) });
    return sendJson(res, 200, response, { "Server-Timing": `apps-script;dur=${upstreamMs}` });
  } catch (error) {
    logRequest({ id, route: "/api/customer-records", status: 502, startedAt, error: error.message });
    return sendJson(res, 502, { success: false, error: "customer_records_unavailable", requestId: id });
  }
};
