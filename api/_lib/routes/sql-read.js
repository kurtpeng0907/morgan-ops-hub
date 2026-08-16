"use strict";

const { requestId, sendJson, logRequest, methodNotAllowed } = require("../http");
const { verifySession } = require("../session");
const { dataSourceMode } = require("../database");
const sqlRepository = require("../sql-repository");

const ROUTES = {
  appointments: {
    load: (session, query) => sqlRepository.listAppointments(session, query.from, query.to, query.cursor, query.limit),
    error: "appointments_unavailable"
  },
  customers: {
    load: (session, query) => sqlRepository.listCustomers(session, query.cursor, query.limit, query.query),
    error: "customers_unavailable"
  },
  schedules: {
    load: (session, query) => sqlRepository.listSchedules(session, query.from, query.to),
    error: "schedules_unavailable"
  },
  reports: {
    load: (session, query) => sqlRepository.report(session, query.from, query.to),
    error: "reports_unavailable"
  }
};

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return methodNotAllowed(res, ["GET"]);
  const id = requestId(req);
  const startedAt = Date.now();
  const session = verifySession(req);
  if (!session) return sendJson(res, 401, { success: false, error: "unauthorized", requestId: id });
  if (dataSourceMode() !== "sql") return sendJson(res, 503, { success: false, error: "sql_not_enabled", requestId: id });
  const routeName = String(req.query?.route || "");
  const route = ROUTES[routeName];
  if (!route) return sendJson(res, 404, { success: false, error: "not_found", requestId: id });
  try {
    const sqlStartedAt = Date.now();
    const result = await route.load(session, req.query || {});
    const sqlMs = Date.now() - sqlStartedAt;
    const response = { success: true, ...result, requestId: id };
    logRequest({ id, route: `/api/${routeName}`, status: 200, startedAt, sqlMs, bytes: Buffer.byteLength(JSON.stringify(response)) });
    return sendJson(res, 200, response, { "Server-Timing": `sql;dur=${sqlMs}` });
  } catch (error) {
    logRequest({ id, route: `/api/${routeName}`, status: 502, startedAt, error: error.message });
    return sendJson(res, 502, { success: false, error: route.error, requestId: id });
  }
};
