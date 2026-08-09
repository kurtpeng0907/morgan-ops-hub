"use strict";

const { createHash } = require("node:crypto");
const { writeFileSync, chmodSync, mkdirSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}

const sourceUrl = String(process.env.MORGAN_APPS_SCRIPT_URL || "").trim();
const output = resolve(arg("--output") || `/tmp/morgan-sheets-snapshot-${Date.now()}.json`);
if (!sourceUrl) throw new Error("MORGAN_APPS_SCRIPT_URL is required");

async function main() {
  const response = await fetch(`${sourceUrl}${sourceUrl.includes("?") ? "&" : "?"}t=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Sheets export failed with HTTP ${response.status}`);
  const text = await response.text();
  JSON.parse(text);
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(output, 0o600);
  const sha256 = createHash("sha256").update(text).digest("hex");
  console.log(JSON.stringify({ success: true, output, bytes: Buffer.byteLength(text), sha256 }));
}

main().catch((error) => {
  console.error(`Snapshot failed: ${String(error.message || error)}`);
  process.exitCode = 1;
});
