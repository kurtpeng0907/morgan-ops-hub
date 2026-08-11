"use strict";

const crypto = require("node:crypto");
const { bindStaffGroup, replyLine } = require("../_lib/line-staff-reminders");
const { requestId, sendJson, logRequest, methodNotAllowed } = require("../_lib/http");

exports.config = { api: { bodyParser: false } };

function validSignature(rawBody, signature) {
  const secret = String(process.env.LINE_CHANNEL_SECRET || "").trim();
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const actual = Buffer.from(String(signature), "base64");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Object.assign(new Error("payload_too_large"), { code: "payload_too_large" });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  const id = requestId(req);
  const startedAt = Date.now();
  try {
    const rawBody = await readRawBody(req);
    if (!validSignature(rawBody, req.headers?.["x-line-signature"])) {
      logRequest({ id, route: "/api/line/webhook", status: 401, startedAt });
      return sendJson(res, 401, { success: false, error: "invalid_signature" });
    }
    const payload = JSON.parse(rawBody.toString("utf8"));
    if (!Array.isArray(payload.events)) return sendJson(res, 400, { success: false, error: "invalid_event_payload" });
    const expectedCode = String(process.env.LINE_STAFF_LINK_CODE || "").trim();
    for (const event of payload.events) {
      const groupId = String(event?.source?.type === "group" ? event.source.groupId || "" : "").trim();
      const text = String(event?.message?.type === "text" ? event.message.text || "" : "").trim();
      if (!expectedCode || !groupId || text !== expectedCode) continue;
      const result = await bindStaffGroup(groupId);
      if (result.status === "bound" || result.status === "already_bound") await replyLine(event.replyToken, "✅ 已加入 Morgan 小編營運提醒。");
      if (result.status === "different_group_bound") await replyLine(event.replyToken, "⚠️ 此系統已綁定其他小編群組。");
    }
    logRequest({ id, route: "/api/line/webhook", status: 200, startedAt });
    return sendJson(res, 200, { success: true });
  } catch (error) {
    const status = error.code === "payload_too_large" ? 413 : 500;
    logRequest({ id, route: "/api/line/webhook", status, startedAt, error: error.message });
    return sendJson(res, status, { success: false, error: status === 413 ? "payload_too_large" : "webhook_unavailable" });
  }
};

module.exports.validSignature = validSignature;
