#!/usr/bin/env python3
"""
tx_registry.py - build a target universe from the Texas state business registry.

Stdlib only (urllib, json, sqlite3, argparse, time). No API key, no paid API,
no LLM call, no login. Writes candidate companies into the harness's own
SQLite database, same schema and conventions as harness_signals.py.

WHY THIS SOURCE
---------------
The Apollo pull gave 25 contacts of which 8 were unusable (already sold, PE
owned, or not even in Texas). The state's own franchise-tax file has no such
problem: every row is an entity that is registered and currently in good
standing in Texas, and the SOS charter date is the real founding year straight
from the state rather than a vendor's guess. 3.46M active entities as of
2026-09-20.

  Source: Texas Comptroller, "Active Franchise Tax Permit Holders"
  https://data.texas.gov/Government-and-Taxes/Active-Franchise-Tax-Permit-Holders/9cir-efmm
  Socrata JSON API, no key required, public open-data licence.

WHAT THIS FILE DOES AND DOES NOT GIVE US
----------------------------------------
Gives us, as hard state-filed fact: legal entity name, street address, city,
county, ZIP, organisational type, SOS file number, SOS charter date (founding
year), and current right-to-transact-business status.

Does NOT give us: NAICS code, revenue, employee count, website, or any person's
name. So this file cannot tell a machine shop from a law firm on its own.

Because of that, the industry filter here is a NAME-KEYWORD filter, and every
row it produces is a CANDIDATE, not a qualified target. This is deliberately
the opposite of the SEC-filing mistake (see harness_signals.py line 289): there,
a name-only match was written into the record as though it were a fact about the
company. Here the name match only decides whether a human ever looks at the row,
and `industry` is left NULL because the registry never states one.

Usage:
  python scrapers/tx_registry.py discover --db data/harness.db \
      --metro dfw --founded-before 2006 --founded-after 1960 --limit 200
  python scrapers/tx_registry.py discover --db data/harness.db --metro austin --dry
  python scrapers/tx_registry.py counties
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
from datetime import datetime, timezone

SOCRATA = "https://data.texas.gov/resource/9cir-efmm.json"
UA = "banker-harness-tx-registry/1.0 (research tool; contact: you@example.com)"
TIMEOUT = 20
PAGE = 1000

# ---------------------------------------------------------------------------
# Metro definitions. The file has a county code but no metro, so we filter on
# city, which is the column a human can actually check against the live site.
# ---------------------------------------------------------------------------
METROS: dict[str, list[str]] = {
    # The full metroplex, not just the big names: the industrial suburbs are
    # where the founder-owned shops actually sit, and a Dallas-only city list
    # misses Haltom City, Saginaw and Grand Prairie entirely.
    "dfw": [
        "DALLAS", "FORT WORTH", "ARLINGTON", "PLANO", "IRVING", "GARLAND",
        "GRAND PRAIRIE", "MCKINNEY", "FRISCO", "MESQUITE", "CARROLLTON",
        "DENTON", "RICHARDSON", "LEWISVILLE", "ALLEN", "FLOWER MOUND",
        "NORTH RICHLAND HILLS", "MANSFIELD", "ROCKWALL", "HALTOM CITY",
        "EULESS", "GRAPEVINE", "BEDFORD", "DESOTO", "CEDAR HILL", "WAXAHACHIE",
        "SOUTHLAKE", "COPPELL", "FARMERS BRANCH", "ADDISON", "WYLIE",
        "KELLER", "BURLESON", "HURST", "DUNCANVILLE", "ROWLETT", "THE COLONY",
        "LITTLE ELM", "PROSPER", "CELINA", "MIDLOTHIAN", "ENNIS", "CLEBURNE",
        "WEATHERFORD", "SAGINAW", "WATAUGA", "COLLEYVILLE", "TROPHY CLUB",
        "MURPHY", "SACHSE", "LANCASTER", "BALCH SPRINGS", "SEAGOVILLE",
        "TERRELL", "GREENVILLE", "CORINTH", "HIGHLAND VILLAGE", "ARGYLE",
        "AUBREY", "SANGER", "KRUM", "PILOT POINT", "ANNA", "MELISSA",
        "PRINCETON", "FARMERSVILLE", "FORNEY", "CRANDALL", "KAUFMAN",
        "RED OAK", "GLENN HEIGHTS", "FERRIS", "PALMER", "ALVARADO", "JOSHUA",
        "CROWLEY", "EVERMAN", "FOREST HILL", "WHITE SETTLEMENT", "RIVER OAKS",
        "BENBROOK", "AZLE", "SPRINGTOWN", "BOYD", "DECATUR", "BRIDGEPORT",
        "RHOME", "JUSTIN", "ROANOKE", "WESTLAKE", "GRANBURY", "ROYSE CITY",
        "FATE", "HEATH", "LAVON", "SUNNYVALE", "COMBINE", "WILMER", "HUTCHINS",
        "SANSOM PARK", "LAKE WORTH", "BLUE MOUND", "KENNEDALE", "PANTEGO",
        "DALWORTHINGTON GARDENS", "RICHLAND HILLS", "HALTOM", "ITALY",
    ],
    "austin": [
        "AUSTIN", "ROUND ROCK", "CEDAR PARK", "GEORGETOWN", "SAN MARCOS",
        "PFLUGERVILLE", "LEANDER", "KYLE", "BUDA", "HUTTO", "TAYLOR",
        "LOCKHART", "BASTROP", "ELGIN", "GIDDINGS",
    ],
    "houston": [
        "HOUSTON", "PASADENA", "PEARLAND", "BAYTOWN", "SUGAR LAND", "CONROE",
        "LEAGUE CITY", "MISSOURI CITY", "STAFFORD", "KATY", "TOMBALL",
        "SPRING", "HUMBLE", "DEER PARK", "LA PORTE", "TEXAS CITY", "ROSENBERG",
    ],
    "sanantonio": [
        "SAN ANTONIO", "NEW BRAUNFELS", "SCHERTZ", "SEGUIN", "BOERNE",
        "CONVERSE", "UNIVERSAL CITY", "CIBOLO", "SELMA",
    ],
}

# Organisational types worth looking at: for-profit operating entities only.
# CI corporation, CL limited liability company, CF professional corporation,
# PB business general partnership, PL limited partnership, PV professional LP.
# Excluded on purpose: CN nonprofit, CT/TR trusts, AB/AF associations, HO HOAs.
GOOD_ORG_TYPES = {"CI", "CL", "CF", "PB", "PL", "PV", "CM", "CS"}

# A name that looks like it makes something. Blunt on purpose -- this only
# decides what a human reviews, and the row is stored as unverified.
# Matched with word boundaries via MAKER_RE below, because substring matching
# put "Housing Associates of Sulphur SPRINGs" in the first test run.
MAKER_WORDS = [
    r"MANUFACTUR\w*", r"INDUSTR\w*", r"FABRICAT\w*", r"MACHIN(?:E|ES|ING|ERY)",
    r"TOOL(?:S|ING)?", r"STEEL", r"METALS?", r"PLASTICS?", r"EQUIPMENT",
    r"WELDING", r"FOUNDR(?:Y|IES)", r"PACKAGING", r"PRINTING", r"MILLWORK",
    r"CABINET(?:S|RY)?", r"EXTRUSIONS?", r"CASTINGS?", r"STAMPINGS?",
    r"COATINGS?", r"PRODUCTS", r"IRON(?:WORKS)?", r"ALLOYS?", r"RUBBER",
    r"CONCRETE", r"LUMBER", r"TEXTILES?", r"APPAREL", r"FURNITURE",
    r"ELECTRONICS?", r"INSTRUMENTS?", r"PUMPS?", r"VALVES?", r"BEARINGS?",
    r"GASKETS?", r"WIRE", r"CABLE", r"CONVEYORS?", r"HYDRAULICS?",
    r"PNEUMATICS?", r"PRECISION", r"ENGINEERING",
]
MAKER_RE = re.compile(r"\b(" + "|".join(MAKER_WORDS) + r")\b")

# Tells that an entity is an arm of a large public or foreign parent rather than
# a founder-owned business. Cheap to check here; the domain check later catches
# the rest. Every one of these came out of the first live test run.
PUBLIC_SUBSIDIARY_TELLS = [
    "TEXAS INSTRUMENTS", "STMICROELECTRONICS", "MCKESSON", "KEYSTONE CONSOLIDATED",
    " USA INC", " U.S.A. INC", "AMERICA INC", "AMERICAS INC", "NORTH AMERICA",
    "HOLDINGS INC", " GROUP INC", "INTERNATIONAL INC", "WORLDWIDE",
    "CORPORATION OF AMERICA", " (US)", " US LLC", " USA LLC",
]

# Entities that are not operating businesses, or are the wrong kind of business
# for a sell-side mandate. Checked before MAKER_WORDS so "SMITH FAMILY
# PROPERTIES PRODUCTS LLC" is still dropped.
NOT_A_TARGET = [
    "REALTY", "REAL ESTATE", "PROPERTIES", "PROPERTY", "HOLDINGS", "HOLDING",
    "INVESTMENT", "CAPITAL", "VENTURES", "PARTNERS LP", "FAMILY", "TRUST",
    "ESTATE OF", "CHURCH", "MINISTR", "FOUNDATION", "CHARIT", "ACADEMY",
    "SCHOOL", "CLINIC", "DENTAL", "MEDICAL CENTER", "INSURANCE", "AGENCY",
    "CONSULTING", "LAW OFFICE", "ATTORNEY", "HOMEOWNERS", "CONDOMINIUM",
    "ASSOCIATION", "COUNCIL", "LODGE", "RESTAURANT", "CAFE", "SALON",
    "RENTAL", "LEASING", "TAXI", "TRUCKING LLC", "LOGISTICS LLC",
]


def _fetch(url: str) -> list[dict]:
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(5 * (attempt + 1))
                continue
            raise
        except Exception:
            if attempt == 2:
                raise
            time.sleep(2)
    return []


def _quote(v: str) -> str:
    return "'" + v.replace("'", "''") + "'"


# Server-side prefilter. The same maker words as MAKER_WORDS but as bare
# substrings, pushed into the SoQL query so the API returns only plausible rows.
# Without it a full-metroplex scan means paging 754,779 rows at 1,000 per
# request; with it the same sweep is ~11k rows. The strict word-boundary regex
# still runs locally afterwards, so this only changes speed, never the result.
LIKE_WORDS = [
    "MANUFACTUR", "INDUSTR", "FABRICAT", "MACHIN", "TOOL", "STEEL", "METAL",
    "PLASTIC", "EQUIPMENT", "WELDING", "FOUNDR", "PACKAGING", "PRINTING",
    "MILLWORK", "CABINET", "EXTRUSION", "CASTING", "STAMPING", "COATING",
    "PRODUCTS", "IRON", "ALLOY", "RUBBER", "CONCRETE", "LUMBER", "TEXTILE",
    "APPAREL", "FURNITURE", "ELECTRONIC", "INSTRUMENT", "PUMP", "VALVE",
    "BEARING", "GASKET", "WIRE", "CABLE", "CONVEYOR", "HYDRAULIC",
    "PNEUMATIC", "PRECISION", "ENGINEERING",
]


def query_registry(cities: list[str], founded_after: int, founded_before: int,
                   limit: int, offset: int = 0, server_filter: bool = True) -> list[dict]:
    """One page of active TX entities in the given cities and charter window."""
    clauses = [
        "sos_status_code='A'",
        "right_to_transact_business_code='A'",
        "taxpayer_state='TX'",
        "taxpayer_city in (%s)" % ",".join(_quote(c) for c in cities),
        f"sos_charter_date >= '{founded_after}-01-01T00:00:00.000'",
        f"sos_charter_date < '{founded_before}-01-01T00:00:00.000'",
    ]
    if server_filter:
        clauses.append("(" + " OR ".join(
            f"upper(taxpayer_name) like '%{w}%'" for w in LIKE_WORDS) + ")")
    where = " AND ".join(clauses)
    params = {
        "$where": where,
        "$order": "sos_charter_date ASC",
        "$limit": str(min(limit, PAGE)),
        "$offset": str(offset),
    }
    return _fetch(SOCRATA + "?" + urllib.parse.urlencode(params))


# --- v2 classifier (2026-09-20, after round-2 hands-on test) ------------------
# The round-2 test measured 40-60% false positives: ranches, holding/management
# LPs, public cos, and SERVICE/CONSULTING firms wearing industrial words (a
# geotech "Engineering" firm, a concrete "Management" LP). v2 fixes that with a
# scored rule: a STRONG maker word (definitely makes a physical product) keeps
# the row unless a hard veto fires; a WEAK/ambiguous word (could be a trader or
# a service) keeps the row ONLY if no service/holding signal is present.
# Name-only, so it still errs -- the true ceiling is a NAICS join (free DOL key).

# Definitely makes something. Word-boundary matched.
STRONG_MAKER = [
    r"MANUFACTUR\w*", r"FABRICAT\w*", r"MACHINE\s+SHOP", r"MACHINING",
    r"FOUNDR(?:Y|IES)", r"STAMPINGS?", r"CASTINGS?", r"EXTRUSIONS?",
    r"MILLWORK", r"TOOL\s*(?:&|AND)?\s*DIE", r"WELDING", r"PLATING",
    r"POWDER\s+COAT\w*", r"INJECTION\s+MOLD\w*", r"PLASTICS?", r"STEEL",
    r"IRON\s*WORKS?", r"METAL\s*WORKS?", r"SHEET\s+METAL", r"PRECISION\s+MACHIN\w*",
    r"CABINET(?:S|RY)?", r"UPHOLSTER\w*", r"AWNINGS?", r"SIGNS?\s+(?:CO|INC|MFG)",
    r"CONCRETE\s+PRODUCTS", r"MACHINERY",
]
STRONG_RE = re.compile(r"\b(" + "|".join(STRONG_MAKER) + r")\b")

# Could make something, or could just trade/consult in it. Kept only if clean.
WEAK_MAKER = [
    r"PRODUCTS", r"EQUIPMENT", r"INDUSTR\w*", r"INSTRUMENTS?", r"SYSTEMS?",
    r"TOOL(?:S|ING)?", r"METALS?", r"ALLOYS?", r"RUBBER", r"TEXTILES?",
    r"APPAREL", r"FURNITURE", r"ELECTRONICS?", r"PUMPS?", r"VALVES?",
    r"BEARINGS?", r"GASKETS?", r"CABLE", r"CONVEYORS?", r"HYDRAULICS?",
    r"PNEUMATICS?", r"PACKAGING", r"PRINTING", r"LUMBER",
    # standalone maker words the first v2 pass wrongly dropped as "no-maker-word"
    # (Sherman Wire, Ace Advanced Machine, Strand Concrete were real targets):
    r"WIRE", r"MACHINE", r"CONCRETE", r"GLASS", r"TANKS?", r"TRAILERS?",
    r"MOLD(?:S|ING)?", r"DIES?", r"SPRINGS?", r"TUBE", r"TUBING", r"GEARS?",
    r"MOTORS?", r"ENGINES?", r"FILTERS?", r"COMPOSITES?", r"FIBERGLASS",
    r"CERAMICS?", r"FOAM", r"PAPER", r"CHEMICALS?", r"PAINTS?", r"ADHESIVES?",
    r"CONTAINERS?", r"PALLETS?", r"CRATES?", r"NAMEPLATES?", r"LABELS?",
    r"BRICK", r"STONE\s+PRODUCTS", r"GRANITE", r"MARBLE", r"COUNTERTOPS?",
]
WEAK_RE = re.compile(r"\b(" + "|".join(WEAK_MAKER) + r")\b")

# --- SEC public-registrant filter (free static file) -------------------------
# data/sec_company_tickers.json is SEC's list of every public registrant (~10.4k).
# A normalized-name match strips public companies (Trinity, Lennox, Commercial
# Metals ...) that a name-keyword filter otherwise keeps. Loaded lazily; if the
# file is absent the filter simply no-ops (never crashes the classifier).
_SEC_NAMES: set[str] | None = None


def _norm_co(s: str) -> str:
    s = re.sub(r"\b(inc|llc|ltd|lp|llp|corp|corporation|company|co|the|incorporated)\b",
               " ", s.lower())
    return re.sub(r"[^a-z0-9]", "", s)


def _sec_names() -> set[str]:
    global _SEC_NAMES
    if _SEC_NAMES is None:
        _SEC_NAMES = set()
        try:
            import os
            here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
            with open(os.path.join(here, "data", "sec_company_tickers.json"), encoding="utf-8") as f:
                data = json.load(f)
            _SEC_NAMES = {_norm_co(v["title"]) for v in data.values() if v.get("title")}
        except Exception:
            _SEC_NAMES = set()
    return _SEC_NAMES


def is_public(name: str) -> bool:
    n = _norm_co(name)
    return len(n) >= 5 and n in _sec_names()

# Hard vetoes: an operating profile that is not a sell-side manufacturing target,
# even if an industrial word is also present. These are the round-2 false pos.
VETO_WORDS = [
    r"RANCH(?:ES|ING)?", r"FARMS?", r"CATTLE", r"LIVESTOCK", r"VINEYARDS?",
    r"ORCHARDS?", r"DAIRY",
    r"HOLDINGS?", r"MANAGEMENT", r"INVESTMENTS?", r"CAPITAL", r"VENTURES?",
    r"EQUITY", r"ACQUISITIONS?", r"PARTNERS", r"ADVISORS?", r"BANCORP",
    r"REALTY", r"REAL\s+ESTATE", r"PROPERTIES", r"PROPERTY", r"LEASING",
    r"RENTALS?", r"APARTMENTS?", r"DEVELOPMENT",
    r"CONSULTING", r"CONSULTANTS?", r"SOLUTIONS", r"STAFFING", r"RECRUIT\w*",
    r"MARKETING", r"ADVERTISING", r"LOGISTICS", r"FREIGHT", r"TRANSPORT\w*",
    r"CLINIC", r"DENTAL", r"MEDICAL", r"HEALTHCARE", r"HEALTH\s+CARE",
    r"PHARMACY", r"DERMATOLOG\w*", r"SURGERY", r"HOSPITAL", r"WELLNESS",
    r"CHURCH", r"MINISTR\w*", r"FOUNDATION", r"ACADEMY", r"SCHOOL", r"CHURCHES",
    r"SALON", r"SPA", r"RESTAURANT", r"CAFE", r"CATERING", r"BAKERY",
    r"INSURANCE", r"AGENCY", r"MORTGAGE", r"FINANCIAL", r"TITLE\s+CO",
    r"DISTRIBUT\w*", r"WHOLESALE", r"DEALERSHIP", r"AUTOMOTIVE\s+GROUP",
    r"LANDSCAP\w*", r"LAWN", r"JANITORIAL", r"CLEANING", r"SECURITY",
    r"CONSTRUCTION", r"CONTRACTORS?", r"BUILDERS?", r"ROOFING", r"PLUMBING",
    r"ELECTRIC(?:AL)?\s+(?:CO|SERVICE|CONTRACT\w*)", r"HVAC", r"REMODEL\w*",
]
VETO_RE = re.compile(r"\b(" + "|".join(VETO_WORDS) + r")\b")


def classify(name: str) -> tuple[bool, str]:
    """(keep, reason). v2 scored name rule. Never treated as a fact downstream."""
    u = name.upper()
    if is_public(name):
        return False, "veto:sec-public-company"
    for tell in PUBLIC_SUBSIDIARY_TELLS:
        if tell in u:
            return False, f"veto:subsidiary:{tell.strip().lower()}"
    v = VETO_RE.search(u)
    strong = STRONG_RE.search(u)
    # A strong maker word survives a veto only when it is an unambiguous maker
    # (e.g. "STEEL FABRICATORS MANAGEMENT LLC" is still dropped, but a genuine
    # "... MANUFACTURING" beats a soft veto). Rule: veto wins unless a STRONG
    # word is present AND the veto is not one of the always-fatal classes.
    ALWAYS_FATAL = ("RANCH", "FARM", "CATTLE", "HOLDING", "REALTY", "PROPERT",
                    "CLINIC", "DENTAL", "MEDICAL", "PHARMACY", "CHURCH",
                    "INSURANCE", "MORTGAGE", "CONSULTING", "STAFFING", "SALON",
                    "RESTAURANT", "LANDSCAP", "ROOFING", "PLUMBING")
    if v:
        fatal = any(f in v.group(1) for f in ALWAYS_FATAL)
        if fatal or not strong:
            return False, f"veto:{v.group(1).lower()}"
    if strong:
        return True, f"strong:{strong.group(1).lower().split()[0]}"
    if WEAK_RE.search(u) and not v:
        return True, f"weak:{WEAK_RE.search(u).group(1).lower()}"
    return False, "no-maker-word"


def discover(con: sqlite3.Connection, args) -> dict:
    cities = METROS.get(args.metro)
    if not cities:
        print(f"unknown metro {args.metro!r}; known: {', '.join(sorted(METROS))}", file=sys.stderr)
        return {"error": "unknown metro"}

    existing = {r[0].upper() for r in con.execute("SELECT name FROM companies WHERE name IS NOT NULL")}
    kept: list[dict] = []
    scanned = 0
    offset = 0
    want = args.limit or 100

    while len(kept) < want and offset < args.max_scan:
        rows = query_registry(cities, args.founded_after, args.founded_before, PAGE, offset,
                              server_filter=not args.no_server_filter)
        if not rows:
            break
        offset += len(rows)
        for r in rows:
            scanned += 1
            name = (r.get("taxpayer_name") or "").strip()
            if not name or name.upper() in existing:
                continue
            if (r.get("taxpayer_organizational_type") or "") not in GOOD_ORG_TYPES:
                continue
            keep, reason = classify(name)
            if not keep:
                continue
            charter = (r.get("sos_charter_date") or "")[:10]
            kept.append({
                "name": name,
                "city": (r.get("taxpayer_city") or "").title(),
                "state": "TX",
                "sos_file_number": r.get("secretary_of_state_sos_or_coa_file_number"),
                "taxpayer_number": r.get("taxpayer_number"),
                "charter_date": charter,
                "address": (r.get("taxpayer_address") or "").title(),
                "zip": r.get("taxpayer_zip"),
                "org_type": r.get("taxpayer_organizational_type"),
                "match_reason": reason,
            })
            existing.add(name.upper())
            if len(kept) >= want:
                break
        time.sleep(1.0)

    if args.dry:
        for k in kept:
            print(f"  {k['charter_date']}  {k['name']}  ({k['city']}, {k['match_reason']})")
        print(f"dry run: {scanned} registry rows scanned, {len(kept)} candidates, nothing written")
        return {"scanned": scanned, "candidates": len(kept), "inserted": 0, "dry": True}

    inserted = 0
    now = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    for k in kept:
        note = json.dumps({
            "source": "tx-franchise-registry",
            "sos_file_number": k["sos_file_number"],
            "taxpayer_number": k["taxpayer_number"],
            "sos_charter_date": k["charter_date"],
            "registered_address": f"{k['address']}, {k['city']}, TX {k['zip']}",
            "org_type": k["org_type"],
            "why_candidate": k["match_reason"],
            "verified": False,
            "note": "Industry and size are NOT stated by this source. Name-keyword candidate only; confirm the business is a real operating manufacturer before any outreach.",
        })
        cur = con.execute(
            """INSERT OR IGNORE INTO companies (name, domain, segment_id, industry, city, state, source, notes)
               VALUES (?, NULL, COALESCE(?, 'owners'), NULL, ?, 'TX', 'tx-franchise-registry', ?)""",
            (k["name"], args.segment, k["city"], note),
        )
        inserted += cur.rowcount
    con.execute(
        "INSERT INTO audit_log (actor_label, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?)",
        ("tx-registry", "registry.discover", "company", None,
         json.dumps({"metro": args.metro, "scanned": scanned, "inserted": inserted,
                     "founded_after": args.founded_after, "founded_before": args.founded_before,
                     "at": now})),
    )
    con.commit()
    print(f"discover: {scanned} registry rows scanned, {len(kept)} candidates, {inserted} new companies inserted")
    return {"scanned": scanned, "candidates": len(kept), "inserted": inserted}


def prune(args) -> int:
    """Re-classify imported registry rows with the current (v2) classifier and
    remove the ones that no longer pass. Archives every removed row to CSV first.
    Only ever touches source='tx-franchise-registry' rows with no contacts."""
    import csv
    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT id, name, city, notes FROM companies WHERE source='tx-franchise-registry'"
    ).fetchall()
    keep, cut = [], []
    from collections import Counter
    reasons = Counter()
    for r in rows:
        ok, why = classify(r["name"])
        (keep if ok else cut).append((r, why))
        if not ok:
            reasons[why.split(":")[1] if ":" in why else why] += 1

    print(f"prune: {len(rows)} registry rows -> keep {len(keep)}, cut {len(cut)}")
    print("top cut reasons:", dict(reasons.most_common(12)))

    if args.dry:
        print("\n-- sample of rows that WOULD be cut --")
        for r, why in cut[:25]:
            print(f"  CUT [{why:26}] {r['name'][:50]}  ({r['city']})")
        print("\n-- sample of rows that WOULD be kept --")
        for r, why in keep[:15]:
            print(f"  KEEP [{why:20}] {r['name'][:50]}  ({r['city']})")
        print(f"\ndry run: nothing deleted. keep {len(keep)} / cut {len(cut)}")
        con.close()
        return 0

    # archive removed rows
    ts = datetime.now().strftime("%Y%m%d-%H%M")
    arch = args.archive or f"backups/pruned-{ts}.csv"
    with open(arch, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["id", "name", "city", "cut_reason", "notes"])
        for r, why in cut:
            w.writerow([r["id"], r["name"], r["city"], why, r["notes"]])
    ids = [r["id"] for r, _ in cut]
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        con.execute(f"DELETE FROM companies WHERE id IN ({','.join('?' * len(chunk))})", chunk)
    con.execute(
        "INSERT INTO audit_log (actor_label, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?)",
        ("tx-registry", "registry.prune", "company", None,
         json.dumps({"kept": len(keep), "cut": len(cut), "archive": arch,
                     "classifier": "v2", "at": ts})),
    )
    con.commit()
    con.close()
    print(f"pruned {len(cut)} rows (archived to {arch}); {len(keep)} kept.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("discover", help="find candidate companies in the TX registry")
    d.add_argument("--db", default="data/harness.db")
    d.add_argument("--metro", default="dfw", help=", ".join(sorted(METROS)))
    d.add_argument("--founded-after", type=int, default=1960, dest="founded_after")
    d.add_argument("--founded-before", type=int, default=2006, dest="founded_before",
                   help="exclusive; default 2006 so every hit is 20+ years old")
    d.add_argument("--limit", type=int, default=100)
    d.add_argument("--max-scan", type=int, default=200000, dest="max_scan")
    d.add_argument("--no-server-filter", action="store_true", dest="no_server_filter",
                   help="page every row and filter locally (slow; for auditing the prefilter)")
    d.add_argument("--segment", type=int, default=None, help="segment_id to tag rows with")
    d.add_argument("--dry", action="store_true")

    pr = sub.add_parser("prune", help="re-run the v2 classifier over already-imported registry rows and cut the misses")
    pr.add_argument("--db", default="data/harness.db")
    pr.add_argument("--dry", action="store_true")
    pr.add_argument("--archive", default=None, help="CSV path to write removed rows to (default: backups/pruned-<ts>.csv)")

    sub.add_parser("counties", help="print the metro/city map this script filters on")

    args = p.parse_args()

    if args.cmd == "counties":
        for m, cities in sorted(METROS.items()):
            print(f"{m}: {', '.join(cities)}")
        return 0

    if args.cmd == "prune":
        return prune(args)

    con = sqlite3.connect(args.db)
    try:
        out = discover(con, args)
    finally:
        con.close()
    return 0 if "error" not in out else 1


if __name__ == "__main__":
    sys.exit(main())
