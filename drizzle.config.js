"use strict";

const { defineConfig } = require("drizzle-kit");

module.exports = defineConfig({
  dialect: "postgresql",
  schema: "./api/_lib/schema.js",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL || "postgresql://migration-only.invalid/morgan" },
  strict: true,
  verbose: true
});
