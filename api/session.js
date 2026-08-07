"use strict";

const { callAppsScript } = require("./_lib/apps-script");
const { requestId, readJson, sendJson, logRequest, methodNotAllowed } = require("./_lib/http");
const { createSession, sessionCookie } = require("./_lib/session");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const id = requestId(req);
  const startedAt = Date.now();
  try {
    const body = readJson(req);
    const accountId = String(body.id || "").trim();
    const pin = String(body.pin || "").trim();
    if (!accountId || !pin || accountId.length > 80 || pin.length > 80) {
      logRequest({ id, route: "/api/session", status: 400, startedAt });
      return sendJson(res, 400, { success: false, error: "invalid_credentials_input", requestId: id });
    }
    const { payload, upstreamMs } = await callAppsScript("authenticate", { id: accountId, pin }, { timeoutMs: 6000 });
    if (!payload.authenticated || !payload.identity) {
      logRequest({ id, route: "/api/session", status: 401, startedAt, upstreamMs });
      return sendJson(res, 401, { success: false, error: "invalid_credentials", requestId: id });
    }
    const session = createSession(payload.identity);
    const response = { success: true, identity: session.payload, expiresIn: session.payload.exp - session.payload.iat, requestId: id };
    const bytes = Buffer.byteLength(JSON.stringify(response));
    logRequest({ id, route: "/api/session", status: 200, startedAt, upstreamMs, bytes });
    return sendJson(res, 200, response, {
      "Set-Cookie": sessionCookie(session.token, String(req.headers?.["x-forwarded-proto"] || "https") !== "http"),
      "Server-Timing": `apps-script;dur=${upstreamMs}`
    });
  } catch (error) {
    const status = error.code === "unauthorized_gateway" ? 503 : 502;
    logRequest({ id, route: "/api/session", status, startedAt, error: error.message });
    return sendJson(res, status, { success: false, error: "authentication_service_unavailable", requestId: id });
  }
};
