#!/usr/bin/env node
// Pulls replies received through Instantly into Deal Desk, the same work as
// the "Check Instantly for replies" button on the Replies page. Meant to run
// later as a hidden scheduled task (see scripts/install-tasks.ps1 for the
// pattern); this script does NOT install one.
//
// Usage (from the repo root): node scripts/poll-instantly-replies.mjs
// Reads .env.local for INSTANTLY_API_KEY / INSTANTLY_CAMPAIGN_ID / HARNESS_DB_PATH.
// Read-only against Instantly. Sends nothing. Exit code 0 on success, 1 on error,
// 2 when Instantly is not configured.
//
// Runs the app's own TypeScript (app/lib/replies/instantly.ts) with Node's
// built-in type stripping (Node 22.18+ / 24). The resolve hook below only
// adds the ".ts" extension the app's extensionless imports leave off.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);
const envFile = path.join(ROOT, ".env.local");
if (existsSync(envFile)) process.loadEnvFile(envFile);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !specifier.endsWith(".ts") && context.parentURL) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate.href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { pollInstantlyReplies } = await import(pathToFileURL(path.join(ROOT, "app", "lib", "replies", "instantly.ts")).href);
const result = await pollInstantlyReplies({});
const stamp = new Date().toISOString();
if (!result.ok) {
  console.error(`[${stamp}] Instantly reply poll failed: ${result.error}`);
  process.exit(result.error === "Instantly is not configured." ? 2 : 1);
}
console.log(
  `[${stamp}] Instantly reply poll: ${result.fetched} checked, ${result.inserted} new, ${result.replies} replies, ` +
    `${result.autoReplies} auto replies, ${result.dealsOpened} deals opened. Cursor ${result.cursor ?? "(none)"}.`
);
