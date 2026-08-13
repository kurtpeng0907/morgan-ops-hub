"use strict";

const { callAppsScript } = require("./_lib/apps-script");
const { dataSourceMode, sqlClient } = require("./_lib/database");
const { requestId, sendJson, logRequest, methodNotAllowed } = require("./_lib/http");
const { verifySession } = require("./_lib/session");

function safeErrorCategory(error) {
  const code = String(error?.code || "").toLowerCase();
  const message = String(error?.message || "").toLowerCase();
  if (code.includes("not_configured") || message.includes("not configured")) return "not_configured";
  if (code.includes("timeout") || message.includes("timeout") || message.includes("abort")) return "timeout";
  if (code.includes("unauthor") || message.includes("unauthor")) return "authorization";
  return "upstream_unavailable";
}

function component(name, status, latencyMs = null, errorCategory = "") {
  return { name, status, latencyMs: Number.isFinite(latencyMs) ? latencyMs : null, errorCategory: errorCategory || null };
}

async function inspectSql() {
  const startedAt = Date.now();
  try { const sql = sqlClient(); await sql`SELECT 1 AS ok`; return component("SQL", "healthy", Date.now() - startedAt); }
  catch (error) { const category = safeErrorCategory(error); return component("SQL", category === "not_configured" ? "not_configured" : "unavailable", Date.now() - startedAt, category); }
}

async function inspectAppsScript(session) {
  const startedAt = Date.now();
  try { await callAppsScript("bootstrap", { id: session.sub, role: session.role, date: new Date().toISOString().slice(0, 10) }, { timeoutMs: 5000 }); return component("Apps Script", "healthy", Date.now() - startedAt); }
  catch (error) { return component("Apps Script", "unavailable", Date.now() - startedAt, safeErrorCategory(error)); }
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const id = requestId(req); const startedAt = Date.now(); const session = verifySession(req);
  if (!session) return sendJson(res, 401, { success: false, error: "unauthorized", requestId: id });
  if (session.role !== "admin") return sendJson(res, 403, { success: false, error: "forbidden", requestId: id });
  const mode = dataSourceMode(); const requested = String(req.query?.check || "") === "1";
  const primary = requested ? (mode === "sql" ? await inspectSql() : await inspectAppsScript(session)) : component(mode === "sql" ? "SQL" : "Apps Script", "not_checked");
  const components = [component("Browser API", "healthy", 0), primary];
  if (mode === "sql") components.push(component("Apps Script", "not_checked"));
  else components.push(component("SQL", "not_configured"));
  components.push(component("LINE／Cron", "not_configured"));
  const response = { success: true, dataSource: mode, status: primary.status, checkedAt: requested ? new Date().toISOString() : null, components, requestId: id };
  const bytes = Buffer.byteLength(JSON.stringify(response));
  logRequest({ id, route: "/api/system-health", status: 200, startedAt, sqlMs: mode === "sql" ? (primary.latencyMs || 0) : 0, upstreamMs: mode === "sql" ? 0 : (primary.latencyMs || 0), bytes });
  return sendJson(res, 200, response);
};

module.exports.safeErrorCategory = safeErrorCategory;
