"use strict";

// The shared same-origin transport deliberately knows nothing about Morgan
// records. Endpoint-specific code stays in app.js; timeout/cancellation and
// JSON parsing live in one place.
(function exposeMorganAppApi(root) {
  async function fetchJson(url, options = {}, timeoutMs = 6000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        cache: "no-store",
        ...options,
        signal: controller.signal
      });
      let payload = null;
      try { payload = await response.json(); } catch {}
      return { response, payload };
    } finally {
      clearTimeout(timeout);
    }
  }

  const api = { fetchJson };
  root.MorganAppApi = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
}(typeof window !== "undefined" ? window : globalThis));
