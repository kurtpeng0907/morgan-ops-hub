"use strict";

const { Algorithm, hash, verify } = require("@node-rs/argon2");

const HASH_OPTIONS = Object.freeze({
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32
});

// Google Sheets stores leading-zero text with a leading apostrophe. PINs are
// authenticated by SQL rather than Sheets, so keep their numeric text exact
// and only remove that legacy transport marker at the security boundary.
function normalizePin(pin) {
  const value = String(pin ?? "").trim();
  return /^'0\d+$/.test(value) ? value.slice(1) : value;
}

async function hashPin(pin) {
  const value = normalizePin(pin);
  if (!value || value.length > 80) throw Object.assign(new Error("invalid_pin"), { code: "invalid_pin" });
  return hash(value, HASH_OPTIONS);
}

async function verifyPin(hashValue, pin) {
  const value = normalizePin(pin);
  if (!hashValue || !value) return false;
  try { return await verify(String(hashValue), value); } catch { return false; }
}

module.exports = { hashPin, verifyPin, normalizePin, HASH_OPTIONS };
