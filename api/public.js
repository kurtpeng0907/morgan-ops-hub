"use strict";

// Single Vercel Function entry point for unauthenticated booking lookups.
const routes = Object.freeze({
  "public-booking": require("./_lib/routes/public-booking"),
  "public-schedule": require("./_lib/routes/public-schedule")
});

async function handler(req, res) {
  const route = routes[String(req.query?.endpoint || "").trim()];
  if (!route) {
    return res.status(404).json({ success: false, error: "not_found" });
  }
  return route(req, res);
}

module.exports = handler;
module.exports.routes = routes;
