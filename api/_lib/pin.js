"use strict";

const { Algorithm, hash, verify } = require("@node-rs/argon2");

const HASH_OPTIONS = Object.freeze({
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32
});

function normalizePin(pin) {
  const value = String(pin || "").trim();
  // Legacy Sheets writes escaped leading-zero PINs as e.g. '0000.
  // SQL credentials must store/hash the actual PIN, without that escape marker.
  return /^'0\d+$/.test(value) ? value.slice(1) : value;
}

async function hashPin(pin) {
  const value = normalizePin(pin);
  if (!value || value.length > 80) throw Object.assign(new Error("invalid_pin"), { code: "invalid_pin" });
  return hash(value, HASH_OPTIONS);
}

async function verifyPin(hashValue, pin) {
  if (!hashValue || !pin) return false;
  const value = normalizePin(pin);
  try {
    if (await verify(String(hashValue), value)) return true;
    // Backward compatibility for credentials that were previously hashed
    // after the Sheets leading-zero escape had already been added.
    if (/^0\d+$/.test(value)) return await verify(String(hashValue), `'${value}`);
    return false;
  } catch {
    return false;
  }
}

module.exports = { hashPin, verifyPin, normalizePin, HASH_OPTIONS };
