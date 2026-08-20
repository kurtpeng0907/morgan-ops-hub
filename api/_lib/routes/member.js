"use strict";

const { requestId, readJson, sendJson, logRequest, methodNotAllowed, errorPayload } = require("../http");
const { publicMemberConfig, memberFromIdToken, memberBootstrap, updateMemberProfile } = require("../line-members");

module.exports = async function handler(req, res) {
  const id = requestId(req); const startedAt = Date.now();
  const resource = String(req.query?.resource || "");
  if (req.method === "GET" && resource === "config") {
    try { return sendJson(res, 200, { success: true, ...publicMemberConfig(), requestId: id }); }
    catch (error) { return sendJson(res, 503, errorPayload(error, id)); }
  }
  if (req.method !== "POST" || !["bootstrap", "profile"].includes(resource)) return methodNotAllowed(res, ["GET", "POST"]);
  try {
    const body = readJson(req);
    const member = await memberFromIdToken(body.idToken);
    const result = resource === "bootstrap" ? await memberBootstrap(member, body) : { member: await updateMemberProfile(member, body) };
    const response = { success: true, ...result, requestId: id };
    logRequest({ id, route: `/api/member/${resource}`, status: 200, startedAt, sqlMs: Date.now() - startedAt, bytes: Buffer.byteLength(JSON.stringify(response)) });
    return sendJson(res, 200, response);
  } catch (error) {
    const status = error.code === "unauthorized" ? 401 : (error.code === "validation_error" ? 400 : 503);
    logRequest({ id, route: `/api/member/${resource}`, status, startedAt, error: error.code || error.message });
    return sendJson(res, status, errorPayload(error, id));
  }
};
