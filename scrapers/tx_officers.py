#!/usr/bin/env python3
"""
tx_officers.py - who owns and runs a company, from sources that allow it.

Stdlib only. No login, no paid API, no LLM call, never an email guess.

WHAT WAS CHECKED (2026-09-28) BEFORE WRITING THIS
-------------------------------------------------
Texas Comptroller "Franchise Tax Account Status" search
  (comptroller.texas.gov/taxes/franchise/account-status/search). The page
  itself is allowed by robots.txt, but it is an empty shell: the entity and
  officer data is loaded by JavaScript from
  comptroller.texas.gov/data-search/franchise-tax/<taxpayer id>, and
  comptroller.texas.gov/robots.txt says "Disallow: /*/" with no Allow line for
  /data-search/. So the search results and the officer list are
  robots-disallowed for automated clients. This script never requests them.
  (The old mycpa.cpa.state.tx.us/coa address now redirects to the same page.)

Texas Comptroller Public Data API (api-doc.comptroller.texas.gov/public-data/)
  The state's own sanctioned route. GET
  https://api.comptroller.texas.gov/public-data/v1/public/franchise-tax/<id>
  returns the account plus "officerInfo" (name, title, year, address, source
  SOS) from the franchise-tax Public Information Report. It needs a free
  x-api-key that a person gets by registering at
  data-secure.comptroller.texas.gov (my-profile, developer section). Without a
  key it answers 403. The docs list rate and monthly limits (HTTP 429).
  This script calls it ONLY when TX_COMPTROLLER_API_KEY is set in the
  environment; the key is never written to the database, a log or the vault.

Company website (the fallback that always runs)
  About / Team / Leadership / History pages on the company's own confirmed
  site: "founded by", owner, president, CEO, with the page URL as the source.
  robots.txt is obeyed for every host (profile_enrich.polite_get).

WHAT IS WRITTEN
---------------
  contacts         one row per person, deduped by name within the company.
                   title = the title printed next to them. source =
                   'tx-comptroller-pir' or 'company-website'. Never an email.
  profile_facts    owner_name / owner_title / officers, each with source URL.
  officer_snapshots one row per company per source per run: the set of names.
                   sourcing_signals.py compares the latest two to find an
                   officer who was added or removed (signal kind officer-change).

Usage:
  python scrapers/tx_officers.py people --html about.html --url https://acme.com/about
  python scrapers/tx_officers.py api --taxpayer 12345678901      (needs TX_COMPTROLLER_API_KEY)
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import profile_enrich as pe  # noqa: E402

API = "https://api.comptroller.texas.gov/public-data/v1/public/franchise-tax/"
PIR_SOURCE = "tx-comptroller-pir"
SITE_SOURCE = "company-website"
OWNER_TITLES = re.compile(r"\b(owner|founder|co-founder|president|ceo|chief executive|chairman|principal|managing (?:member|partner))\b", re.I)


# ---------------------------------------------------------------------------
# Comptroller Public Data API (only with a key the user registered for)
# ---------------------------------------------------------------------------

def api_key() -> str | None:
    k = os.environ.get("TX_COMPTROLLER_API_KEY", "").strip()
    return k or None


def fetch_pir_officers(taxpayer_id: str) -> tuple[list[dict], str, str]:
    """(officers, source_url, status). status: ok | no-key | not-found | error."""
    key = api_key()
    url = API + urllib.parse.quote(taxpayer_id or "")
    if not key:
        return [], url, "no-key"
    if not re.fullmatch(r"\d{11}", taxpayer_id or ""):
        return [], url, "not-found"
    pe._throttle("api.comptroller.texas.gov", 1.0)
    req = urllib.request.Request(url, headers={"x-api-key": key, "Accept": "application/json", "User-Agent": pe.UA})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        return [], url, "not-found" if e.code == 404 else f"error {e.code}"
    except Exception:
        return [], url, "error"
    return parse_pir(data), url, "ok"


def parse_pir(data: dict) -> list[dict]:
    """officerInfo rows -> [{name, title, year}]. Pure."""
    rows = ((data or {}).get("data") or {}).get("officerInfo") or []
    out, seen = [], set()
    for r in rows:
        raw = (r.get("AGNT_NM") or "").strip()
        if not raw or re.search(r"\b(LLC|INC|CORP|LTD|LP|COMPANY|TRUST)\b", raw, re.I):
            continue  # an entity acting as officer or manager is not a person to call
        name = " ".join(w.capitalize() if not re.fullmatch(r"[A-Z]\.?", w) else w for w in raw.split())
        if "," in name:  # "DOE, JANE" -> "Jane Doe"
            last, first = [x.strip() for x in name.split(",", 1)]
            name = f"{first} {last}"
        k = name.lower()
        if k in seen:
            continue
        seen.add(k)
        out.append({"name": name, "title": (r.get("AGNT_TITL_TX") or "officer").strip().title(),
                    "year": r.get("AGNT_ACTV_YR")})
    return out


# ---------------------------------------------------------------------------
# Company website
# ---------------------------------------------------------------------------

def people_from_pages(pages: list[tuple[str, str]]) -> list[dict]:
    """Named principals printed on the site: [{name, title, url}]. Pure.

    Only people whose printed title is an owner-level title (owner, founder,
    president, CEO, chairman, principal, managing member) are kept.
    """
    found: dict[str, dict] = {}
    for url, body in pages:
        text = pe.visible_text(body)
        for p in pe.find_people(body, text):
            nm, title = p["name"], p.get("title") or ""
            if not OWNER_TITLES.search(title) or pe.principal_rank(title) == 99:
                continue
            if len(nm.split()) < 2:
                continue
            k = nm.lower()
            if k not in found:
                found[k] = {"name": nm, "title": title[:80], "url": url}
    return sorted(found.values(), key=lambda p: pe.principal_rank(p["title"]))


def leadership_pages(home_url: str, home: str, have: list[str], want: int = 2) -> list[tuple[str, str]]:
    """About / Team / Leadership pages not fetched yet (robots obeyed)."""
    out = []
    links = pe.rank_links([(u, lab) for u, lab in pe.nav_links(home, home_url)
                           if re.search(r"about|team|leader|management|history|story|founder|owner|who", u + " " + lab, re.I)])
    for u in links:
        if u.rstrip("/") in {h.rstrip("/") for h in have}:
            continue
        fu, b = pe.polite_get(u)
        if b:
            out.append((fu, b))
        if len(out) >= want:
            break
    return out


# ---------------------------------------------------------------------------
# Store
# ---------------------------------------------------------------------------

def _split(name: str) -> tuple[str, str]:
    parts = name.split()
    return (parts[0], " ".join(parts[1:])) if len(parts) > 1 else (name, "")


def store_people(con: sqlite3.Connection, company_id: int, people: list[dict], source: str, fetched: str) -> int:
    """Upsert people as contacts (no email) + facts. Returns contacts newly created."""
    existing = {((r[0] or "") + " " + (r[1] or "")).strip().lower(): r[2] for r in con.execute(
        "SELECT first_name, last_name, id FROM contacts WHERE company_id=?", (company_id,))}
    new = 0
    for i, p in enumerate(people[:5]):
        k = p["name"].lower()
        if k not in existing:
            first, last = _split(p["name"])
            cur = con.execute(
                """INSERT INTO contacts (company_id, first_name, last_name, title, source, enriched_at)
                   VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)""", (company_id, first, last or None, p["title"], source))
            existing[k] = cur.lastrowid
            new += 1
        field = "officers" if source == PIR_SOURCE else "leaders"
        pe.upsert_fact(con, {"entity": "company", "entity_id": company_id, "field": field,
                             "value": f"{p['name']} | {p['title']}", "source_url": p["url"],
                             "source_label": "TX Comptroller PIR" if source == PIR_SOURCE else "Company website",
                             "confidence": "confirmed",
                             "match_basis": "registry taxpayer number" if source == PIR_SOURCE else "confirmed company website"},
                       fetched)
        if i == 0:
            for f, v in (("owner_name", p["name"]), ("owner_title", p["title"])):
                pe.upsert_fact(con, {"entity": "company", "entity_id": company_id, "field": f, "value": v,
                                     "source_url": p["url"],
                                     "source_label": "TX Comptroller PIR" if source == PIR_SOURCE else "Company website",
                                     "confidence": "confirmed", "match_basis": "principal title printed next to the name"},
                               fetched)
    return new


def snapshot(con: sqlite3.Connection, company_id: int, source: str, names: list[str], url: str, taken: str) -> None:
    con.execute("INSERT INTO officer_snapshots (company_id, source, names_json, source_url, taken_at) VALUES (?,?,?,?,?)",
                (company_id, source, json.dumps(sorted({n.strip() for n in names if n.strip()})), url, taken))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("people", help="owner-level people on saved pages (no network)")
    a.add_argument("--html", action="append", default=[])
    a.add_argument("--url", action="append", default=[])
    b = sub.add_parser("api", help="officers from the Comptroller Public Data API (needs TX_COMPTROLLER_API_KEY)")
    b.add_argument("--taxpayer", required=True)
    args = p.parse_args(argv)
    if args.cmd == "people":
        pages = [(u, open(h, encoding="utf-8", errors="replace").read()) for h, u in zip(args.html, args.url)]
        print(json.dumps(people_from_pages(pages), indent=1))
        return 0
    officers, url, status = fetch_pir_officers(args.taxpayer)
    print(json.dumps({"status": status, "source_url": url, "officers": officers}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
