"use strict";

const { Algorithm, hash, verify } = require("@node-rs/argon2");

const HASH_OPTIONS = Object.freeze({
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32
});

async function hashPin(pin) {
  const value = String(pin || "");
  if (!value || value.length > 80) throw Object.assign(new Error("invalid_pin"), { code: "invalid_pin" });
  return hash(value, HASH_OPTIONS);
}

async function verifyPin(hashValue, pin) {
  if (!hashValue || !pin) return false;
  try { return await verify(String(hashValue), String(pin)); } catch { return false; }
}

module.exports = { hashPin, verifyPin, HASH_OPTIONS };
