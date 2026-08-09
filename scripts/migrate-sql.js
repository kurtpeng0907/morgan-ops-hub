"use strict";

const { readFileSync, readdirSync } = require("node:fs");
const { resolve } = require("node:path");
const { neon } = require("@neondatabase/serverless");

const url = String(process.env.DATABASE_URL || "").trim();
if (!url) throw new Error("DATABASE_URL is required");

async function main() {
  const sql = neon(url);
  await sql`CREATE TABLE IF NOT EXISTS drizzle_migrations_local (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;
  const files = readdirSync(resolve("drizzle")).filter((name) => name.endsWith(".sql")).sort();
  for (const filename of files) {
    const found = await sql`SELECT 1 FROM drizzle_migrations_local WHERE filename = ${filename}`;
    if (found.length) continue;
    const migration = readFileSync(resolve("drizzle", filename), "utf8");
    await sql.transaction([
      sql.query(migration),
      sql`INSERT INTO drizzle_migrations_local(filename) VALUES (${filename})`
    ]);
    console.log(`Applied ${filename}`);
  }
}

main().catch((error) => {
  console.error(`Migration failed: ${String(error.message || error)}`);
  process.exitCode = 1;
});
