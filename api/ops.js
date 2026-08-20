"use strict";

// Single Vercel Function entry point for authenticated operations routes.
// Public URLs are preserved by the rewrites in vercel.json.
const routes = Object.freeze({
  session: require("./_lib/routes/session"),
  logout: require("./_lib/routes/logout"),
  bootstrap: require("./_lib/routes/bootstrap"),
  "full-data": require("./_lib/routes/full-data"),
  cloud: require("./_lib/routes/cloud"),
  "customer-records": require("./_lib/routes/customer-records"),
  "member-links": require("./_lib/routes/member-links"),
  "mutation-status": require("./_lib/routes/mutation-status"),
  "service-records-audit": require("./_lib/routes/service-records-audit"),
  performance: require("./_lib/routes/performance"),
  "sql-read": require("./_lib/routes/sql-read"),
  "system-health": require("./_lib/routes/system-health")
});

function routeName(req) {
  return String(req.query?.endpoint || "").trim();
}

async function handler(req, res) {
  const route = routes[routeName(req)];
  if (!route) {
    return res.status(404).json({ success: false, error: "not_found" });
  }
  return route(req, res);
}

module.exports = handler;
module.exports.routes = routes;
