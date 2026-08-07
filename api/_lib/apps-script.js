"use strict";

const DEFAULT_APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxm7aWFLVk0XeTLV39LnaiTI5Z8c76YNlcPMYWyR17HGaU4QvzHJm32nWeCHsnaknVx/exec";

function appsScriptUrl() {
  return String(process.env.MORGAN_APPS_SCRIPT_URL || DEFAULT_APPS_SCRIPT_URL).trim();
}

function gatewaySecret() {
  const value = String(process.env.MORGAN_GATEWAY_SECRET || "").trim();
  if (value.length < 24) throw new Error("MORGAN_GATEWAY_SECRET is not configured");
  return value;
}

async function callAppsScript(action, data, options = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(options.timeoutMs || 15000));
  try {
    const response = await fetch(appsScriptUrl(), {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify({
        action,
        data,
        gatewayToken: gatewaySecret(),
        actor: options.actor || undefined,
        mutationId: options.mutationId || undefined
      }),
      signal: controller.signal,
      cache: "no-store"
    });
    const text = await response.text();
    let payload;
    try { payload = JSON.parse(text); } catch { throw new Error(`Apps Script returned non-JSON (${response.status})`); }
    if (!response.ok || payload?.success === false) {
      const error = new Error(String(payload?.error || `Apps Script HTTP ${response.status}`));
      error.code = payload?.error || "upstream_error";
      throw error;
    }
    return { payload, upstreamMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { callAppsScript };
