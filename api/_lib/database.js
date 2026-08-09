"use strict";

let client;

function databaseUrl() {
  const value = String(process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim();
  if (!value) throw Object.assign(new Error("DATABASE_URL is not configured"), { code: "database_not_configured" });
  return value;
}

function sqlClient() {
  if (!client) {
    const { neon } = require("@neondatabase/serverless");
    client = neon(databaseUrl(), { arrayMode: false, fullResults: false });
  }
  return client;
}

function dataSourceMode() {
  const mode = String(process.env.MORGAN_DATA_SOURCE || "apps-script").trim().toLowerCase();
  return ["sql", "shadow", "apps-script"].includes(mode) ? mode : "apps-script";
}

function resetSqlClientForTests() {
  client = undefined;
}

module.exports = { sqlClient, dataSourceMode, resetSqlClientForTests };
