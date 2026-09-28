// Sourcing v2: the read-only run summary on the Sourcing page, and the Python
// pipeline's own offline unit tests (name -> domain, identity match, fit score,
// owners, signals, database writes) run through the same test command.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { freshApp, cleanup, type App } from "./_harness";

let app: App;
beforeAll(async () => {
  app = await freshApp();
});
afterAll(() => cleanup());

describe("sourcing run summary", () => {
  it("is empty (null run, zero totals) before the pipeline has ever run", async () => {
    const { lastSourcingRun, sourcingTotals } = await import("../app/lib/sourcing-runs");
    expect(lastSourcingRun()).toBeNull();
    const t = sourcingTotals();
    expect(t.withSite).toBe(0);
    expect(t.goodFits).toBe(0);
    expect(t.ownersFound).toBe(0);
  });

  it("reads the latest run and counts sites, good fits and owners across the desk", async () => {
    const { lastSourcingRun, sourcingTotals } = await import("../app/lib/sourcing-runs");
    const d = app.db;
    d.prepare(
      "INSERT INTO sourcing_runs (started_at, finished_at, checked, sites_found, sites_unconfirmed, fits, owners_found, signals_new, errors, requests, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run("2026-09-01 06:00:00", "2026-09-01 06:30:00", 10, 1, 0, 0, 0, 0, 0, 50, "{}");
    d.prepare(
      "INSERT INTO sourcing_runs (started_at, finished_at, checked, sites_found, sites_unconfirmed, fits, owners_found, signals_new, errors, requests, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)"
    ).run("2026-09-08 06:00:00", "2026-09-08 06:40:00", 200, 30, 12, 9, 7, 4, 1, 3000, JSON.stringify({ runtime_seconds: 2400 }));
    const a = app.company("Site Co", { domain: "siteco.example", fit_score: 72, website_checked_at: "2026-09-08 06:10:00" });
    app.company("No Site Co", { fit_score: 20, website_checked_at: "2026-09-08 06:11:00" });
    const u = app.company("Maybe Co", { fit_score: 30 });
    app.company("Never Checked Co");
    const fact = d.prepare(
      "INSERT INTO profile_facts (entity, entity_id, field, value, value_key, source_url, confidence, fetched_at) VALUES ('company', ?, ?, ?, ?, ?, ?, datetime('now'))"
    );
    fact.run(a, "owner_name", "Dale Hollis", "", "https://siteco.example/about", "confirmed");
    fact.run(u, "website", "https://maybeco.example", "", "https://maybeco.example/", "unconfirmed");
    fact.run(u, "owner_name", "Not Counted", "", "https://maybeco.example/", "unconfirmed");

    const run = lastSourcingRun();
    expect(run?.checked).toBe(200);
    expect(run?.sites_found).toBe(30);
    expect(run?.runtime_seconds).toBe(2400);
    expect(run?.interrupted).toBe(false);

    const t = sourcingTotals();
    expect(t.companies).toBe(4);
    expect(t.checked).toBe(2);
    expect(t.withSite).toBe(1);
    expect(t.unconfirmedSite).toBe(1);
    expect(t.goodFits).toBe(1);
    expect(t.ownersFound).toBe(1);
  });
});

describe("python sourcing pipeline (offline unit tests)", () => {
  it("passes scrapers/tests (unittest, no network)", () => {
    const PY = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
    const r = spawnSync(PY, ["-m", "unittest", "discover", "-s", path.join("scrapers", "tests")], {
      cwd: process.cwd(),
      encoding: "utf-8",
    });
    expect(r.stderr).toMatch(/OK/);
    expect(r.status).toBe(0);
  }, 60_000);
});
