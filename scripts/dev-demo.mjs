#!/usr/bin/env node
// Runs the Next dev server against the DEMO workspace (data/demo.db) instead
// of the real database. Seeds the demo db first if it does not exist yet.
//
// Usage: node scripts/dev-demo.mjs

import { spawnSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEMO_DB_PATH = path.join(ROOT, "data", "demo.db");

if (!existsSync(DEMO_DB_PATH)) {
  console.log("data/demo.db not found, seeding it now...");
  const seed = spawnSync(process.execPath, [path.join(__dirname, "seed-demo.mjs")], {
    stdio: "inherit",
    cwd: ROOT,
    env: process.env,
  });
  if (seed.status !== 0) {
    process.exit(seed.status ?? 1);
  }
}

// Run Next's JS entry with this Node binary. Spawning the .cmd shim directly
// throws EINVAL on Windows.
const nextEntry = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

const child = spawn(process.execPath, [nextEntry, "dev", "-p", "4761"], {
  stdio: "inherit",
  cwd: ROOT,
  env: {
    ...process.env,
    HARNESS_DB_PATH: DEMO_DB_PATH,
    HARNESS_DEMO: "1",
    OUTBOUND_SEND_ENABLED: "0",
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 0);
  }
});

process.on("SIGINT", () => {
  child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});
