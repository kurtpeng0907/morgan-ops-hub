"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.MORGAN_SESSION_SECRET = "test-session-secret-that-is-at-least-32-characters";
process.env.MORGAN_GATEWAY_SECRET = "test-gateway-secret-at-least-24-chars";
process.env.MORGAN_APPS_SCRIPT_URL = "https://example.test/apps-script";

const sessionHandler = require("../api/session");
const bootstrapHandler = require("../api/bootstrap");
const cloudHandler = require("../api/cloud");
const customerRecordsHandler = require("../api/customer-records");
const { therapistOwnsWrite } = cloudHandler;
const { createSession, verifySession } = require("../api/_lib/session");
const sqlRepository = require("../api/_lib/sql-repository");
const { transform } = require("../scripts/_lib/transform-sheets");
const { projectSelectedDay, digest } = require("../api/_lib/shadow");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

function responseMock() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
}

test("signed sessions preserve leading-zero staff IDs and reject tampering", () => {
  const session = createSession({ id: "002", name: "測試師傅", role: "therapist" });
  const req = { headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` } };
  assert.equal(verifySession(req).sub, "002");
  const tampered = { headers: { cookie: `morgan_session=${encodeURIComponent(session.token + "x")}` } };
  assert.equal(verifySession(tampered), null);
});

test("session endpoint returns identity without returning the PIN", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.data.id, "002");
    assert.equal(request.data.pin, "0007");
    assert.equal(request.gatewayToken, process.env.MORGAN_GATEWAY_SECRET);
    return new Response(JSON.stringify({ success: true, authenticated: true, identity: { id: "002", name: "測試師傅", role: "therapist" } }), { status: 200 });
  };
  try {
    const req = { method: "POST", headers: {}, body: { id: "002", pin: "0007" } };
    const res = responseMock();
    await sessionHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.identity.sub, "002");
    assert.equal(JSON.stringify(res.body).includes("0007"), false);
    assert.match(res.headers["set-cookie"], /HttpOnly/);
    assert.match(res.headers["set-cookie"], /SameSite=Lax/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("bootstrap endpoint requires a valid session", async () => {
  const res = responseMock();
  await bootstrapHandler({ method: "GET", headers: {}, query: {} }, res);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error, "unauthorized");
});

test("bootstrap forwards only signed identity and date", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.data, { id: "admin", role: "admin", date: "2026-08-07" });
    return new Response(JSON.stringify({
      success: true,
      data: { therapists: {}, schedules: {}, appointments: {}, customers: {} },
      meta: { partial: true, cache: "hit" }
    }), { status: 200 });
  };
  try {
    const session = createSession({ id: "admin", name: "管理員", role: "admin" });
    const req = { method: "GET", headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` }, query: { date: "2026-08-07" } };
    const res = responseMock();
    await bootstrapHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.meta.partial, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("therapist sessions cannot call administrative write actions", async () => {
  const session = createSession({ id: "002", name: "測試師傅", role: "therapist" });
  const req = {
    method: "POST",
    headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` },
    body: { action: "deleteTherapist", data: { id: "003" } }
  };
  const res = responseMock();
  await cloudHandler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "forbidden");
});

test("therapist gateway writes are constrained to the signed staff ID", () => {
  const session = { sub: "002", role: "therapist" };
  assert.equal(therapistOwnsWrite(session, "saveSchedule", { id: "002", schedule: {} }), true);
  assert.equal(therapistOwnsWrite(session, "saveSchedule", { id: "003", schedule: {} }), false);
  assert.equal(therapistOwnsWrite(session, "addAppointment", { appId: "A1", therapistId: "003" }), false);
});

test("therapist report batch permits only its own appointment and related records", () => {
  const session = { sub: "002", role: "therapist" };
  const allowed = {
    actions: [
      { action: "saveCustomer", data: { phone: "0912345678", name: "客人" } },
      { action: "addAppointment", data: { appId: "A1", therapistId: "002", phone: "0912345678" } },
      { action: "saveCustomer", data: { phone: "SYS_APPT_META_A1", notes: "{}" } }
    ]
  };
  assert.equal(therapistOwnsWrite(session, "batch", allowed), true);
  allowed.actions[1].data.therapistId = "003";
  assert.equal(therapistOwnsWrite(session, "batch", allowed), false);
});

test("therapist service records must belong to the signed therapist", () => {
  const session = { sub: "002", role: "therapist" };
  assert.equal(therapistOwnsWrite(session, "saveServiceRecord", { record_id: "A1", customer_key_legacy: "0912", therapistId: "002" }), true);
  assert.equal(therapistOwnsWrite(session, "saveServiceRecord", { record_id: "A1", customer_key_legacy: "0912", therapistId: "003" }), false);
});

test("cloud writes forward mutation IDs and return targeted verification", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.equal(request.mutationId, "MUT-001");
    assert.deepEqual(request.actor, { id: "admin", role: "admin" });
    return new Response(JSON.stringify({ success: true, verified: true, mutationId: "MUT-001", changedEntities: [{ action: "saveCustomer", id: "0912" }], cacheVersion: "8" }), { status: 200 });
  };
  try {
    const session = createSession({ id: "admin", name: "管理員", role: "admin" });
    const req = { method: "POST", headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` }, body: { action: "saveCustomer", data: { phone: "0912" }, mutationId: "MUT-001" } };
    const res = responseMock();
    await cloudHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.verified, true);
    assert.equal(res.body.mutationId, "MUT-001");
    assert.equal(res.body.changedEntities.length, 1);
  } finally { global.fetch = originalFetch; }
});

test("customer record pagination requires a signed session and preserves leading-zero identity", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.data, { customerKey: "0912", cursor: 0, limit: 50, id: "002", role: "therapist" });
    return new Response(JSON.stringify({ success: true, records: [{ id: "A1", therapistId: "002" }], nextCursor: null, total: 1 }), { status: 200 });
  };
  try {
    const session = createSession({ id: "002", name: "測試師傅", role: "therapist" });
    const req = { method: "GET", headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` }, query: { customerKey: "0912", cursor: "0", limit: "50" } };
    const res = responseMock();
    await customerRecordsHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.records[0].therapistId, "002");
  } finally { global.fetch = originalFetch; }
});

test("SQL session combines authentication and selected-day bootstrap in one API response", async () => {
  const originalMode = process.env.MORGAN_DATA_SOURCE;
  const originalMethod = sqlRepository.authenticateAndBootstrap;
  process.env.MORGAN_DATA_SOURCE = "sql";
  sqlRepository.authenticateAndBootstrap = async (id, pin, date) => {
    assert.equal(id, "002");
    assert.equal(pin, "0007");
    assert.equal(date, "2026-08-10");
    return {
      authenticated: true,
      identity: { id: "002", name: "測試師傅", role: "therapist" },
      bootstrap: { therapists: { "002": { name: "測試師傅", pin: "" } }, schedules: {}, admins: {}, appointments: {}, customers: {} },
      meta: { source: "neon-postgres", partial: true },
      sqlMs: 12
    };
  };
  try {
    const req = { method: "POST", headers: {}, body: { id: "002", pin: "0007", date: "2026-08-10" } };
    const res = responseMock();
    await sessionHandler(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.identity.sub, "002");
    assert.equal(res.body.bootstrap.therapists["002"].name, "測試師傅");
    assert.equal(res.body.meta.source, "neon-postgres");
    assert.equal(JSON.stringify(res.body).includes("0007"), false);
    assert.match(res.headers["server-timing"], /^sql;dur=/);
  } finally {
    sqlRepository.authenticateAndBootstrap = originalMethod;
    process.env.MORGAN_DATA_SOURCE = originalMode;
  }
});

test("SQL cloud returns the original result for the same mutation ID", async () => {
  const originalMode = process.env.MORGAN_DATA_SOURCE;
  const originalMethod = sqlRepository.applyMutation;
  process.env.MORGAN_DATA_SOURCE = "sql";
  const stored = new Map();
  let writes = 0;
  sqlRepository.applyMutation = async (_identity, mutationId) => {
    if (stored.has(mutationId)) return stored.get(mutationId);
    writes += 1;
    const result = { success: true, verified: true, mutationId, changedEntities: [{ action: "saveCustomer", id: "0912" }], version: "1" };
    stored.set(mutationId, result);
    return result;
  };
  try {
    const session = createSession({ id: "admin", name: "管理員", role: "admin" });
    for (let index = 0; index < 2; index += 1) {
      const req = { method: "POST", headers: { cookie: `morgan_session=${encodeURIComponent(session.token)}` }, body: { action: "saveCustomer", data: { phone: "0912" }, mutationId: "MUT-001" } };
      const res = responseMock();
      await cloudHandler(req, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.verified, true);
    }
    assert.equal(writes, 1);
  } finally {
    sqlRepository.applyMutation = originalMethod;
    process.env.MORGAN_DATA_SOURCE = originalMode;
  }
});

test("migration transform preserves leading-zero IDs and splits a critical-size customer record cell", () => {
  const notes = "x".repeat(49700);
  const source = {
    therapists: { "002": { name: "測試師傅", pin: "0007" } },
    schedules: { "002": { "2026-08-10": "13:00-21:00" } },
    appointments: { "0007": { id: "0007", date: "2026-08-10", time: "13:00", therapistId: "002", phone: "0912", customerName: "客人" } },
    customers: { "0912": { name: "客人", notes: "", records: [{ id: "0007", date: "2026-08-10", therapistId: "002", notes }] } }
  };
  assert.ok(JSON.stringify(source.customers["0912"].records).length > 49700);
  const result = transform(source);
  assert.equal(result.users[0].accountId, "002");
  assert.equal(result.users[0].pin, "0007");
  assert.equal(result.appointments[0].id, "0007");
  assert.equal(result.serviceRecords.length, 1);
  assert.equal(result.serviceRecords[0].notes.length, 49700);
});

test("database migration enforces advisory mutation locking and never defines LINE objects", () => {
  const migration = readFileSync(resolve(__dirname, "../drizzle/0000_morgan_sql.sql"), "utf8");
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /mutation_id text PRIMARY KEY/);
  assert.equal(/LINE_TOKEN|LINE_STAFF_RECIPIENTS|doPostLine|Webhook/i.test(migration), false);
});

test("SQL outage is labeled so the browser does not fall back to Apps Script", async () => {
  const originalMode = process.env.MORGAN_DATA_SOURCE;
  const originalMethod = sqlRepository.authenticateAndBootstrap;
  process.env.MORGAN_DATA_SOURCE = "sql";
  sqlRepository.authenticateAndBootstrap = async () => { throw new Error("connection timeout"); };
  try {
    const res = responseMock();
    await sessionHandler({ method: "POST", headers: {}, body: { id: "002", pin: "0007", date: "2026-08-10" } }, res);
    assert.equal(res.statusCode, 502);
    assert.equal(res.body.dataSource, "sql");
    assert.equal(res.body.error, "authentication_service_unavailable");
  } finally {
    sqlRepository.authenticateAndBootstrap = originalMethod;
    process.env.MORGAN_DATA_SOURCE = originalMode;
  }
});

test("browser enables fast API on Preview and explicitly blocks SQL fallback", () => {
  const source = readFileSync(resolve(__dirname, "../app.js"), "utf8");
  assert.match(source, /FAST_API_ENABLED = URL_OPTIONS\.get\("fastApi"\) === "1" \|\| !LOCAL_TEST_MODE/);
  assert.match(source, /payload\?\.dataSource === "sql"/);
  assert.match(source, /本次不切回舊版資料源/);
});

test("shadow comparison projects legacy 30-day data to the selected-day SQL contract", () => {
  const projected = projectSelectedDay({
    therapists: { "002": { name: "A" }, "003": { name: "B" } },
    schedules: { "002": { "2026-08-10": "13:00-21:00" }, "003": {} },
    admins: {},
    appointments: {
      A1: { id: "A1", date: "2026-08-10", therapistId: "002", phone: "0912" },
      A2: { id: "A2", date: "2026-08-11", therapistId: "002", phone: "0913" }
    },
    customers: {
      "0912": { name: "今天", records: [{ id: "OLD" }] },
      "0913": { name: "明天", records: [] },
      SYS_APPT_META_A1: { notes: "{}", records: [] },
      SYS_APPT_META_A2: { notes: "{}", records: [] },
      SYS_THERAPIST_PROFILE_002: { notes: "{}", records: [] },
      SYS_THERAPIST_PROFILE_003: { notes: "{}", records: [] }
    }
  }, "2026-08-10", { id: "002", role: "therapist" });
  assert.deepEqual(Object.keys(projected.therapists), ["002"]);
  assert.deepEqual(Object.keys(projected.appointments), ["A1"]);
  assert.equal(projected.customers["0912"].records.length, 0);
  assert.ok(projected.customers.SYS_APPT_META_A1);
  assert.equal(projected.customers.SYS_APPT_META_A2, undefined);
  assert.equal(projected.customers.SYS_THERAPIST_PROFILE_003, undefined);
  assert.equal(digest({ b: 1, a: 2 }), digest({ a: 2, b: 1 }));
});
