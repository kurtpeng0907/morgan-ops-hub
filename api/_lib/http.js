"use strict";

const crypto = require("node:crypto");

function requestId(req) {
  return String(req.headers?.["x-request-id"] || req.headers?.["x-vercel-id"] || crypto.randomUUID());
}

function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) return JSON.parse(req.body);
  return {};
}

function sendJson(res, status, payload, headers = {}) {
  Object.entries({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  }).forEach(([key, value]) => res.setHeader(key, value));
  return res.status(status).json(payload);
}

function logRequest({ id, route, status, startedAt, upstreamMs = 0, sqlMs = 0, bytes = 0, error = "" }) {
  const event = {
    event: "morgan_api_request",
    requestId: id,
    route,
    status,
    durationMs: Date.now() - startedAt,
    upstreamMs,
    sqlMs,
    responseBytes: bytes,
    deployment: String(process.env.VERCEL_URL || process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 120)
  };
  if (error) event.error = String(error).slice(0, 200);
  console.log(JSON.stringify(event));
}

function methodNotAllowed(res, methods) {
  res.setHeader("Allow", methods.join(", "));
  return sendJson(res, 405, { success: false, error: "method_not_allowed" });
}

function errorPayload(error, requestIdValue, extra = {}) {
  const code = String(error?.code || "internal_error");
  return { success: false, error: code, requestId: requestIdValue, ...extra };
}

module.exports = { requestId, readJson, sendJson, logRequest, methodNotAllowed, errorPayload };
