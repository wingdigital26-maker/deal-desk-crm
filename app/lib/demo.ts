// Public demo mode (DEAL_DESK_DEMO=1). Used for the hosted, logged-out demo
// link: the app runs on a copy of the fictional seeded workspace, nobody signs
// in, and nothing can leave the building.
//
// What it does, all enforced server side:
//   - db() opens a scratch copy of the bundled demo/demo.db in the OS temp dir
//     (the only writable place on serverless hosts). Visitor edits land there
//     and vanish when the instance recycles.
//   - Sign-in is skipped; every request acts as the demo workspace's owner.
//   - Every send provider is forced to dry run, and every route that would call
//     Apollo, Instantly, spawn Python or change a password is refused (proxy.ts).
import { copyFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export { isDemo, DEMO_REFUSAL, demoBlocks } from "./demo-policy";

/** Path of the writable demo database, copied from the bundled seed on first use. */
export function demoDbPath(): string {
  const target = path.join(os.tmpdir(), "deal-desk-demo.db");
  if (!existsSync(target)) {
    const source = path.join(process.cwd(), "demo", "demo.db");
    if (!existsSync(source)) throw new Error(`Demo database missing at ${source}. Run scripts/build-demo-db.mjs.`);
    copyFileSync(source, target);
  }
  return target;
}
