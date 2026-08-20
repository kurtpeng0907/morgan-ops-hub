"use strict";

const { requestId, readJson, sendJson, logRequest, methodNotAllowed, errorPayload } = require("../http");
const { verifySession } = require("../session");
const { dataSourceMode } = require("../database");
const { memberLinkInfo, searchMembers, linkLegacyCustomer, unlinkLegacyCustomer } = require("../line-members");

module.exports = async function handler(req, res) {
  const id = requestId(req); const startedAt = Date.now();
  const session = verifySession(req);
  if (!session || session.role !== "admin") return sendJson(res, 403, { success: false, error: "forbidden", requestId: id });
  if (dataSourceMode() !== "sql") return sendJson(res, 503, { success: false, error: "member_unavailable", requestId: id });
  try {
    if (req.method === "GET") {
      const customerKey = String(req.query?.customerKey || "").trim();
      const query = String(req.query?.query || "").trim();
      const response = query ? { success: true, members: await searchMembers(query), requestId: id } : { success: true, link: customerKey ? await memberLinkInfo(customerKey) : null, requestId: id };
      return sendJson(res, 200, response);
    }
    if (req.method !== "POST") return methodNotAllowed(res, ["GET", "POST"]);
    const body = readJson(req); const customerKey = String(body.customerKey || "").trim();
    if (!customerKey) throw Object.assign(new Error("customer_key_required"), { code: "validation_error" });
    if (body.action === "link") {
      const link = await linkLegacyCustomer({ actorId: session.sub, memberId: body.memberId, customerKey });
      return sendJson(res, 200, { success: true, link, requestId: id });
    }
    if (body.action === "unlink") { await unlinkLegacyCustomer({ actorId: session.sub, customerKey }); return sendJson(res, 200, { success: true, link: null, requestId: id }); }
    throw Object.assign(new Error("unsupported_action"), { code: "validation_error" });
  } catch (error) {
    const status = error.code === "not_found" ? 404 : (error.code === "validation_error" ? 400 : 502);
    logRequest({ id, route: "/api/member-links", status, startedAt, error: error.code || error.message });
    return sendJson(res, status, errorPayload(error, id));
  }
};
