// Read-only summary of the weekly sourcing pipeline (scrapers/pipeline.py) for
// the top of the Sourcing page. The pipeline is the only writer; nothing here
// changes state.
import { db } from "./db";

export type SourcingRun = {
  id: number;
  started_at: string;
  finished_at: string | null;
  checked: number;
  sites_found: number;
  sites_unconfirmed: number;
  fits: number;
  owners_found: number;
  signals_new: number;
  errors: number;
  requests: number;
  runtime_seconds: number | null;
  interrupted: boolean;
};

export type SourcingTotals = {
  companies: number;
  checked: number;
  withSite: number;
  unconfirmedSite: number;
  goodFits: number;
  ownersFound: number;
};

export const GOOD_FIT = 60;

export function lastSourcingRun(): SourcingRun | null {
  const row = db()
    .prepare(
      `SELECT id, started_at, finished_at, checked, sites_found, sites_unconfirmed, fits, owners_found,
              signals_new, errors, requests, notes
       FROM sourcing_runs ORDER BY id DESC LIMIT 1`
    )
    .get() as (Omit<SourcingRun, "runtime_seconds" | "interrupted"> & { notes: string | null }) | undefined;
  if (!row) return null;
  let notes: { runtime_seconds?: number; interrupted?: boolean } = {};
  try {
    notes = row.notes ? JSON.parse(row.notes) : {};
  } catch {
    notes = {};
  }
  const { notes: _omit, ...rest } = row;
  void _omit;
  return {
    ...rest,
    runtime_seconds: typeof notes.runtime_seconds === "number" ? notes.runtime_seconds : null,
    interrupted: notes.interrupted === true,
  };
}

export function sourcingTotals(): SourcingTotals {
  const c = db()
    .prepare(
      `SELECT COUNT(*) AS companies,
              SUM(CASE WHEN website_checked_at IS NOT NULL THEN 1 ELSE 0 END) AS checked,
              SUM(CASE WHEN domain IS NOT NULL AND domain <> '' THEN 1 ELSE 0 END) AS withSite,
              SUM(CASE WHEN fit_score >= ? THEN 1 ELSE 0 END) AS goodFits
       FROM companies`
    )
    .get(GOOD_FIT) as { companies: number; checked: number | null; withSite: number | null; goodFits: number | null };
  const unconfirmed = db()
    .prepare(
      `SELECT COUNT(DISTINCT f.entity_id) AS n FROM profile_facts f
       JOIN companies c ON c.id = f.entity_id
       WHERE f.entity = 'company' AND f.field = 'website' AND f.confidence = 'unconfirmed'
         AND (c.domain IS NULL OR c.domain = '')`
    )
    .get() as { n: number };
  // An owner is found when a confirmed source names one: the state report
  // (contacts from the Comptroller) or an owner fact read off the company's own site.
  const owners = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT entity_id AS company_id FROM profile_facts
           WHERE entity = 'company' AND field = 'owner_name' AND confidence = 'confirmed'
         UNION
         SELECT company_id FROM contacts WHERE source = 'tx-comptroller-pir' AND company_id IS NOT NULL
       )`
    )
    .get() as { n: number };
  return {
    companies: c.companies,
    checked: c.checked ?? 0,
    withSite: c.withSite ?? 0,
    unconfirmedSite: unconfirmed.n,
    goodFits: c.goodFits ?? 0,
    ownersFound: owners.n,
  };
}
