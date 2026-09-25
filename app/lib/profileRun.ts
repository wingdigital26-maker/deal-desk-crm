// Runs scrapers/profile_enrich.py for ONE company. The script does the fetching,
// the match discipline and the sourced writes; this only starts it and reads its
// JSON summary. Python is in the Fly image (deploy/Dockerfile); if it is missing
// the caller gets a plain "not available" result, never a crash.
import { spawn } from "node:child_process";
import path from "node:path";
import { dbPath } from "./db";

export type RefreshResult =
  | { ok: true; writes: Record<string, number>; fields: string[]; pages: number; registry: string | null }
  | { ok: false; error: string; unavailable?: boolean };

const TIMEOUT_MS = 150_000;

export function pythonBin(): string {
  return process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
}

export function runProfileRefresh(companyId: number): Promise<RefreshResult> {
  const script = path.join(process.cwd(), "scrapers", "profile_enrich.py");
  const args = [script, "run", "--db", dbPath(), "--company-id", String(companyId), "--json"];
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const done = (r: RefreshResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(pythonBin(), args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch {
      return done({ ok: false, error: "Profile refresh needs Python on the server", unavailable: true });
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, error: "The refresh took longer than 150 seconds and was stopped" });
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", () => {
      clearTimeout(timer);
      done({ ok: false, error: "Profile refresh needs Python on the server", unavailable: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return done({ ok: false, error: (err.trim().split("\n").pop() || `enrichment exited with code ${code}`).slice(0, 300) });
      try {
        const parsed = JSON.parse(out);
        const rep = parsed.reports?.[0] ?? {};
        if (rep.error) return done({ ok: false, error: String(rep.error).slice(0, 300) });
        done({
          ok: true,
          writes: rep.writes ?? {},
          fields: rep.fields ?? [],
          pages: rep.site?.pages ?? 0,
          registry: rep.registry ?? null,
        });
      } catch {
        done({ ok: false, error: "Could not read the enrichment result" });
      }
    });
  });
}
