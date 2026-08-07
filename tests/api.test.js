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
