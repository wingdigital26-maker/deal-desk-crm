#!/usr/bin/env python3
"""
harness_signals.py - zero-usage lead sourcing for the banker harness.

Stdlib only (urllib, json, sqlite3, xml, argparse, time). No paid APIs, no
LLM calls. Reuses the collector shapes proven in
an earlier standalone signal engine (engine.py) (Greenhouse/Lever/Ashby
hiring boards, Google News RSS, SEC EDGAR full-text, USAspending) but writes
straight into the harness sqlite schema defined in app/lib/db.ts, so no
separate signals.db and no company import step is needed.

Usage:
  python harness_signals.py collect --db data/harness.db [--limit 50]
  python harness_signals.py discover --db data/harness.db --segment owners --state TX [--naics 336] [--limit 25]
  python harness_signals.py verify-emails --db data/harness.db
  python harness_signals.py score --db data/harness.db
  python harness_signals.py run --db data/harness.db [--limit 50]

Schedule it weekly. See scrapers/README.md.
"""

import argparse
import json
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

UA = "banker-harness-signal-engine/1.0 (research tool; contact: you@example.com)"
TIMEOUT = 10

# ---------------------------------------------------------------------------
# Politeness: 1 request/second per host, back off on HTTP 429.
# ---------------------------------------------------------------------------
_last_hit: dict[str, float] = {}


def _throttle(host: str):
    last = _last_hit.get(host, 0.0)
    wait = 1.0 - (time.monotonic() - last)
    if wait > 0:
        time.sleep(wait)
    _last_hit[host] = time.monotonic()


def fetch(url: str, headers: dict | None = None, data: bytes | None = None, retries: int = 2) -> str | None:
    """GET/POST with a 1 req/sec per-host throttle, 10s timeout, 429 backoff.
    Returns None (skip this collector) on any failure instead of raising."""
    host = urllib.parse.urlparse(url).netloc
    hdrs = {"User-Agent": UA}
    if headers:
        hdrs.update(headers)
    for attempt in range(retries + 1):
        _throttle(host)
        req = urllib.request.Request(url, data=data, headers=hdrs)
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(3 * (attempt + 1))
                continue
            return None
        except Exception:
            return None
    return None


def slug(text: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "", (text or "").lower())


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# DB helpers - the harness schema (see app/lib/db.ts). This script never
# creates the schema; it assumes the Next app (or a prior `collect` run
# against a fresh copy) already did via db().
# ---------------------------------------------------------------------------

def connect(path: str) -> sqlite3.Connection:
    con = sqlite3.connect(path)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys = ON;")
    return con


def audit(con: sqlite3.Connection, action: str, detail: dict, entity: str | None = None, entity_id: int | None = None):
    con.execute(
        "INSERT INTO audit_log (actor_label, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?)",
        ("signal-engine", action, entity, entity_id, json.dumps(detail)),
    )


# ---------------------------------------------------------------------------
# Ownership-transition language the desk actually cares about.
# ---------------------------------------------------------------------------
NEWS_KEYWORDS = [
    "succession", "retire", "retirement", "acquisition", "acquires", "acquired",
    "private equity", "recapitalization", "recapitalize", "expansion", "expand",
    "new facility", "new plant", "founder", "sells", "sale of",
]
# These get extra weight when matched (true ownership-transition signal).
HOT_KEYWORDS = {"succession", "retire", "retirement", "private equity", "recapitalization", "founder"}

HIRING_KEYWORDS = [
    "chief operating officer", "chief financial officer", "cfo", "coo",
    "controller", "vp of operations", "vp of finance", "general manager",
    "plant manager", "operations manager",
]


def guess_tokens(name: str, domain: str | None) -> list[str]:
    cands = []
    if domain:
        cands.append(slug(domain.split(".")[0]))
    cands.append(slug(name))
    seen, out = set(), []
    for c in cands:
        if c and c not in seen:
            seen.add(c)
            out.append(c)
    return out


def match_keywords(text: str, keywords: list[str]) -> list[str]:
    t = (text or "").lower()
    return [k for k in keywords if k in t]


# ---------------------------------------------------------------------------
# Collectors. Each returns a list of dicts: kind, title, url, observed_at, weight.
# Each fails soft (returns [] on any error).
# ---------------------------------------------------------------------------

def collect_hiring(name: str, domain: str | None) -> list[dict]:
    out = []
    for token in guess_tokens(name, domain):
        gh = fetch(f"https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true")
        if gh:
            try:
                data = json.loads(gh)
                for job in data.get("jobs", []):
                    title = job.get("title", "")
                    if match_keywords(title, HIRING_KEYWORDS):
                        out.append({
                            "kind": "hiring", "title": f"Hiring: {title}",
                            "url": job.get("absolute_url", ""),
                            "observed_at": (job.get("updated_at") or "")[:10] or None,
                            "weight": 3.0,
                        })
            except Exception:
                pass
        lv = fetch(f"https://api.lever.co/v0/postings/{token}?mode=json")
        if lv:
            try:
                data = json.loads(lv)
                if isinstance(data, list):
                    for job in data:
                        title = job.get("text", "")
                        if match_keywords(title, HIRING_KEYWORDS):
                            ts = job.get("createdAt")
                            obs = datetime.fromtimestamp(ts / 1000, timezone.utc).date().isoformat() if ts else None
                            out.append({
                                "kind": "hiring", "title": f"Hiring: {title}",
                                "url": job.get("hostedUrl", ""), "observed_at": obs, "weight": 3.0,
                            })
            except Exception:
                pass
        ab = fetch(f"https://api.ashbyhq.com/posting-api/job-board/{token}")
        if ab:
            try:
                data = json.loads(ab)
                for job in data.get("jobs", []):
                    title = job.get("title", "")
                    if match_keywords(title, HIRING_KEYWORDS):
                        out.append({
                            "kind": "hiring", "title": f"Hiring: {title}",
                            "url": job.get("jobUrl", ""),
                            "observed_at": (job.get("publishedAt") or "")[:10] or None,
                            "weight": 3.0,
                        })
            except Exception:
                pass
        if out:
            break
    return out


def collect_news(name: str) -> list[dict]:
    q = f'"{name}" ({" OR ".join(NEWS_KEYWORDS)})'
    url = "https://news.google.com/rss/search?" + urllib.parse.urlencode(
        {"q": q, "hl": "en-US", "gl": "US", "ceid": "US:en"}
    )
    xml_text = fetch(url)
    if not xml_text:
        return []
    try:
        root = ET.fromstring(xml_text)
    except Exception:
        return []
    out = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        matched = match_keywords(title, NEWS_KEYWORDS)
        if not matched:
            continue
        pub = item.findtext("pubDate") or ""
        try:
            obs = datetime.strptime(pub[:16], "%a, %d %b %Y").date().isoformat()
        except Exception:
            obs = None
        weight = 4.0 if any(k in HOT_KEYWORDS for k in matched) else 2.0
        out.append({
            "kind": "news", "title": title, "url": item.findtext("link") or "",
            "observed_at": obs, "weight": weight,
        })
    return out[:10]


def collect_filings(name: str) -> list[dict]:
    q = urllib.parse.quote(f'"{name}"')
    data_text = fetch(
        f"https://efts.sec.gov/LATEST/search-index?q={q}",
        headers={"Accept": "application/json"},
    )
    if not data_text:
        return []
    try:
        data = json.loads(data_text)
    except Exception:
        return []
    out = []
    for hit in data.get("hits", {}).get("hits", [])[:5]:
        src = hit.get("_source", {})
        forms = src.get("root_forms") or src.get("form") or []
        form = forms[0] if isinstance(forms, list) and forms else (forms or "filing")
        adsh = (src.get("adsh") or "").replace("-", "")
        cik = src.get("cik") or ""
        url = f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK={cik}" if cik else "https://www.sec.gov/cgi-bin/browse-edgar"
        out.append({
            "kind": "filing", "title": f"SEC {form} mention", "url": url,
            "observed_at": src.get("file_date") or None, "weight": 1.0,
        })
        _ = adsh
    return out


def collect_contracts(name: str) -> list[dict]:
    body = json.dumps({
        "filters": {"keywords": [name], "award_type_codes": ["A", "B", "C", "D"]},
        "fields": ["Recipient Name", "Award Amount", "Action Date", "Awarding Agency"],
        "limit": 10, "page": 1,
    }).encode()
    data_text = fetch(
        "https://api.usaspending.gov/api/v2/search/spending_by_award/",
        headers={"Content-Type": "application/json"}, data=body,
    )
    if not data_text:
        return []
    try:
        data = json.loads(data_text)
    except Exception:
        return []
    out = []
    name_l = name.lower()
    for r in data.get("results", []):
        if name_l not in (r.get("Recipient Name", "") or "").lower():
            continue
        amt = r.get("Award Amount") or 0
        out.append({
            "kind": "contract",
            "title": f"${amt:,.0f} federal award from {r.get('Awarding Agency', '')}",
            "url": "https://www.usaspending.gov/award/" + str(r.get("generated_internal_id", "")),
            "observed_at": (r.get("Action Date") or "")[:10] or None,
            "weight": 2.0,
        })
    return out[:5]


# "filings" is deliberately NOT collected. It ran a full-text search of SEC documents
# for the company NAME, and privately held companies do not file with the SEC, so
# generic names ("Premier Manufacturing") matched other companies' filings. Every one of
# the 46 filing signals it produced on the first real run was a false attribution
# (removed 2026-09-20). A real document attached to the wrong company is worse than no
# signal. Re-enable only with an identity check (CIK matched to the company's own
# state and address), never on a name match alone.
# "contracts" is ALSO NOT collected (disabled 2026-09-25). It matched a federal award
# recipient by NAME only: a hand check of the 2026-09-25 run found 2 of 3 were other
# companies (an out-of-state namesake and an unrelated paving firm), and all 43
# contract signals were removed (archived in backups/). Re-enable only with a recipient
# city+state (or UEI) match against the company's own record.
COLLECTORS = {
    "hiring": lambda c: collect_hiring(c["name"], c["domain"]),
    "news": lambda c: collect_news(c["name"]),
}


# ---------------------------------------------------------------------------
# collect
# ---------------------------------------------------------------------------

def cmd_collect(args):
    con = connect(args.db)
    q = "SELECT id, name, domain FROM companies"
    if args.limit:
        q += f" LIMIT {int(args.limit)}"
    companies = con.execute(q).fetchall()
    inserted = 0
    errors = 0
    for c in companies:
        for kind, fn in COLLECTORS.items():
            try:
                sigs = fn(c)
            except Exception as e:
                errors += 1
                print(f"  [skip] {kind} for {c['name']}: {e}", file=sys.stderr)
                continue
            for s in sigs:
                if not s.get("url"):
                    continue
                try:
                    cur = con.execute(
                        """INSERT OR IGNORE INTO signals (company_id, kind, title, url, observed_at, weight)
                           VALUES (?,?,?,?,?,?)""",
                        (c["id"], s["kind"], s["title"], s["url"], s.get("observed_at"), s.get("weight", 1.0)),
                    )
                    if cur.rowcount:
                        inserted += 1
                except Exception as e:
                    errors += 1
                    print(f"  [skip-insert] {kind} for {c['name']}: {e}", file=sys.stderr)
    con.commit()
    print(f"collect: {len(companies)} companies scanned, {inserted} new signals, {errors} collector errors")
    con.close()
    return {"companies_scanned": len(companies), "signals_inserted": inserted, "errors": errors}


# ---------------------------------------------------------------------------
# discover - find NEW companies from free public sources.
# ---------------------------------------------------------------------------

NAICS_BY_SEGMENT = {
    "owners": None,  # left open; --naics narrows it
    "institutions": "522110",  # commercial banking
}


def discover_usaspending_recipients(state: str, naics: str | None, limit: int) -> list[dict]:
    filters: dict = {
        "place_of_performance_locations": [{"country": "USA", "state": state}],
        "award_type_codes": ["A", "B", "C", "D"],
    }
    if naics:
        filters["naics_codes"] = [naics]
    body = json.dumps({
        "filters": filters,
        "fields": ["Recipient Name", "Recipient UEI", "Awarding Agency", "Award Amount"],
        "limit": min(limit, 100), "page": 1,
        "sort": "Award Amount", "order": "desc",
    }).encode()
    data_text = fetch(
        "https://api.usaspending.gov/api/v2/search/spending_by_award/",
        headers={"Content-Type": "application/json"}, data=body,
    )
    if not data_text:
        return []
    try:
        data = json.loads(data_text)
    except Exception:
        return []
    out = []
    seen = set()
    for r in data.get("results", []):
        rname = (r.get("Recipient Name") or "").strip()
        if not rname or rname.lower() in seen:
            continue
        seen.add(rname.lower())
        out.append({"name": rname, "domain": None})
    return out[:limit]


def discover_edgar_companies(state: str, limit: int) -> list[dict]:
    url = f"https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&State={urllib.parse.quote(state)}&SIC=&dateb=&owner=include&count={min(limit, 100)}&output=atom"
    xml_text = fetch(url)
    if not xml_text:
        return []
    try:
        root = ET.fromstring(xml_text)
    except Exception:
        return []
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for entry in root.findall("a:entry", ns):
        title = (entry.findtext("a:title", default="", namespaces=ns) or "").strip()
        if not title:
            continue
        # EDGAR atom titles look like "0000320193 - Apple Inc."
        name = title.split(" - ", 1)[-1].strip() or title
        out.append({"name": name, "domain": None})
    return out[:limit]


def cmd_discover(args):
    con = connect(args.db)
    segment = args.segment or "owners"
    candidates: list[dict] = []
    candidates += discover_usaspending_recipients(args.state, args.naics, args.limit or 25)
    if len(candidates) < (args.limit or 25):
        candidates += discover_edgar_companies(args.state, (args.limit or 25) - len(candidates))

    inserted = 0
    for cand in candidates:
        try:
            cur = con.execute(
                """INSERT OR IGNORE INTO companies (name, domain, segment_id, state, source)
                   VALUES (?,?,?,?,'signal-engine')""",
                (cand["name"], cand["domain"], segment, args.state),
            )
            if cur.rowcount:
                inserted += 1
        except Exception as e:
            print(f"  [skip] insert {cand['name']}: {e}", file=sys.stderr)
    audit(con, "signals.discover", {"segment": segment, "state": args.state, "naics": args.naics, "candidates": len(candidates), "inserted": inserted})
    con.commit()
    print(f"discover: {len(candidates)} candidates found, {inserted} new companies inserted")
    con.close()
    return {"candidates_found": len(candidates), "companies_inserted": inserted}


# ---------------------------------------------------------------------------
# verify-emails - MX check via DNS-over-HTTPS. No SMTP probing.
# ---------------------------------------------------------------------------

def has_mx(domain: str) -> bool | None:
    url = f"https://dns.google/resolve?name={urllib.parse.quote(domain)}&type=MX"
    text = fetch(url)
    if text is None:
        return None
    try:
        data = json.loads(text)
    except Exception:
        return None
    return bool(data.get("Answer"))


def cmd_verify_emails(args):
    con = connect(args.db)
    rows = con.execute(
        "SELECT id, email FROM contacts WHERE email IS NOT NULL AND (email_status IS NULL OR email_status = 'unknown')"
    ).fetchall()
    checked = 0
    mx_ok = 0
    for r in rows:
        domain = (r["email"] or "").split("@")[-1].strip()
        if not domain:
            continue
        result = has_mx(domain)
        if result is None:
            continue  # DoH lookup failed; leave status untouched, skip
        status = "mx-only" if result else "no-mx"
        con.execute("UPDATE contacts SET email_status = ?, updated_at = datetime('now') WHERE id = ?", (status, r["id"]))
        checked += 1
        if result:
            mx_ok += 1
    con.commit()
    print(f"verify-emails: {checked} contacts checked, {mx_ok} with a valid MX record")
    con.close()
    return {"contacts_checked": checked, "mx_ok": mx_ok}


# ---------------------------------------------------------------------------
# score - signal_score = sum(weight * recency decay, 45-day half-life)
# ---------------------------------------------------------------------------
HALF_LIFE_DAYS = 45


def cmd_score(args):
    con = connect(args.db)
    companies = con.execute("SELECT id FROM companies").fetchall()
    today = datetime.now(timezone.utc).date()
    updated = 0
    for c in companies:
        sigs = con.execute(
            "SELECT weight, observed_at, created_at FROM signals WHERE company_id = ?", (c["id"],)
        ).fetchall()
        score = 0.0
        for s in sigs:
            date_str = s["observed_at"] or (s["created_at"] or "")[:10]
            try:
                d = datetime.strptime(date_str[:10], "%Y-%m-%d").date()
                age_days = max((today - d).days, 0)
            except Exception:
                age_days = 0
            decay = 0.5 ** (age_days / HALF_LIFE_DAYS)
            score += (s["weight"] or 1.0) * decay
        con.execute(
            "UPDATE companies SET signal_score = ?, updated_at = datetime('now') WHERE id = ?",
            (round(score, 4), c["id"]),
        )
        updated += 1
    con.commit()
    print(f"score: recomputed signal_score for {updated} companies")
    con.close()
    return {"companies_scored": updated}


# ---------------------------------------------------------------------------
# run - collect, verify-emails, score in order; one audit_log row.
# ---------------------------------------------------------------------------

def cmd_run(args):
    con = connect(args.db)
    con.close()
    collect_summary = cmd_collect(args)
    verify_summary = cmd_verify_emails(args)
    score_summary = cmd_score(args)
    summary = {
        "ran_at": now_iso(),
        "collect": collect_summary,
        "verify_emails": verify_summary,
        "score": score_summary,
    }
    con = connect(args.db)
    audit(con, "signals.run", summary)
    con.commit()
    con.close()
    print(json.dumps(summary, indent=2))
    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="Zero-usage signal collector for the banker harness.")
    sub = p.add_subparsers(dest="cmd", required=True)

    pc = sub.add_parser("collect", help="Collect signals for existing companies")
    pc.add_argument("--db", required=True)
    pc.add_argument("--limit", type=int, default=None)
    pc.set_defaults(fn=cmd_collect)

    pd = sub.add_parser("discover", help="Find new candidate companies")
    pd.add_argument("--db", required=True)
    pd.add_argument("--segment", default="owners")
    pd.add_argument("--state", required=True)
    pd.add_argument("--naics", default=None)
    pd.add_argument("--limit", type=int, default=25)
    pd.set_defaults(fn=cmd_discover)

    pv = sub.add_parser("verify-emails", help="MX-check contact emails via DoH")
    pv.add_argument("--db", required=True)
    pv.set_defaults(fn=cmd_verify_emails)

    ps = sub.add_parser("score", help="Recompute companies.signal_score")
    ps.add_argument("--db", required=True)
    ps.set_defaults(fn=cmd_score)

    pr = sub.add_parser("run", help="collect + verify-emails + score, one audit row")
    pr.add_argument("--db", required=True)
    pr.add_argument("--limit", type=int, default=None)
    pr.set_defaults(fn=cmd_run)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
