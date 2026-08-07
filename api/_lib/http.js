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

function logRequest({ id, route, status, startedAt, upstreamMs = 0, bytes = 0, error = "" }) {
  const event = {
    event: "morgan_api_request",
    requestId: id,
    route,
    status,
    durationMs: Date.now() - startedAt,
    upstreamMs,
    responseBytes: bytes
  };
  if (error) event.error = String(error).slice(0, 200);
  console.log(JSON.stringify(event));
}

function methodNotAllowed(res, methods) {
  res.setHeader("Allow", methods.join(", "));
  return sendJson(res, 405, { success: false, error: "method_not_allowed" });
}

module.exports = { requestId, readJson, sendJson, logRequest, methodNotAllowed };
