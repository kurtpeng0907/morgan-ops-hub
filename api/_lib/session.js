"use strict";

const crypto = require("node:crypto");

const COOKIE_NAME = "morgan_session";
const SESSION_TTL_SECONDS = 30 * 60;

function sessionSecret() {
  const value = String(process.env.MORGAN_SESSION_SECRET || "");
  if (value.length < 32) throw new Error("MORGAN_SESSION_SECRET is not configured");
  return value;
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

function createSession(identity) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(identity.id || ""),
    name: String(identity.name || ""),
    role: identity.role === "admin" ? "admin" : "therapist",
    iat: now,
    exp: now + SESSION_TTL_SECONDS
  };
  const encoded = base64url(JSON.stringify(payload));
  return { token: `${encoded}.${sign(encoded)}`, payload };
}

function parseCookies(header = "") {
  return String(header).split(";").reduce((result, item) => {
    const index = item.indexOf("=");
    if (index < 0) return result;
    result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
    return result;
  }, {});
}

function verifySession(req) {
  const token = parseCookies(req.headers?.cookie || "")[COOKIE_NAME] || "";
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;
  const expected = sign(encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.sub || !payload.role || Number(payload.exp || 0) <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

function sessionCookie(token, secure = true) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/api; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`;
}

function clearSessionCookie(secure = true) {
  return `${COOKIE_NAME}=; Path=/api; Max-Age=0; HttpOnly;${secure ? " Secure;" : ""} SameSite=Lax`;
}

module.exports = { COOKIE_NAME, SESSION_TTL_SECONDS, createSession, verifySession, sessionCookie, clearSessionCookie };
