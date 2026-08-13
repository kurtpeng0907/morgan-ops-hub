"use strict";

const { callAppsScript } = require("./_lib/apps-script");
const { dataSourceMode } = require("./_lib/database");
const { requestId, readJson, sendJson, logRequest, methodNotAllowed, errorPayload } = require("./_lib/http");
const sqlRepository = require("./_lib/sql-repository");
const { sendPublicBookingAlert } = require("./_lib/line-staff-reminders");
const { publicSnapshot, validateSubmission, selectionRecord } = require("./_lib/public-booking");

function existingPublicSelection(data, requestIdValue) {
  const raw = data?.customers?.[`SYS_CLIENT_SELECTION_${String(requestIdValue || "")}`]?.notes;
  try {
    const selection = JSON.parse(raw || "{}");
    return selection.id === String(requestIdValue) && selection.source === "public-booking" && selection.status === "pending" ? selection : null;
  } catch { return null; }
}

async function sourceData(query) {
  if (dataSourceMode() === "sql") return sqlRepository.publicBookingData(query.date);
  // This is a server-to-server read. Apps Script's public clientSelection mode
  // intentionally has a different contract; using the gateway here preserves
  // the full legacy availability inputs without exposing them to the browser.
  const { payload, upstreamMs } = await callAppsScript("fullData", {}, { timeoutMs: 12000 });
  return { data: payload.data || payload, upstreamMs };
}

module.exports = async function handler(req, res) {
  const id = requestId(req); const startedAt = Date.now();
  if (!["GET", "POST"].includes(req.method)) return methodNotAllowed(res, ["GET", "POST"]);
  try {
    const body = req.method === "POST" ? readJson(req) : {};
    const query = req.query || {};
    const input = req.method === "POST" ? body : query;
    const source = await sourceData(input);
    const data = source.data || source;
    if (req.method === "GET") {
      const response = { success: true, data: publicSnapshot(data, input), requestId: id };
      logRequest({ id, route: "/api/public-booking", status: 200, startedAt, upstreamMs: source.upstreamMs || 0, bytes: Buffer.byteLength(JSON.stringify(response)) });
      return sendJson(res, 200, response, { "Cache-Control": "public, max-age=15, stale-while-revalidate=30" });
    }
    // Retry must be resolved before checking live availability: the original
    // pending request intentionally removes its selected therapist from the
    // public candidate list.
    const replay = existingPublicSelection(data, body.requestId);
    if (replay) {
      const response = { success: true, verified: true, selection: { id: replay.id, status: "pending" }, requestId: id, duplicate: true };
      logRequest({ id, route: "/api/public-booking", status: 200, startedAt, upstreamMs: source.upstreamMs || 0, bytes: Buffer.byteLength(JSON.stringify(response)) });
      return sendJson(res, 200, response);
    }
    const selection = validateSubmission(data, body);
    let result;
    if (dataSourceMode() === "sql") {
      result = await sqlRepository.submitPublicBooking(selection);
      try { result.internalReminder = await sendPublicBookingAlert(selection); }
      catch (error) { result.internalReminder = { sent: false, reason: String(error.code || "unavailable").slice(0, 80) }; }
    }
    else {
      const write = await callAppsScript("submitClientSelection", selection, { timeoutMs: 15000, actor: { id: "customer_public", role: "customer_public" }, mutationId: selection.id });
      const verify = await callAppsScript("fullData", {}, { timeoutMs: 12000 });
      const stored = verify.payload?.data?.customers?.[selectionRecord(selection).phone] || verify.payload?.customers?.[selectionRecord(selection).phone];
      if (!stored?.notes || JSON.parse(stored.notes).id !== selection.id) throw Object.assign(new Error("read_back_mismatch"), { code: "read_back_mismatch" });
      result = { verified: write.payload?.verified !== false, selection };
    }
    const response = { success: true, verified: result.verified === true, selection: { id: selection.id, status: "pending" }, requestId: id };
    logRequest({ id, route: "/api/public-booking", status: 201, startedAt, upstreamMs: source.upstreamMs || 0, bytes: Buffer.byteLength(JSON.stringify(response)) });
    return sendJson(res, 201, response);
  } catch (error) {
    const rawCode = String(error.code || "public_booking_unavailable");
    const code = rawCode.includes("booking_conflict") ? "booking_conflict" : rawCode;
    const status = ["validation_error", "booking_conflict"].includes(code) ? (code === "booking_conflict" ? 409 : 400) : 503;
    logRequest({ id, route: "/api/public-booking", status, startedAt, error: code });
    return sendJson(res, status, errorPayload(Object.assign(error, { code }), id, { retryable: status === 503 }));
  }
};
