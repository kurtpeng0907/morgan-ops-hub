"use strict";

// One integration function keeps the LINE public webhook and cron endpoints
// addressable without consuming three separate Hobby Function slots.
const routes = Object.freeze({
  webhook: require("./_lib/routes/line-webhook"),
  "line-daily": require("./_lib/routes/line-daily"),
  "line-upcoming": require("./_lib/routes/line-upcoming")
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
