#!/usr/bin/env python3
"""
pipeline.py - the weekly sourcing run, one command.

  python scrapers/pipeline.py run --db data/harness.db --limit 200 [--sample-ids ids.txt] [--log run.jsonl]

For up to --limit companies not checked in the last 30 days (registry companies
that were never checked go first), in this order, one company at a time:

  1. website   find_websites.py: candidate domains from the legal name, DNS,
               homepage identity proof. Confirmed -> companies.domain.
               A company that already has a domain on file just has its site read.
  2. fit       fit_score.py: industry, exclusions, size clues, ownership
               language -> companies.fit_score + profile_facts 'fit_reasons'.
  3. owners    tx_officers.py: the Comptroller Public Data API when
               TX_COMPTROLLER_API_KEY is set, otherwise owner-level people
               printed on the company's own confirmed site. Stored as contacts
               with no email. Then the domain's MX record (DNS only, never SMTP)
               and the existing email_finder MX verifier for contacts that
               already have an address.
  4. signals   sourcing_signals.py: officer-change, owner-news,
               business-journal / news.

Network work for several companies runs at once (--workers, default 4); the
per-host throttle is shared, so no host ever sees more than 1 request per
second. All database writes happen on the main thread.

Each company is one transaction: a crash or Ctrl+C loses at most the company in
flight, and the next run carries on where this one stopped (resumable). Every
run writes one sourcing_runs row and one audit_log row.

House rules (same as every scraper here): public sources only, no logins, no
paid APIs, no LLM calls, 1 request per second per host, 10 second timeout,
back off on 429, robots.txt obeyed for every site crawled, fail soft, never
invent data, every stored fact carries its source URL.
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import find_websites as fw  # noqa: E402  (installs the counted, deadline-capped fetcher first)
import profile_enrich as pe  # noqa: E402
import fit_score as fs  # noqa: E402
import tx_officers as tx  # noqa: E402
import sourcing_signals as ss  # noqa: E402
import email_finder as ef  # noqa: E402

pe.MULTI_FIELDS.add("fit_reasons")
REGISTRY_URL = "https://data.texas.gov/resource/9cir-efmm.json"
RECHECK_DAYS = 30
HALF_LIFE_DAYS = 45

# Identical DDL lives in app/lib/db.ts (block "SOURCING V2"); this copy lets the
# pipeline run against a database the app has not opened since the change.
SCHEMA = """
CREATE TABLE IF NOT EXISTS sourcing_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  checked INTEGER NOT NULL DEFAULT 0,
  sites_found INTEGER NOT NULL DEFAULT 0,
  sites_unconfirmed INTEGER NOT NULL DEFAULT 0,
  fits INTEGER NOT NULL DEFAULT 0,
  owners_found INTEGER NOT NULL DEFAULT 0,
  signals_new INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  requests INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS officer_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  names_json TEXT NOT NULL,
  source_url TEXT NOT NULL,
  taken_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS officer_snapshots_company ON officer_snapshots(company_id, source, id);
"""
COLUMNS = [("companies", "fit_score", "INTEGER"), ("companies", "fit_checked_at", "TEXT"),
           ("companies", "website_checked_at", "TEXT")]


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def ensure_schema(con: sqlite3.Connection) -> None:
    pe.ensure_schema(con)
    con.executescript(SCHEMA)
    for table, col, ddl in COLUMNS:
        if col not in {r[1] for r in con.execute(f"PRAGMA table_info({table})")}:
            con.execute(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
    con.commit()


def select_companies(con: sqlite3.Connection, limit: int, sample_ids: list[int] | None) -> list[dict]:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=RECHECK_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
    due = "(website_checked_at IS NULL OR website_checked_at < ?)"
    cols = "id, name, domain, city, state, source, notes"
    if sample_ids:
        rows = con.execute(f"SELECT {cols} FROM companies WHERE {due} AND id IN (SELECT value FROM json_each(?))",
                           (cutoff, json.dumps(sample_ids))).fetchall()
        order = {cid: i for i, cid in enumerate(sample_ids)}
        rows = sorted(rows, key=lambda r: order.get(r["id"], 10 ** 9))
        return [dict(r) for r in rows[:limit]]
    rows = con.execute(
        f"""SELECT {cols} FROM companies WHERE {due}
            ORDER BY (source = 'tx-franchise-registry' AND website_checked_at IS NULL) DESC,
                     website_checked_at IS NOT NULL, website_checked_at, id
            LIMIT ?""", (cutoff, limit)).fetchall()
    return [dict(r) for r in rows]


def registry_url(notes: dict) -> str:
    tp = notes.get("taxpayer_number")
    return REGISTRY_URL + (f"?taxpayer_number={tp}" if tp else "")


def rescore_signals(con: sqlite3.Connection, company_id: int) -> None:
    """Same formula as harness_signals.py score: sum(weight x 45-day half-life decay)."""
    today = datetime.now(timezone.utc).date()
    score = 0.0
    for w, obs, created in con.execute("SELECT weight, observed_at, created_at FROM signals WHERE company_id=?", (company_id,)):
        try:
            d = datetime.strptime((obs or created or "")[:10], "%Y-%m-%d").date()
            age = max((today - d).days, 0)
        except Exception:
            age = 0
        score += (w or 1.0) * 0.5 ** (age / HALF_LIFE_DAYS)
    con.execute("UPDATE companies SET signal_score=?, updated_at=datetime('now') WHERE id=?", (round(score, 4), company_id))


# ---------------------------------------------------------------------------
# One company
# ---------------------------------------------------------------------------

def gather(company: dict, news_all: bool = False) -> dict:
    """Every network step for one company, no database access (runs in a worker thread)."""
    t0 = time.monotonic()
    g: dict = {"company": company, "notes": fw.registry_notes(company)}
    domain = (company.get("domain") or "").strip().lower().removeprefix("www.")
    if domain:
        url, body = fw.fetch_home(domain)
        g["pages"] = [(url, body)] + fw.extra_pages(url, body, want=1) if body else []
        g["status"] = "confirmed" if g["pages"] else "none"
        g["host"] = domain
        g["res"] = None
    else:
        res = fw.find_site(company)
        g["res"] = res
        g["pages"] = res.get("pages") or []
        g["status"] = res["verdict"] if res["verdict"] in ("confirmed", "unconfirmed") else "none"
        g["host"] = res.get("host")
    people: list[dict] = []
    owner_source = None
    g["pir_status"] = None
    if g["status"] == "confirmed":
        officers, pir_url, pir_status = tx.fetch_pir_officers(g["notes"].get("taxpayer_number") or "")
        g["pir_status"], g["pir_url"] = pir_status, pir_url
        if pir_status == "ok":
            people = [{**o, "url": pir_url} for o in officers]
            owner_source = tx.PIR_SOURCE
            g["pir_names"] = [o["name"] for o in officers]
        if not people and g["pages"]:
            home_url, home = g["pages"][0]
            more = tx.leadership_pages(home_url, home, [u for u, _ in g["pages"]])
            people = tx.people_from_pages(g["pages"] + more)
            owner_source = tx.SITE_SOURCE if people else None
        g["mx"] = fw.has_mx(g["host"]) if g["host"] else (None, "")
    g["people"], g["owner_source"] = people, owner_source
    sigs: list[dict] = []
    if people:
        sigs += ss.owner_news(company, people[0]["name"])
    if g["status"] in ("confirmed", "unconfirmed") or news_all:
        sigs += ss.company_news({**company, "domain": g["host"] if g["status"] == "confirmed" else None})
    g["signals"] = sigs
    g["seconds"] = round(time.monotonic() - t0, 1)
    return g


def apply(con: sqlite3.Connection, g: dict) -> dict:
    """Write one company's gathered results. Main thread only; the caller commits."""
    company, notes = g["company"], g["notes"]
    fetched = now_iso()
    reg_url = registry_url(notes)
    out: dict = {"id": company["id"], "name": company["name"], "city": company.get("city"), "host": g["host"]}

    # 1. website
    status, pages = g["status"], g["pages"]
    if g["res"] is None:
        out.update(site="on file", verdict=status)
        con.execute("UPDATE companies SET website_checked_at=? WHERE id=?", (fetched, company["id"]))
    else:
        res = g["res"]
        stored = fw.store_site(con, company, res)
        status = "confirmed" if stored == "confirmed" else "unconfirmed" if stored in ("unconfirmed", "conflict") else "none"
        out.update(site="found", verdict=status, reason=res.get("reason"), evidence=res.get("evidence"),
                   tried=res.get("tried"), url=res.get("url"))
        if stored == "conflict":
            out["reason"] = "confirmed, but the domain is already on another company"

    # 2. fit
    fit = fs.score_company(company["name"], pages, status, notes, reg_url)
    con.execute("UPDATE companies SET fit_score=?, fit_checked_at=? WHERE id=?", (fit["fit_score"], fetched, company["id"]))
    con.execute("DELETE FROM profile_facts WHERE entity='company' AND entity_id=? AND field='fit_reasons'", (company["id"],))
    for r in fit["reasons"]:
        pe.upsert_fact(con, {"entity": "company", "entity_id": company["id"], "field": "fit_reasons",
                             "value": r["reason"], "source_url": r["url"],
                             "source_label": "Company website" if r["url"] != reg_url else "TX Comptroller registry",
                             "confidence": "confirmed" if status == "confirmed" or r["url"] == reg_url else "unconfirmed",
                             "match_basis": f"fit_score.py ({r['points']:+d} points)"}, fetched)
    if fit["industry"] and status == "confirmed":
        pe.upsert_fact(con, {"entity": "company", "entity_id": company["id"], "field": "industry_tag",
                             "value": fit["industry"], "source_url": pages[0][0], "source_label": "Company website",
                             "confidence": "confirmed", "match_basis": "keyword taxonomy on the confirmed site"}, fetched)
        con.execute("UPDATE companies SET industry=? WHERE id=? AND (industry IS NULL OR industry='')", (fit["industry"], company["id"]))
    out.update(fit=fit["fit_score"], industry=fit["industry"], exclusion=fit["exclusion"],
               reasons=[f"{r['reason']} ({r['points']:+d})" for r in fit["reasons"]])

    # 3. owners (only off a site that is confirmed AND stored as confirmed)
    people = g["people"] if status == "confirmed" else []
    if status == "confirmed":
        out["pir"] = g["pir_status"]
        if g["pir_status"] == "ok":
            tx.snapshot(con, company["id"], tx.PIR_SOURCE, g.get("pir_names") or [], g["pir_url"], fetched)
        elif pages:
            tx.snapshot(con, company["id"], tx.SITE_SOURCE, [p["name"] for p in people], pages[0][0], fetched)
        if people:
            out["new_contacts"] = tx.store_people(con, company["id"], people, g["owner_source"], fetched)
        mx, how = g.get("mx") or (None, "")
        if mx is not None and g["host"]:
            src = how if how.startswith("http") else f"https://dns.google/resolve?type=MX&name={g['host']}"
            pe.upsert_fact(con, {"entity": "company", "entity_id": company["id"], "field": "domain_mx",
                                 "value": "Mail (MX) records found" if mx else "No mail (MX) records",
                                 "source_url": src, "source_label": "DNS MX lookup", "confidence": "confirmed",
                                 "match_basis": "DNS only, no SMTP",
                                 "note": None if how.startswith("http") else "checked with the system resolver"}, fetched)
        out["mx"] = mx
    out["owners"] = [f"{p['name']} ({p['title']})" for p in people[:3]]
    out["owner_source"] = g["owner_source"] if people else None

    # 4. signals
    kinds: dict[str, int] = {}
    n = ss.officer_change_signals(con, company["id"])
    if n:
        kinds["officer-change"] = n
    for sg in g["signals"]:
        if sg["kind"] == "owner-news" and not people:
            continue
        if ss.insert_signal(con, company["id"], sg["kind"], sg["title"], sg["url"], sg["observed_at"], sg["weight"]):
            kinds[sg["kind"]] = kinds.get(sg["kind"], 0) + 1
    if kinds:
        rescore_signals(con, company["id"])
    out["signals"] = kinds
    out["seconds"] = g["seconds"]
    return out


# ---------------------------------------------------------------------------
# run
# ---------------------------------------------------------------------------

def cmd_run(args) -> dict:
    con = sqlite3.connect(args.db, timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA busy_timeout = 5000")
    ensure_schema(con)
    ids = None
    if args.sample_ids:
        with open(args.sample_ids, encoding="utf-8") as f:
            ids = [int(x) for x in re.findall(r"\d+", f.read())]
    companies = select_companies(con, args.limit, ids)
    started = now_iso()
    if not companies:
        # nothing is due: no run row (the Sourcing page keeps showing the last real run), one audit line
        con.execute("INSERT INTO audit_log (actor_label, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?)",
                    ("sourcing-pipeline", "sourcing.run", "sourcing_run", None,
                     json.dumps({"checked": 0, "note": f"nothing due (every selected company was checked in the last {RECHECK_DAYS} days)"})))
        con.commit()
        con.close()
        print(json.dumps({"checked": 0, "planned": 0, "note": "nothing due"}))
        return {"checked": 0}
    run_id = con.execute("INSERT INTO sourcing_runs (started_at, notes) VALUES (?, ?)",
                         (started, json.dumps({"planned": len(companies), "limit": args.limit}))).lastrowid
    con.commit()
    t0 = time.monotonic()
    st = {"checked": 0, "sites_found": 0, "sites_unconfirmed": 0, "fits": 0, "owners_found": 0, "signals_new": 0, "errors": 0}
    by_kind: dict[str, int] = {}
    owner_sources: dict[str, int] = {}
    log = open(args.log, "a", encoding="utf-8") if args.log else None
    interrupted = False

    def save(finished: str | None, extra: dict):
        reqs = sum(fw.REQUESTS.values()) + fw.DOH_STATE["system_lookups"]
        notes = {"planned": len(companies), "limit": args.limit, "signals_by_kind": by_kind,
                 "owner_sources": owner_sources, "runtime_seconds": round(time.monotonic() - t0),
                 "requests_by_kind": {"http": sum(fw.REQUESTS.values()), "system_dns": fw.DOH_STATE["system_lookups"]},
                 "doh_blocked": fw.DOH_STATE["disabled"], "gdelt_calls": ss._gdelt_state["calls"],
                 "gdelt_rate_limited": ss._gdelt_state["limited"], "pir_api_key_present": bool(tx.api_key()), **extra}
        con.execute("""UPDATE sourcing_runs SET finished_at=?, checked=?, sites_found=?, sites_unconfirmed=?, fits=?,
                       owners_found=?, signals_new=?, errors=?, requests=?, notes=? WHERE id=?""",
                    (finished, st["checked"], st["sites_found"], st["sites_unconfirmed"], st["fits"], st["owners_found"],
                     st["signals_new"], st["errors"], reqs, json.dumps(notes), run_id))
        con.commit()
        return notes

    pool = ThreadPoolExecutor(max_workers=max(1, args.workers))
    futures: list = []

    def safe_gather(c: dict):
        try:
            return gather(c, args.news_all)
        except Exception as e:
            return {"company": c, "error": f"{type(e).__name__}: {e}", "trace": traceback.format_exc(limit=4)}
    try:
        futures = [pool.submit(safe_gather, c) for c in companies]
        for i, fut in enumerate(as_completed(futures), 1):
            g = fut.result()
            company = g["company"]
            try:
                if "error" in g:
                    raise RuntimeError(g["error"])
                r = apply(con, g)
                con.commit()
            except Exception as e:
                con.rollback()
                st["errors"] += 1
                r = {"id": company["id"], "name": company["name"], "error": f"{type(e).__name__}: {e}",
                     "trace": g.get("trace") or traceback.format_exc(limit=4)}
            st["checked"] += 1 if "error" not in r else 0
            if r.get("verdict") == "confirmed":
                st["sites_found"] += 1
            elif r.get("verdict") == "unconfirmed":
                st["sites_unconfirmed"] += 1
            if (r.get("fit") or 0) >= fs.GOOD_FIT:
                st["fits"] += 1
            if r.get("owners"):
                st["owners_found"] += 1
                owner_sources[r["owner_source"]] = owner_sources.get(r["owner_source"], 0) + 1
            for k, v in (r.get("signals") or {}).items():
                by_kind[k] = by_kind.get(k, 0) + v
                st["signals_new"] += v
            if log:
                log.write(json.dumps(r) + "\n")
                log.flush()
            if not args.quiet:
                print(f"[{i}/{len(companies)}] #{r['id']} {r['name'][:44]:44} {r.get('verdict', 'ERROR'):11} "
                      f"{(r.get('host') or '')[:32]:32} fit={r.get('fit', '-')} owners={len(r.get('owners') or [])} "
                      f"sig={sum((r.get('signals') or {}).values())} {r.get('seconds', '')}s", flush=True)
            if i % 10 == 0:
                save(None, {"in_progress": True})
    except KeyboardInterrupt:
        interrupted = True
    pool.shutdown(wait=False, cancel_futures=True)
    notes = save(now_iso(), {"interrupted": interrupted})
    # The existing email_finder verifier, DNS MX only (never SMTP), on contacts that
    # already have an address. Its own lookup is DoH only; hand it the fallback-aware one.
    ef.has_mx = lambda d: fw.has_mx(d)[0]
    try:
        notes["email_verify"] = ef.verify(con, argparse.Namespace())
    except Exception as e:
        notes["email_verify"] = {"error": str(e)}
    summary = {"run_id": run_id, **st, "requests": sum(fw.REQUESTS.values()) + fw.DOH_STATE["system_lookups"], **notes}
    con.execute("UPDATE sourcing_runs SET notes=? WHERE id=?", (json.dumps(notes), run_id))
    con.execute("INSERT INTO audit_log (actor_label, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?)",
                ("sourcing-pipeline", "sourcing.run", "sourcing_run", run_id, json.dumps(summary)))
    con.commit()
    con.close()
    if log:
        log.close()
    print(json.dumps(summary, indent=1))
    return summary


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="website -> fit -> owners -> signals for up to --limit companies")
    r.add_argument("--db", required=True)
    r.add_argument("--limit", type=int, default=200)
    r.add_argument("--sample-ids", dest="sample_ids", default=None, help="file of company ids (any separator)")
    r.add_argument("--log", default=None, help="append one JSON line per company to this file")
    r.add_argument("--news-all", dest="news_all", action="store_true",
                   help="query news for every company, not only those with a website found")
    r.add_argument("--workers", type=int, default=4,
                   help="companies fetched at once (each host still gets at most 1 request per second)")
    r.add_argument("--quiet", action="store_true")
    args = p.parse_args(argv)
    cmd_run(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
