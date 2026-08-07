"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

process.env.MORGAN_SESSION_SECRET ||= "local-session-secret-that-is-at-least-32-characters";
process.env.MORGAN_GATEWAY_SECRET ||= "local-gateway-secret-at-least-24-chars";
process.env.MORGAN_APPS_SCRIPT_URL = "https://mock.local/apps-script";

const nativeFetch = global.fetch;
const today = new Date().toISOString().slice(0, 10);
const mockDb = {
  therapists: {
    "002": { name: "測試師傅", pin: "", pinConfigured: true },
    "003": { name: "另一位師傅", pin: "", pinConfigured: true }
  },
  schedules: {
    "002": { [today]: "13:00-21:00" },
    "003": { [today]: "15:00-23:00" }
  },
  admins: { admin: { name: "測試管理員", pin: "", pinConfigured: true, email: "" } },
  appointments: {
    "APT-MOCK-1": { id: "APT-MOCK-1", date: today, time: "14:00", therapistId: "002", customerName: "測試顧客", phone: "TEST-001", service: "C90", duration: 90, room: "R", price: "2500", collectedPrice: "", isCompleted: false, notes: "", bookingStage: "confirmed", remittanceDue: "", remittancePaid: false, remittanceMethod: "" }
  },
  customers: {
    "TEST-001": { name: "測試顧客", notes: "", records: [] },
    "SYS_DOOR_PWD": { name: "設定", notes: "2580", records: [] },
    "SYS_STORED_VALUE": { name: "儲值卡餘額", notes: "5000", records: [] }
  }
};

global.fetch = async function mockAwareFetch(url, options = {}) {
  if (String(url) !== process.env.MORGAN_APPS_SCRIPT_URL) return nativeFetch(url, options);
  const request = JSON.parse(String(options.body || "{}"));
  if (request.gatewayToken !== process.env.MORGAN_GATEWAY_SECRET) {
    return new Response(JSON.stringify({ success: false, error: "unauthorized_gateway" }), { status: 200 });
  }
  if (request.action === "authenticate") {
    const id = String(request.data?.id || "");
    const pin = String(request.data?.pin || "");
    const admin = id === "admin" && pin === "0000";
    const therapist = id === "002" && pin === "0007";
    return new Response(JSON.stringify({
      success: true,
      authenticated: admin || therapist,
      identity: admin ? { id, name: "測試管理員", role: "admin" } : therapist ? { id, name: "測試師傅", role: "therapist" } : null
    }), { status: 200 });
  }
  if (request.action === "bootstrap") {
    const role = request.data?.role;
    const data = role === "therapist" ? {
      therapists: { "002": mockDb.therapists["002"] }, schedules: { "002": mockDb.schedules["002"] }, admins: {}, appointments: mockDb.appointments, customers: { "TEST-001": mockDb.customers["TEST-001"] }
    } : mockDb;
    return new Response(JSON.stringify({ success: true, data, meta: { partial: true, cache: "hit", generatedAt: new Date().toISOString() } }), { status: 200 });
  }
  if (request.action === "fullData") return new Response(JSON.stringify({ success: true, data: mockDb, meta: { partial: false, generatedAt: new Date().toISOString() } }), { status: 200 });
  if (request.action === "customerRecords") return new Response(JSON.stringify({ success: true, records: mockDb.customers["TEST-001"].records || [], nextCursor: null, total: 0 }), { status: 200 });
  if (request.action === "mutationStatus") return new Response(JSON.stringify({ success: true, found: true, status: "verified", result: { verified: true } }), { status: 200 });
  if (request.action === "serviceRecordsAudit") return new Response(JSON.stringify({ success: true, legacyRecords: 0, modernRecords: 0, mismatchCount: 0 }), { status: 200 });
  return new Response(JSON.stringify({ success: true, verified: true, mutationId: request.mutationId || "", changedEntities: [] }), { status: 200 });
};

const handlers = {
  "/api/session": require("../api/session"),
  "/api/bootstrap": require("../api/bootstrap"),
  "/api/full-data": require("../api/full-data"),
  "/api/cloud": require("../api/cloud"),
  "/api/customer-records": require("../api/customer-records"),
  "/api/mutation-status": require("../api/mutation-status"),
  "/api/service-records-audit": require("../api/service-records-audit"),
  "/api/logout": require("../api/logout"),
  "/api/performance": require("../api/performance")
};

function contentType(file) {
  return ({ ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" })[path.extname(file)] || "application/octet-stream";
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

function responseAdapter(res) {
  return {
    setHeader: (key, value) => res.setHeader(key, value),
    status(code) { res.statusCode = code; return this; },
    json(payload) { res.end(JSON.stringify(payload)); return this; }
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:4174");
  if (handlers[url.pathname]) {
    req.query = Object.fromEntries(url.searchParams.entries());
    req.body = await parseBody(req);
    req.headers["x-forwarded-proto"] = "http";
    return handlers[url.pathname](req, responseAdapter(res));
  }
  const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const file = path.resolve(process.cwd(), relative);
  if (!file.startsWith(process.cwd() + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end("Not found");
  }
  res.setHeader("Content-Type", contentType(file));
  fs.createReadStream(file).pipe(res);
});

server.listen(4174, "127.0.0.1", () => console.log("Mock Morgan server: http://127.0.0.1:4174"));
