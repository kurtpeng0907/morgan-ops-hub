"use strict";

const { sendJson, methodNotAllowed } = require("../http");
const { clearSessionCookie } = require("../session");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return methodNotAllowed(res, ["POST"]);
  return sendJson(res, 200, { success: true }, { "Set-Cookie": clearSessionCookie(String(req.headers?.["x-forwarded-proto"] || "https") !== "http") });
};
