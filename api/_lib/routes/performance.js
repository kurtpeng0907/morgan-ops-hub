"use strict";

const { requestId, readJson, sendJson, methodNotAllowed } = require("../http");

const ALLOWED_METRICS = new Set([
  "page_load", "bootstrap_to_data", "login_to_bootstrap", "login_to_first_view",
  "full_data_hydration", "fast_api_unavailable", "login_invalid"
]);

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const body = readJson(req);
  const name = String(body.name || "");
  const value = Number(body.value);
  if (!ALLOWED_METRICS.has(name) || !Number.isFinite(value) || value < 0 || value > 300000) {
    return sendJson(res, 400, { success: false, error: "invalid_metric" });
  }
  console.log(JSON.stringify({
    event: "morgan_client_performance",
    requestId: requestId(req),
    name,
    valueMs: Math.round(value),
    version: String(body.version || "").slice(0, 50),
    path: String(body.path || "").slice(0, 100),
    cache: String(body.cache || "").slice(0, 20)
  }));
  return sendJson(res, 202, { success: true });
};
