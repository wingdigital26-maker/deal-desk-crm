#!/usr/bin/env python3
"""
profile_enrich.py - build the banker's owner + business profile for a company
from free public sources, one sourced fact at a time.

Stdlib only (urllib, json, sqlite3, re, html, robotparser, argparse, time) plus
the parsers already proven in email_finder.py. No API key, no paid API, no LLM
call, no login, no Apollo call, and NO SMTP. Writes into the harness's own
SQLite database (table profile_facts, defined in app/lib/db.ts).

WHAT A FACT IS
--------------
Every row in profile_facts is ONE field of ONE company with the URL it came
from, the date it was fetched, a confidence, and the basis for the match.
Nothing is written without a source URL. A blank never overwrites a sourced
value, and an unconfirmed value never overwrites a confirmed one. Running the
script twice writes the same rows (idempotent upsert on entity/field/value_key).

MATCH DISCIPLINE (the lesson of the 46 false SEC attributions)
-------------------------------------------------------------
A fact is "confirmed" only when it is tied to the company by one of:
  domain     it was printed on the company's own website (the domain on file,
             or one whose homepage names the company AND whose pages name the
             company's city)
  registry   it came from the Texas registry row whose file number is on file,
             or whose normalised name matches AND whose city matches
  city+state a news item that names the company AND its city or state
Anything tied by name alone is stored as "unconfirmed" (the UI labels it) or
dropped. A name-only match is never written as a confirmed fact.

SOURCES
-------
  Company website   homepage + About / History / Team / Leadership / News /
                    Careers / Quality / Industries pages found in its own nav.
                    schema.org Organization / Person JSON-LD is parsed too.
                    robots.txt is fetched and obeyed for every host.
  TX Comptroller    Active Franchise Tax Permit Holders (data.texas.gov
                    9cir-efmm, Socrata, public, no key): legal name, formation
                    (SOS charter) date, entity type, SOS file number, registered
                    address, NAICS where the state recorded one.
  GDELT DOC API     recent news (rolling ~3 months), 1 request per 5 seconds.
                    Fails soft; GDELT rate-limits shared IPs hard.

NOT USED, ON PURPOSE
--------------------
  Google News RSS   news.google.com/robots.txt disallows /rss for every user
                    agent, so this script does not fetch it. (harness_signals.py
                    still does; that is flagged for the main session.)
  Comptroller franchise-tax search (officers, registered agent): the page is
                    robots-disallowed and captcha-gated. SOSDirect is paid.
  LinkedIn, ZoomInfo, Apollo, D&B: logins, paywalls, or terms-gated.

Usage:
  python scrapers/profile_enrich.py run --db data/harness.db --scope contacts
  python scrapers/profile_enrich.py run --db data/harness.db --scope registry --limit 50
  python scrapers/profile_enrich.py run --db data/harness.db --company-id 20 --dry
  python scrapers/profile_enrich.py parse --html page.html --url https://x.com/about --company "X Co"
  python scrapers/profile_enrich.py fill-rates --db data/harness.db --scope all
  (a bare flag list with no subcommand means "run")
"""

import argparse
import html as htmllib
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import urllib.robotparser
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import email_finder as ef  # noqa: E402  (reuse the proven people parser + domain resolver)

UA = "Mozilla/5.0 (compatible; banker-harness-profile/1.0; research tool; contact: you@example.com)"
TIMEOUT = 12
READ_DEADLINE = 25
MAX_PAGES = 8
SOCRATA = "https://data.texas.gov/resource/9cir-efmm.json"
GDELT = "https://api.gdeltproject.org/api/v2/doc/doc"
THIS_YEAR = datetime.now().year

# ---------------------------------------------------------------------------
# Schema. Identical DDL lives in app/lib/db.ts; this copy only exists so the
# script (and its tests) can run against a database the app has not opened yet.
# ---------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS profile_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL CHECK (entity IN ('company','contact')),
  entity_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  value_key TEXT NOT NULL DEFAULT '',
  source_url TEXT NOT NULL,
  source_label TEXT,
  confidence TEXT NOT NULL DEFAULT 'confirmed' CHECK (confidence IN ('confirmed','unconfirmed')),
  match_basis TEXT,
  note TEXT,
  observed_at TEXT,
  fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS profile_facts_key ON profile_facts(entity, entity_id, field, value_key);
CREATE INDEX IF NOT EXISTS profile_facts_entity ON profile_facts(entity, entity_id);
"""

# Fields that hold a list (one row per value). Everything else holds one value.
MULTI_FIELDS = {
    "locations", "end_markets", "certifications", "leaders", "owner_other_roles",
    "owner_press", "signal_news", "signal_award", "signal_expansion",
    "signal_facility", "signal_hiring", "signal_ownership", "ownership_event",
}
CONF_RANK = {"unconfirmed": 1, "confirmed": 2}


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def ensure_schema(con: sqlite3.Connection) -> None:
    con.executescript(SCHEMA)
    cols = {r[1] for r in con.execute("PRAGMA table_info(companies)")}
    if cols and "profile_refreshed_at" not in cols:
        con.execute("ALTER TABLE companies ADD COLUMN profile_refreshed_at TEXT")


def value_key(field: str, value: str) -> str:
    if field not in MULTI_FIELDS:
        return ""
    return re.sub(r"[^a-z0-9]+", "", value.lower())[:120]


def upsert_fact(con: sqlite3.Connection, fact: dict, fetched_at: str | None = None) -> str:
    """Write one fact. Returns 'insert', 'update', 'same' or a 'skip:<why>' code.

    Rules, in order:
      - no source_url            -> skip (nothing without a source)
      - blank value              -> skip (a blank never overwrites anything)
      - existing row outranks it -> skip (unconfirmed never beats confirmed)
    """
    value = (fact.get("value") or "").strip() if isinstance(fact.get("value"), str) else fact.get("value")
    if value is None or (isinstance(value, str) and not value):
        return "skip:blank"
    value = str(value)
    src = (fact.get("source_url") or "").strip()
    if not src.startswith(("http://", "https://")):
        return "skip:no-source"
    conf = fact.get("confidence") or "confirmed"
    if conf not in CONF_RANK:
        return "skip:bad-confidence"
    entity = fact.get("entity") or "company"
    field = fact["field"]
    key = value_key(field, value)
    if field in MULTI_FIELDS and not key:
        return "skip:blank"
    fetched = fetched_at or fact.get("fetched_at") or now_iso()
    row = con.execute(
        "SELECT id, value, confidence FROM profile_facts WHERE entity=? AND entity_id=? AND field=? AND value_key=?",
        (entity, fact["entity_id"], field, key),
    ).fetchone()
    if row:
        if CONF_RANK[row[2]] > CONF_RANK[conf]:
            return "skip:lower-confidence"
        if row[1] == value and row[2] == conf:
            con.execute("UPDATE profile_facts SET fetched_at=? WHERE id=?", (fetched, row[0]))
            return "same"
        con.execute(
            """UPDATE profile_facts SET value=?, source_url=?, source_label=?, confidence=?, match_basis=?,
                      note=?, observed_at=?, fetched_at=? WHERE id=?""",
            (value, src, fact.get("source_label"), conf, fact.get("match_basis"), fact.get("note"),
             fact.get("observed_at"), fetched, row[0]),
        )
        return "update"
    con.execute(
        """INSERT INTO profile_facts (entity, entity_id, field, value, value_key, source_url, source_label,
                                      confidence, match_basis, note, observed_at, fetched_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (entity, fact["entity_id"], field, value, key, src, fact.get("source_label"), conf,
         fact.get("match_basis"), fact.get("note"), fact.get("observed_at"), fetched),
    )
    return "insert"


# ---------------------------------------------------------------------------
# Polite fetching: robots.txt obeyed per host, 1 request/second per host.
# ---------------------------------------------------------------------------
_last_hit: dict[str, float] = {}
_robots: dict[str, urllib.robotparser.RobotFileParser | None] = {}
FETCH_LOG: list[dict] = []


def _throttle(host: str, gap: float) -> None:
    wait = gap - (time.monotonic() - _last_hit.get(host, 0.0))
    if wait > 0:
        time.sleep(wait)
    _last_hit[host] = time.monotonic()


def _raw_get(url: str, gap: float = 1.0, accept: str = "text/html,application/xhtml+xml") -> tuple[int, str, str]:
    """(status, final_url, body). Never raises."""
    host = urllib.parse.urlparse(url).netloc
    _throttle(host, gap)
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept, "Accept-Language": "en-US,en;q=0.9"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            ctype = r.headers.get("Content-Type", "")
            if accept.startswith("text/html") and "html" not in ctype and "text" not in ctype:
                return r.status, r.geturl(), ""
            # the socket timeout is per read, so a server that drips bytes could hold us for
            # minutes (one did, for 25 minutes); cap the whole body at READ_DEADLINE seconds
            start, chunks, size = time.monotonic(), [], 0
            while size < 1_500_000 and time.monotonic() - start < READ_DEADLINE:
                chunk = r.read(65536)
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
            return r.status, r.geturl(), b"".join(chunks).decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, url, ""
    except Exception:
        return 0, url, ""


def robots_allows(url: str) -> bool:
    p = urllib.parse.urlparse(url)
    base = f"{p.scheme}://{p.netloc}"
    if base not in _robots:
        status, _, body = _raw_get(base + "/robots.txt", accept="text/plain")
        if status in (401, 403):
            _robots[base] = None  # standard: an auth-walled robots.txt means stay out
        else:
            rp = urllib.robotparser.RobotFileParser()
            rp.parse(body.splitlines() if status == 200 else [])
            _robots[base] = rp
    rp = _robots[base]
    if rp is None:
        return False
    return rp.can_fetch(UA, url) and rp.can_fetch("banker-harness-profile", url)


def polite_get(url: str, gap: float = 1.0, accept: str = "text/html,application/xhtml+xml") -> tuple[str, str]:
    """(final_url, body) or (url, '') when robots says no or the fetch fails."""
    if not robots_allows(url):
        FETCH_LOG.append({"url": url, "status": "robots-disallowed"})
        return url, ""
    status, final, body = _raw_get(url, gap=gap, accept=accept)
    FETCH_LOG.append({"url": url, "status": status})
    if status != 200 or not body:
        return final, ""
    if not robots_allows(final):  # a redirect can land somewhere robots forbids
        return final, ""
    return final, body


# ---------------------------------------------------------------------------
# Pure parsers. Every one takes a string and returns plain data, so the tests
# can run them on fixture HTML with no network.
# ---------------------------------------------------------------------------

def norm_name(s: str) -> str:
    s = re.sub(r"\b(inc|llc|l\.l\.c|ltd|lp|l\.p|llp|corp|corporation|company|co|the|incorporated|pllc|pc)\b\.?",
               " ", (s or "").lower())
    return re.sub(r"[^a-z0-9]", "", s)


GENERIC_WORDS = {
    "manufacturing", "mfg", "products", "product", "industries", "industrial", "company", "group",
    "services", "service", "solutions", "systems", "international", "enterprises", "holdings",
    "texas", "usa", "america", "american", "national", "north", "south", "the",
}


def core_tokens(name: str) -> list[str]:
    toks = re.findall(r"[a-z0-9]+", norm_name_spaced(name))
    return [t for t in toks if t not in GENERIC_WORDS]


def norm_name_spaced(s: str) -> str:
    s = re.sub(r"\b(inc|llc|ltd|lp|llp|corp|corporation|company|co|the|incorporated)\b\.?", " ", (s or "").lower())
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def visible_text(body: str) -> str:
    t = re.sub(r"(?is)<(script|style|noscript|svg|template)[^>]*>.*?</\1>", " ", body)
    t = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr|section|article|header|footer)>", "\n", t)
    t = re.sub(r"<[^>]+>", " ", t)
    t = htmllib.unescape(t)
    lines = [re.sub(r"[ \t\r\f\v\xa0]+", " ", ln).strip() for ln in t.split("\n")]
    return "\n".join(ln for ln in lines if ln)


SHORTCODE = re.compile(r"\[/?[a-z_][a-z0-9_]*(?:\s[^\]]{0,300})?\]", re.I)  # WordPress page-builder tags


def paragraphs(body: str) -> list[str]:
    out = []
    for m in re.finditer(r"(?is)<p[^>]*>(.*?)</p>", body):
        t = SHORTCODE.sub(" ", htmllib.unescape(re.sub(r"<[^>]+>", " ", m.group(1))))
        t = re.sub(r"\s+", " ", t).strip()
        # a "paragraph" that swallowed the site menu is navigation, not prose
        if t and len(NAV_JUNK.findall(t)) < 2:
            out.append(t)
    return out


NAV_JUNK = re.compile(r"\b(?:Menu|Contact Us|About Us|Learn More|Buy Now|Follow us|Read More|Skip to content|Request a Quote)\b", re.I)


def meta_content(body: str, key: str) -> str | None:
    for pat in (rf'<meta[^>]+(?:name|property)=["\']{re.escape(key)}["\'][^>]*content=["\']([^"\']*)["\']',
                rf'<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:name|property)=["\']{re.escape(key)}["\']'):
        m = re.search(pat, body, re.I)
        if m:
            v = htmllib.unescape(m.group(1)).strip()
            if v:
                return v
    return None


def parse_jsonld(body: str) -> list[dict]:
    """Every JSON-LD object on the page, @graph flattened. Bad JSON is skipped."""
    out: list[dict] = []
    for m in re.finditer(r'(?is)<script[^>]+type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', body):
        raw = m.group(1).strip()
        try:
            data = json.loads(raw)
        except Exception:
            try:
                data = json.loads(re.sub(r",\s*([}\]])", r"\1", raw))
            except Exception:
                continue
        stack = data if isinstance(data, list) else [data]
        while stack:
            d = stack.pop(0)
            if not isinstance(d, dict):
                continue
            if isinstance(d.get("@graph"), list):
                stack.extend(d["@graph"])
            out.append(d)
    return out


ORG_TYPES = {"organization", "corporation", "localbusiness", "manufacturer", "professionalservice",
             "homeandconstructionbusiness", "store", "foodestablishment", "medicalorganization"}


def _types(d: dict) -> set[str]:
    t = d.get("@type")
    t = t if isinstance(t, list) else [t]
    return {str(x).lower() for x in t if x}


def _addr_str(a) -> str | None:
    if isinstance(a, list):
        a = a[0] if a else None
    if isinstance(a, str):
        return a.strip() or None
    if not isinstance(a, dict):
        return None
    parts = [a.get("streetAddress"), a.get("addressLocality"),
             " ".join(x for x in [a.get("addressRegion"), a.get("postalCode")] if x)]
    s = ", ".join(str(p).strip() for p in parts if p and str(p).strip())
    return s or None


def org_from_jsonld(objs: list[dict]) -> dict:
    """Organization facts: name, legal name, founding date, address, employees, founder, sameAs."""
    out: dict = {}
    for d in objs:
        if not (_types(d) & ORG_TYPES):
            continue
        for k_src, k_out in (("name", "name"), ("legalName", "legal_name"), ("description", "description")):
            if isinstance(d.get(k_src), str) and d[k_src].strip() and k_out not in out:
                out[k_out] = d[k_src].strip()
        fd = d.get("foundingDate")
        if isinstance(fd, (str, int)) and "founding_year" not in out:
            m = re.search(r"(1[89]\d\d|20\d\d)", str(fd))
            if m and 1850 <= int(m.group(1)) <= THIS_YEAR:
                out["founding_year"] = m.group(1)
        addr = _addr_str(d.get("address"))
        if addr and "address" not in out:
            out["address"] = addr
            a = d.get("address")
            a = a[0] if isinstance(a, list) and a else a
            if isinstance(a, dict) and a.get("addressLocality"):
                out["locality"] = f"{a.get('addressLocality')}, {a.get('addressRegion') or ''}".strip(", ")
        emp = d.get("numberOfEmployees")
        if isinstance(emp, dict):
            emp = emp.get("value") or emp.get("maxValue") or emp.get("minValue")
        if emp and "employees" not in out and re.fullmatch(r"\d{1,6}", str(emp)):
            out["employees"] = str(emp)
        f = d.get("founder") or d.get("founders")
        f = f[0] if isinstance(f, list) and f else f
        if isinstance(f, dict) and f.get("name") and "founder" not in out:
            out["founder"] = str(f["name"]).strip()
        elif isinstance(f, str) and f.strip() and "founder" not in out:
            out["founder"] = f.strip()
        same = d.get("sameAs")
        same = same if isinstance(same, list) else [same]
        for s in same:
            if isinstance(s, str) and "linkedin.com/company/" in s and "linkedin" not in out:
                out["linkedin"] = s.strip()
    return out


def people_from_jsonld(objs: list[dict]) -> list[dict]:
    out = []
    for d in objs:
        if "person" not in _types(d):
            continue
        nm = ef.clean_name(str(d.get("name") or ""))
        if not nm:
            continue
        out.append({"name": nm, "title": str(d.get("jobTitle") or "").strip() or None,
                    "linkedin": next((s for s in (d.get("sameAs") if isinstance(d.get("sameAs"), list) else [d.get("sameAs")])
                                      if isinstance(s, str) and "linkedin.com/in/" in s), None)})
    return out


YEAR = r"(1[89]\d\d|20[0-2]\d)"


def _ok_year(y: str) -> bool:
    return 1850 <= int(y) <= THIS_YEAR


def find_founded_year(text: str) -> tuple[str, str] | None:
    """(year, snippet) from the company's own words, or None."""
    pats = [
        rf"\b(?:founded|established|incorporated|started|organized)\s+(?:in\s+)?(?:the\s+year\s+)?{YEAR}\b",
        rf"\b(?:est\.?|estd\.?)\s*{YEAR}\b",
        rf"\b(?:in business|serving [\w ,&]{{0,40}}|family[- ]owned(?: and[- ]operated)?|operating|proudly [\w ]{{0,30}})\s+since\s+{YEAR}\b",
        rf"\bsince\s+{YEAR}\b",
    ]
    for i, pat in enumerate(pats):
        for m in re.finditer(pat, text, re.I):
            y = m.group(1)
            if not _ok_year(y):
                continue
            if i == 3:  # bare "since 1978": only as a short tagline line, never mid-sentence
                line = next((ln for ln in text.split("\n") if m.group(0) in ln), "")
                if len(line.split()) > 6:
                    continue
            return y, _snippet(text, m.start(), m.end())
    return None


def _snippet(text: str, a: int, b: int, pad: int = 90) -> str:
    s = text[max(0, a - pad): b + pad].replace("\n", " ")
    return re.sub(r"\s+", " ", s).strip()[:240]


def find_family_since(text: str) -> tuple[str, str] | None:
    m = re.search(rf"family[- ](?:owned|run|operated)(?:\s+and[- ](?:operated|owned))?(?:\s+(?:business|company))?\s+since\s+{YEAR}", text, re.I)
    if m and _ok_year(m.group(1)):
        return m.group(1), _snippet(text, m.start(), m.end())
    return None


def find_second_generation(text: str) -> str | None:
    m = re.search(r"\b(second|2nd|third|3rd|fourth|4th|next)[- ]generation\b", text, re.I)
    if m:
        return _snippet(text, m.start(), m.end())
    m = re.search(r"\b(?:his|her|their) (?:son|daughter|sons|daughters|grandson|granddaughter)\b[^.\n]{0,80}\b(?:joined|runs|leads|took over|president|vice president|operations)", text, re.I)
    if m:
        return _snippet(text, m.start(), m.end())
    return None


# Ownership language, strongest first. value -> (regex, poor_fit)
OWNERSHIP_PATTERNS: list[tuple[str, str]] = [
    ("public", r"\((?:NYSE|NASDAQ|Nasdaq|NYSE American)\s*:\s*[A-Z]{1,5}\)|\b(?:NYSE|NASDAQ)\s*:\s*[A-Z]{1,5}\b"),
    ("pe-backed", r"\b(?:a )?portfolio company of\s+[A-Z][\w&.' ]{2,60}"
                  r"|\b(?:backed by|investment from|recapitali[sz]ation (?:with|by)|partnered with|in partnership with)\s+"
                  r"[A-Z][\w&.' ]{0,50}?(?:Capital|Partners|Equity|Investments|Fund|Ventures)\b"),
    ("subsidiary", r"\ba (?:wholly[- ]owned )?(?:subsidiary|division) of\s+[A-Z][\w&.' ]{2,60}"
                   r"|\ba member of the\s+[A-Z][\w&.' ]{2,60}\s+family of companies"
                   r"|\ban?\s+[A-Z][\w&.]+(?:\s+[A-Z][\w&.]+){0,3}\s+(?:Industrials|Industries|Group|Holdings|Corporation)\s+company\b"),
    ("employee-owned", r"\bemployee[- ]owned\b|\bESOP\b"),
    ("family", r"\bfamily[- ](?:owned|run|operated)\b"),
]


def find_ownership(text: str) -> tuple[str, str] | None:
    for kind, pat in OWNERSHIP_PATTERNS:
        m = re.search(pat, text)
        if m:
            return kind, _snippet(text, m.start(), m.end())
    return None


CERTS: list[tuple[str, str]] = [
    ("ISO 9001", r"\bISO[\s-]*9001(?::?\s*20\d\d)?\b"),
    ("AS9100", r"\bAS[\s-]*9100[A-D]?\b"),
    ("ISO 13485", r"\bISO[\s-]*13485\b"),
    ("IATF 16949", r"\b(?:IATF|ISO/TS)[\s-]*16949\b"),
    ("ISO 14001", r"\bISO[\s-]*14001\b"),
    ("ISO 45001", r"\bISO[\s-]*45001\b"),
    ("ITAR registered", r"\bITAR\b"),
    ("Nadcap", r"\bNADCAP\b|\bNadcap\b"),
    ("API Q1", r"\bAPI\s*(?:Spec\s*)?Q1\b"),
    ("API monogram", r"\bAPI\s+(?:Spec\s+)?(?:6A|6D|5CT|5L|16C|16A|11B)\b|\bAPI monogram"),
    ("ASME stamp", r"\bASME\b[^.\n]{0,40}\b(?:stamp|U-stamp|Section VIII|certified|certification)|\b[UR]-stamp"),
    ("UL listed", r"\bUL[\s-]*(?:listed|508A|certified)\b"),
    ("CMMC", r"\bCMMC\b"),
    ("FDA registered", r"\bFDA[\s-]+(?:registered|registration|cleared|approved)\b"),
    ("SQF", r"\bSQF\b"),
    ("BRCGS", r"\bBRC(?:GS)?\b"),
    ("HACCP", r"\bHACCP\b"),
    ("cGMP", r"\bc?GMP\b"),
    ("AWS D1.1", r"\bAWS\s*D1\.[1-6]\b"),
    ("Woman-owned (WBENC / WOSB)", r"\bWBENC\b|\bWOSB\b|\bwoman[- ]owned\b|\bwomen[- ]owned\b"),
    ("Minority-owned (MBE)", r"\bminority[- ]owned\b|\bNMSDC\b"),
    ("HUBZone", r"\bHUBZone\b"),
    ("Veteran-owned (SDVOSB / VOSB)", r"\bSDVOSB\b|\bveteran[- ]owned\b"),
    ("Texas HUB", r"\bTexas HUB\b|\bHUB[- ]certified\b|\bHistorically Underutilized Business\b"),
]


def find_certifications(text: str) -> list[tuple[str, str]]:
    out = []
    for label, pat in CERTS:
        m = re.search(pat, text)
        if m:
            out.append((label, _snippet(text, m.start(), m.end(), 60)))
    return out


MARKETS: list[tuple[str, str]] = [
    ("Aerospace", r"aerospace|aviation"), ("Defense", r"defen[cs]e|military"),
    ("Oil and gas", r"oil (?:and|&) gas|oilfield|upstream|midstream|downstream"),
    ("Energy", r"\benergy\b|power generation|utilities|utility"), ("Petrochemical", r"petrochemical|refin(?:ery|ing)"),
    ("Renewables", r"renewable|solar|wind energy"), ("Medical", r"medical|healthcare|surgical"),
    ("Semiconductor", r"semiconductor"), ("Automotive", r"automotive"), ("HVAC", r"\bHVAC\b|refrigeration"),
    ("Food and beverage", r"food (?:and|&) beverage|food service|foodservice|food processing"),
    ("Construction", r"construction|commercial building|homebuilder"), ("Agriculture", r"agricultur"),
    ("Telecommunications", r"telecom"), ("Transportation", r"transportation|trucking|\brail\b"),
    ("Marine", r"\bmarine\b"), ("Mining", r"\bmining\b"), ("Electronics", r"electronics"),
    ("Data centers", r"data cent(?:er|re)s?"), ("Government", r"government|municipal"),
    ("Pharmaceutical", r"pharmaceutical"), ("Retail", r"\bretail(?:ers)?\b"), ("Water", r"water(?:works| treatment|/wastewater)"),
    ("Industrial", r"\bindustrial (?:customers|markets|clients|equipment)"),
]
MARKET_CONTEXT = re.compile(r"(industries|markets|sectors)\s+(?:we\s+)?serve[ds]?|who we serve|our (?:customers|clients) (?:include|are)|serving (?:the )?[\w ,&]{0,40}(?:industr|market)", re.I)


def find_end_markets(text: str) -> list[str]:
    """Markets the company says it serves. Only read inside a 'markets/industries we serve' passage,
    so a news item about aerospace on a blog page does not become an end market."""
    found: list[str] = []
    for m in MARKET_CONTEXT.finditer(text):
        window = text[m.start(): m.start() + 1500]
        for label, pat in MARKETS:
            if label not in found and re.search(pat, window, re.I):
                found.append(label)
    return found


def find_employees(text: str) -> tuple[str, str] | None:
    for pat in (r"\b(?:over|more than|nearly|approximately|about)?\s*(\d{1,3}(?:,\d{3})?|\d{2,5})\+?\s+(?:full[- ]time\s+|dedicated\s+|skilled\s+)?(?:employees|team members|associates|employee-owners|craftsmen|craftspeople|people on staff)\b",
                r"\bteam of\s+(?:over\s+|more than\s+)?(\d{2,5})\+?\b",
                r"\bemploys\s+(?:over\s+|more than\s+|about\s+)?(\d{2,5})\b"):
        m = re.search(pat, text, re.I)
        if m:
            n = int(m.group(1).replace(",", ""))
            if 3 <= n <= 100000:
                return str(n), _snippet(text, m.start(), m.end(), 60)
    return None


US_STATES = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado",
    "CT": "Connecticut", "DE": "Delaware", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho",
    "IL": "Illinois", "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana",
    "ME": "Maine", "MD": "Maryland", "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota",
    "MS": "Mississippi", "MO": "Missouri", "MT": "Montana", "NE": "Nebraska", "NV": "Nevada",
    "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York", "NC": "North Carolina",
    "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia",
    "WI": "Wisconsin", "WY": "Wyoming",
}
_STATE_ALT = "|".join(sorted(list(US_STATES.keys()) + list(US_STATES.values()), key=len, reverse=True))


def find_locations(text: str) -> list[str]:
    out: list[str] = []
    pat = rf"\b(?:facilit(?:y|ies)|plants?|locations?|offices?|warehouses?|headquarters|headquartered|branch(?:es)?|shops?)\s+(?:is |are )?(?:located )?in\s+((?:[A-Z][a-z]+\.?\s){{0,2}}[A-Z][a-z]+),\s*({_STATE_ALT})\b"
    for m in re.finditer(pat, text):
        st = m.group(2)
        st = st if len(st) == 2 else next((k for k, v in US_STATES.items() if v == st), st)
        loc = f"{m.group(1).strip()}, {st}"
        if loc not in out:
            out.append(loc)
    return out[:10]


def summary_from(body: str) -> str | None:
    """1-2 lines on what the company does, in its own words."""
    for key in ("description", "og:description", "twitter:description"):
        v = meta_content(body, key)
        # a keyword list ("Cheese Sauce | Chips | Food") is SEO, not a description
        if v and len(v.split()) >= 8 and v.count("|") < 2 and not looks_like_markup_or_nav(v) and not re.match(r"(?i)^(welcome|home|just another)", v):
            return _clip(v, 300)
    for p in paragraphs(body):
        w = len(p.split())
        if 15 <= w <= 90 and not looks_like_markup_or_nav(p) and p[:1] not in "\"“‘'" and not PERSON_LEAD.match(p) and not BIO_SIGNS.search(p) \
                and not re.search(r"(?i)cookie|privacy|javascript|copyright|all rights reserved", p):
            return _clip(p, 300)
    return None


BIO_SIGNS = re.compile(r"\b(?:joined|joining)\b[^.]{0,60}\b(?:as|team)\b|\byears of experience\b|\bhis career\b|\bher career\b", re.I)
# "Jason joined the Cedar Ridge team as CFO..." is a bio, not what the company does
PERSON_LEAD = re.compile(r"^(?:Mr\.|Mrs\.|Ms\.|Dr\.)?\s*[A-Z][a-z]+(?:\s+[A-Z]\.)?(?:\s+[A-Z][a-zA-Z'\-]+)?\s+(?:joined|is a|is an|was|has been|has led|brings|serves|began|started his|started her|leads)\b")


def looks_like_markup_or_nav(s: str) -> bool:
    """Shortcodes, inline CSS, or a menu flattened into one line ("Home About Us Our Story Letter ...")."""
    if "[" in s or re.search(r"[{};]\s*[a-z-]+\s*:", s) or "{" in s:
        return True
    run = best = 0
    for tok in s.split():
        run = run + 1 if tok[:1].isupper() or tok in ("&", "-") else 0
        best = max(best, run)
    return best >= 7


def _clip(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", s).strip()
    if len(s) <= n:
        return s
    cut = s[:n].rsplit(" ", 1)[0]
    return cut.rstrip(",;:") + "..."


PRINCIPAL_TITLES = ["owner", "founder", "co-founder", "cofounder", "president", "chief executive officer",
                    "ceo", "chairman", "principal", "managing partner", "managing director"]


def principal_rank(title: str | None) -> int:
    # "Vice President of Sales" is not the president; neither is "Assistant to the President"
    t = re.sub(r"\b(?:senior |executive |assistant )?vice[- ]president\b|\bvp\b|\bassistant to\b[^,]*", " ", (title or "").lower())
    for i, k in enumerate(PRINCIPAL_TITLES):
        if k in t:
            return i
    return 99


TITLE_RE = re.compile(r"\b(" + "|".join(re.escape(t) for t in sorted(ef.DECIDER_TITLES, key=len, reverse=True)) + r")\b", re.I)
PERSON_NAME = re.compile(r"(?:[A-Z][a-z]+|[A-Z]\.)(?:\s+(?:[A-Z][a-zA-Z'\-]+|[A-Z]\.)){1,2}")


def titled_people(body: str) -> list[dict]:
    """A name block followed by a title block: the layout of nearly every Team/Leadership page.

    The page is cut into text blocks at tags. A block that is exactly a person's
    name, followed within two blocks by a short block holding a decision-maker
    title, is a person. "Name, Title" / "Name - Title" inside one short block
    counts too. Prose is never read here, so "His daughter Karen" cannot become
    a name. Reads name -> title only, so "President | Karen Brandt" in the next
    card does not hand Walter's title to Karen.
    """
    blocks = [re.sub(r"\s+", " ", htmllib.unescape(b)).strip(" |–-,:")
              for b in re.split(r"<[^>]+>", re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", body))]
    blocks = [b for b in blocks if b]
    out = []
    for i, b in enumerate(blocks):
        if len(b.split()) <= 10:
            m = re.fullmatch(rf"({PERSON_NAME.pattern})\s*[,–\-|:]\s*(.{{2,60}})", b)
            if m and TITLE_RE.search(m.group(2)):
                nm = ef.clean_name(m.group(1))
                if nm and nm == m.group(1):
                    out.append({"name": nm, "title": m.group(2).strip()})
                    continue
        if not PERSON_NAME.fullmatch(b):
            continue
        nm = ef.clean_name(b)
        if not nm or nm != b:
            continue
        for nxt in blocks[i + 1: i + 3]:
            if PERSON_NAME.fullmatch(nxt):
                break
            if len(nxt.split()) <= 8 and TITLE_RE.search(nxt):
                out.append({"name": nm, "title": nxt})
                break
    return out


def find_people(body: str, text: str) -> list[dict]:
    """Named leaders with the title printed next to them, plus founder sentences."""
    people: dict[str, dict] = {}
    for p in titled_people(body):
        k = p["name"].lower()
        if k in people:
            # add a second title only when the first is not already a principal title
            # (two cards side by side can hand a neighbour's "Executive Vice President" over)
            if p["title"].lower() not in people[k]["title"].lower() and principal_rank(people[k]["title"]) == 99:
                both = sorted([people[k]["title"], p["title"]], key=principal_rank)
                people[k]["title"] = ", ".join(both)
        else:
            people[k] = {"name": p["name"], "title": p["title"]}
    for p in people_from_jsonld(parse_jsonld(body)):
        people.setdefault(p["name"].lower(), {"name": p["name"], "title": p["title"] or "named on site"})
        if p.get("linkedin"):
            people[p["name"].lower()]["linkedin"] = p["linkedin"]
    name = r"([A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-zA-Z'\-]+)"
    for pat in (rf"\b(?:founded|started|established)\s+(?:in\s+{YEAR}\s+)?by\s+{name}",
                rf"{name},?\s+(?:who\s+)?(?:founded|started|established)\s+(?:the company|the business|[A-Z][\w&]+(?:\s+[A-Z][\w&]+){{0,3}})\s+in\s+{YEAR}"):
        for m in re.finditer(pat, text):
            groups = [g for g in m.groups() if g and not re.fullmatch(YEAR, g)]
            nm = ef.clean_name(groups[0]) if groups else None
            if nm:
                k = nm.lower()
                people.setdefault(k, {"name": nm, "title": "founder"})
                if "found" not in (people[k]["title"] or "").lower():
                    people[k]["title"] = f"{people[k]['title']}, founder"
    return list(people.values())


def same_person(a: str, first: str | None, last: str | None) -> bool:
    """Site name vs a CRM contact. Apollo masks surnames ("Ma***d"), so a mask matches on its visible ends."""
    parts = a.lower().split()
    if not parts or not first or parts[0] != first.lower().strip():
        return False
    ln = (last or "").lower().strip()
    if not ln:
        return False
    site_last = parts[-1]
    if "*" in ln:
        head, tail = ln.split("*", 1)[0], ln.rsplit("*", 1)[-1]
        return site_last.startswith(head) and site_last.endswith(tail) and len(site_last) >= len(head) + len(tail)
    return site_last == ln


def pick_principal(people: list[dict], crm: list[tuple[str | None, str | None]] | None = None) -> dict | None:
    """The owner/principal. A leader who is also the CRM contact wins, then the strongest title."""
    ranked = sorted((p for p in people if principal_rank(p.get("title")) < 99), key=lambda p: principal_rank(p.get("title")))
    for p in ranked:
        if any(same_person(p["name"], f, l) for f, l in (crm or [])):
            return p
    return ranked[0] if ranked else None


def last_name(full: str) -> str:
    parts = [p for p in re.split(r"\s+", full.strip()) if p and not re.fullmatch(r"(?i)(jr|sr|ii|iii|iv)\.?", p)]
    return parts[-1] if parts else ""


def owner_bio(paras: list[str], owner: str) -> str | None:
    """The first paragraph about the person: names them IN FULL as the subject of a sentence,
    20+ words, and is not a company timeline. A family surname alone is not enough: on a
    third-generation company's history page it names the grandfather, not the owner."""
    parts = owner.split()
    if len(parts) < 2:
        return None
    full = rf"\b{re.escape(parts[0])}\s+(?:[A-Z]\.\s+)?{re.escape(last_name(owner))}\b"
    about_them = re.compile(full + r"[^.]{0,80}\b(?:is|was|has|had|joined|serves|served|leads|led|began|founded|started|graduated|holds|brings|oversees|became|took)\b")
    cands = [p for p in paras if len(p) <= 1500 and about_them.search(p) and len(p.split()) >= 20
             and not looks_like_markup_or_nav(p)
             and sum(1 for w in p.split() if re.search(r"[A-Za-z]{2}", w)) >= 0.7 * len(p.split())
             and len(set(re.findall(r"\b(?:1[89]|20)\d\d\b", p))) < 3]
    return _clip(cands[0], 700) if cands else None


def owner_since(text: str, owner: str) -> tuple[str, str] | None:
    # the FULL name, so "Karen Brandt joined in 2012" is never read as Walter Brandt's start date
    ln = r"\s+(?:[A-Z]\.\s+)?".join(re.escape(t) for t in owner.split()[:1] + [last_name(owner)])
    pats = [
        rf"{ln}[^.\n]{{0,120}}\b(?:purchased|acquired|bought|took over|assumed ownership of|founded|started|established)\b[^.\n]{{0,60}}\bin\s+{YEAR}",
        rf"{ln}[^.\n]{{0,120}}\b(?:has led|has run|has owned|has served as|has been (?:the )?(?:president|owner|ceo))[^.\n]{{0,60}}\bsince\s+{YEAR}",
        rf"{ln}[^.\n]{{0,80}}\b(?:joined)[^.\n]{{0,60}}\bin\s+{YEAR}",
    ]
    for pat in pats:
        m = re.search(pat, text)
        if m and _ok_year(m.group(1)):
            return m.group(1), _snippet(text, m.start(), m.end(), 20)
    return None


def other_roles(paras: list[str], owner: str) -> list[str]:
    """Boards and outside roles, read only from paragraphs that are about the owner
    (they name the owner's full name), so a colleague's board seat is not attached."""
    first, ln = owner.split()[0], last_name(owner)
    about = [p for p in paras if re.search(rf"\b{re.escape(first)}\s+(?:[A-Z]\.\s+)?{re.escape(ln)}\b", p)]
    out: list[str] = []
    for sent in re.split(r"(?<=[.!?])\s+", " ".join(about)):
        for m in re.finditer(r"\b(?:serves|served|sits) (?:on|as) (?:the )?(?:board of directors (?:of|for)|board of|a board member (?:of|for)|chair(?:man)? of|director of|trustee of|president of)\s+(?:the\s+)?([A-Z][^.;\n]{3,80})", sent):
            role = _clip(m.group(0), 160)
            if role not in out:
                out.append(role)
        for m in re.finditer(r"\bis (?:a|an active) member of (?:the\s+)?([A-Z][^.;\n]{3,80})", sent):
            role = _clip(m.group(0), 160)
            if role not in out:
                out.append(role)
    return out[:6]


def linkedin_links(body: str) -> tuple[str | None, list[str]]:
    company = None
    people = []
    for m in re.finditer(r'href=["\'](https?://(?:[a-z]{2,3}\.)?linkedin\.com/(company|in)/[^"\'?#\s/]+)', body, re.I):
        url = m.group(1).rstrip("/")  # the profile root, never /jobs or /posts
        if m.group(2).lower() == "company":
            company = company or url
        elif url not in people:
            people.append(url)
    return company, people


HIRING_TITLES = re.compile(r"\b(general manager|plant manager|operations manager|chief operating officer|coo|chief financial officer|cfo|controller|vp of operations|vice president of operations|vp of finance|president)\b", re.I)

NAV_WORDS = re.compile(r"about|history|story|who-we-are|who we are|team|leadership|management|founder|our-company|company|"
                       r"news|press|media|blog|careers|jobs|employment|quality|certif|industries|markets|capabilities|locations", re.I)


def nav_links(body: str, base_url: str) -> list[tuple[str, str]]:
    """(url, label) for on-site links whose href or text looks like an About/Team/News/... page."""
    host = urllib.parse.urlparse(base_url).netloc.lower().removeprefix("www.")
    out: list[tuple[str, str]] = []
    seen = set()
    for m in re.finditer(r'(?is)<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>(.*?)</a>', body):
        href, label = m.group(1).strip(), re.sub(r"<[^>]+>|\s+", " ", m.group(2)).strip()
        if href.startswith(("mailto:", "tel:", "javascript:")):
            continue
        url = urllib.parse.urljoin(base_url, href)
        p = urllib.parse.urlparse(url)
        if p.netloc.lower().removeprefix("www.") != host or re.search(r"\.(pdf|jpg|png|zip|docx?)$", p.path, re.I):
            continue
        key = p.path.rstrip("/").lower()
        if not key or key in seen:
            continue
        if NAV_WORDS.search(p.path) or NAV_WORDS.search(label[:40]):
            seen.add(key)
            out.append((f"{p.scheme}://{p.netloc}{p.path}", label[:60]))
    return out


PAGE_PRIORITY = ["about", "history", "story", "leadership", "team", "management", "who", "founder", "company",
                 "quality", "certif", "industries", "markets", "careers", "jobs", "news", "press", "locations", "capabilities"]


def rank_links(links: list[tuple[str, str]]) -> list[str]:
    def score(item):
        path = item[0].lower() + " " + item[1].lower()
        return next((i for i, w in enumerate(PAGE_PRIORITY) if w in path), 99)
    return [u for u, _ in sorted(links, key=score)]


NEWS_KINDS: list[tuple[str, re.Pattern]] = [
    ("signal_ownership", re.compile(r"\b(acquir\w*|acquisition|private equity|recapitali[sz]\w*|merg(?:er|es|ed)|sold to|sells to|investment from|partners with .*capital)\b", re.I)),
    ("signal_hiring", re.compile(r"\b(names|announces|appoints|appointed|hires|promotes|promoted|welcomes|joins as|new)\b.*\b(president|ceo|coo|cfo|general manager|plant manager|chief|vice president|vp)\b", re.I)),
    ("signal_facility", re.compile(r"\b(relocat\w*|moves? (?:to|into|headquarters)|new (?:headquarters|facility|plant|building|location)|opens?|groundbreaking|breaks ground)\b", re.I)),
    ("signal_expansion", re.compile(r"\b(expan\w*|invest\w*|new jobs|adds? \d+ jobs|capacity|new equipment|million)\b", re.I)),
    ("signal_award", re.compile(r"\b(award\w*|honou?r\w*|named (?:to|one of|a)|recogni[sz]\w*|top workplaces?|inc\.? 5000|best places|winner|wins)\b", re.I)),
]


def classify_headline(title: str, company_name: str | None = None) -> str:
    for kind, pat in NEWS_KINDS:
        if pat.search(title):
            # "Acme Acquires 250 Ton Press" / "Acme acquires rival": the company is the buyer, which is growth, not a sale
            if kind == "signal_ownership" and company_name and not ownership_from_headline(title, company_name) and re.search(r"\bacquir", title, re.I):
                return "signal_expansion"
            return kind
    return "signal_news"


def ownership_from_headline(title: str, company: str) -> str | None:
    """'sold' or 'pe-backed' when the company is the OBJECT of the deal. None when it is the buyer."""
    n = re.escape(norm_name_spaced(company))
    t = norm_name_spaced(title)
    if not n:
        return None
    if re.search(rf"\b(?:acquires|acquired|to acquire|buys|acquisition of|completes acquisition of|purchase of)\s+(?:[a-z]+\s+){{0,2}}{n}\b", t) \
            or re.search(rf"\b{n}\s+(?:is\s+|has been\s+)?(?:acquired|sold|bought)\b", t) \
            or re.search(rf"\b{n}\s+(?:sells|sold)\s+to\b", t) \
            or re.search(rf"\badvises\s+{n}\s+in\s+(?:its\s+)?(?:acquisition|sale)\b", t):
        return "pe-backed" if "private equity" in t or re.search(r"\bcapital\b|\bpartners\b|\bequity\b", t) else "sold"
    return None


def news_match(title: str, snippet: str, url: str, company: dict) -> str | None:
    """Match discipline for a news item.

    None           the company's full name is not in the headline -> drop.
    'confirmed'    name present AND (city or state named, or the article is on the company's own domain).
    'unconfirmed'  name present, nothing else ties it to this company.
    """
    want = norm_name(company.get("name") or "")
    if len(want) < 4:
        return None
    blob = f"{title} {snippet}"
    if want not in norm_name(blob):
        return None
    host = urllib.parse.urlparse(url).netloc.lower().removeprefix("www.")
    dom = (company.get("domain") or "").lower().removeprefix("www.")
    if dom and host.endswith(dom):
        return "confirmed"
    city = (company.get("city") or "").strip()
    st = (company.get("state") or "").strip().upper()
    if city and re.search(rf"\b{re.escape(city)}\b", blob, re.I):
        return "confirmed"
    if st and (re.search(rf"\b{st}\b", blob) or (st in US_STATES and re.search(rf"\b{US_STATES[st]}\b", blob, re.I))):
        return "confirmed"
    return "unconfirmed"


def site_headlines(body: str) -> list[tuple[str, str | None]]:
    """(headline, iso date or None) from a News / Press page on the company's own site."""
    out = []
    for m in re.finditer(r"(?is)<(h[1-4]|a)[^>]*>(.*?)</\1>", body):
        t = re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", m.group(2)))).strip()
        if not (6 <= len(t.split()) <= 25) or re.search(r"(?i)read more|learn more", t):
            continue
        tail = body[m.end(): m.end() + 400]
        d = re.search(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d\d)\b", tail)
        iso = None
        if d:
            try:
                iso = datetime.strptime(f"{d.group(1)[:3]} {d.group(2)} {d.group(3)}", "%b %d %Y").date().isoformat()
            except ValueError:
                iso = None
        if t not in [o[0] for o in out]:
            out.append((t, iso))
    return out[:30]


# ---------------------------------------------------------------------------
# Page-level extraction: one fetched page -> list of candidate facts.
# ---------------------------------------------------------------------------

def extract_page(body: str, url: str, company: dict, confidence: str = "confirmed") -> list[dict]:
    text = visible_text(body)
    paras = paragraphs(body)
    ld = parse_jsonld(body)
    org = org_from_jsonld(ld)
    base = {"entity": "company", "entity_id": company.get("id"), "source_url": url,
            "source_label": "Company website", "confidence": confidence, "match_basis": "domain"}
    facts: list[dict] = []

    def add(field, value, note=None, **kw):
        if value:
            facts.append({**base, "field": field, "value": str(value), "note": note, **kw})

    path = urllib.parse.urlparse(url).path.strip("/").lower()
    is_home = path in ("", "index.html", "index.php", "home")

    if is_home:
        add("summary", summary_from(body))
        site_name = re.split(r"\s+[|\-–—:]\s+", meta_content(body, "og:site_name") or org.get("name") or "")[0].strip()
        if site_name and len(site_name.split()) <= 6 and norm_name(site_name) != norm_name(company.get("name") or "")                 and not norm_name(company.get("name") or "").startswith(norm_name(site_name)):
            add("dba", site_name, "Name the company uses on its own site")
    elif not any(f["field"] == "summary" for f in facts) and re.search(r"about|who|company|story", path):
        sa = summary_from(body)
        # an About page paragraph is a summary only if it is about the company, not a person
        if sa and any(t in sa.lower() for t in core_tokens(company.get("name") or "")):
            add("summary_about", sa)
    if org.get("legal_name"):
        add("legal_name_site", org["legal_name"], "schema.org legalName")
    if org.get("founding_year"):
        add("founded_year", org["founding_year"], "schema.org foundingDate")
    fy = find_founded_year(text) or find_founded_year("\n".join(
        v for v in (meta_content(body, "description"), meta_content(body, "og:description")) if v))
    if fy:
        add("founded_year", fy[0], fy[1])
    if org.get("address"):
        add("hq_address", org["address"], "schema.org address")
    if org.get("locality"):
        add("locations", org["locality"], "schema.org address")
    for loc in find_locations(text):
        add("locations", loc)
    emp = find_employees(text)
    if org.get("employees"):
        add("employee_estimate", org["employees"], "schema.org numberOfEmployees")
    elif emp:
        add("employee_estimate", emp[0], emp[1])
    own = find_ownership(text)
    if own:
        add("ownership_type", own[0], own[1])
    fam = find_family_since(text)
    if fam:
        add("family_owned_since", fam[0], fam[1])
    sg = find_second_generation(text)
    if sg:
        add("second_generation", "Named on site", sg)
    for label, snip in find_certifications(text):
        add("certifications", label, snip)
    for mk in find_end_markets(text):
        add("end_markets", mk)
    co_li, person_li = linkedin_links(body)
    if co_li or org.get("linkedin"):
        add("company_linkedin", co_li or org.get("linkedin"))

    people = find_people(body, text)
    if org.get("founder"):
        nm = ef.clean_name(org["founder"])
        if nm and nm.lower() not in [p["name"].lower() for p in people]:
            people.append({"name": nm, "title": "founder"})
    for p in people:
        add("leaders", f"{p['name']} | {p['title']}")
    principal = pick_principal(people, company.get("_crm_people"))
    if principal:
        n_before = len(facts)
        add("owner_name", principal["name"])
        add("owner_title", principal["title"])
        bio = owner_bio(paras, principal["name"])
        add("owner_bio", bio)
        since = owner_since(text, principal["name"])
        if since:
            add("owner_since", since[0], since[1])
        ln = last_name(principal["name"]).lower()
        li = principal.get("linkedin") or next((u for u in person_li if ln and ln in u.lower()), None)
        add("owner_linkedin", li)
        for r in other_roles(paras, principal["name"]):
            add("owner_other_roles", r)
        for f in facts[n_before:]:  # tag, so merge_facts never mixes two people's details
            f["_owner"] = principal["name"]

    if re.search(r"career|job|employment", path):
        for m in HIRING_TITLES.finditer(text):
            line = next((ln for ln in text.split("\n") if m.group(0) in ln), m.group(0))
            if len(line.split()) <= 12:
                add("signal_hiring", f"Careers page lists: {line.strip()}", None, observed_at=now_iso()[:10])
                break
    if re.search(r"news|press|media|blog", path):
        for title, iso in site_headlines(body):
            kind = classify_headline(title, company.get("name"))
            if kind != "signal_news" or iso:
                add(kind, title, "Company news page", observed_at=iso)
    return facts


def merge_facts(facts: list[dict]) -> list[dict]:
    """First value wins for single fields (pages are fetched best-first); lists keep every value."""
    seen_single: set[str] = set()
    out = []
    for f in facts:
        if f["field"] in MULTI_FIELDS:
            out.append(f)
        elif f["field"] not in seen_single:
            seen_single.add(f["field"])
            out.append(f)
    # owner details only from the page(s) that named the SAME principal as the winning owner_name
    winner = next((f["value"] for f in out if f["field"] == "owner_name"), None)
    out = [f for f in out if "_owner" not in f or f["_owner"] == winner]
    for f in facts:
        if f.get("_owner") == winner and f["field"].startswith("owner_") and f["field"] not in MULTI_FIELDS \
                and not any(o["field"] == f["field"] for o in out):
            out.append(f)
    # the About page's summary only counts when the homepage gave none
    if any(f["field"] == "summary" for f in out):
        out = [f for f in out if f["field"] != "summary_about"]
    else:
        for f in out:
            if f["field"] == "summary_about":
                f["field"] = "summary"
    return out


# ---------------------------------------------------------------------------
# Collectors (network)
# ---------------------------------------------------------------------------

def collect_site(company: dict, domain: str, basis: str) -> tuple[list[dict], dict]:
    """Fetch the homepage + best nav pages. basis='domain' means the domain was already on file."""
    info = {"pages": 0, "robots_blocked": 0, "domain": domain}
    home_url, home = polite_get(f"https://{domain}/")
    if not home:
        home_url, home = polite_get(f"http://{domain}/")
    if not home:
        info["error"] = "homepage unreachable or robots-disallowed"
        return [], info
    info["pages"] = 1
    pages = [(home_url, home)]
    for url in rank_links(nav_links(home, home_url))[: MAX_PAGES - 1]:
        u, b = polite_get(url)
        if b:
            pages.append((u, b))
            info["pages"] += 1
    if len(pages) < 3:
        for guess in ("/about", "/about-us", "/history", "/leadership", "/our-team"):
            if len(pages) >= 4:
                break
            u, b = polite_get(urllib.parse.urljoin(home_url, guess))
            if b and u not in [p[0] for p in pages]:
                pages.append((u, b))
                info["pages"] += 1
    info["robots_blocked"] = sum(1 for f in FETCH_LOG if f["status"] == "robots-disallowed" and domain in f["url"])

    confidence = "confirmed"
    if basis != "domain":
        # a resolved domain is confirmed only when some page names the company's city
        city = (company.get("city") or "").strip()
        all_text = " ".join(visible_text(b) for _, b in pages)
        if not city or not re.search(rf"\b{re.escape(city)}\b", all_text, re.I):
            confidence = "unconfirmed"
        info["city_on_site"] = confidence == "confirmed"

    facts = []
    # A resolved site that never names the company's city may be a namesake
    # (harlow.example.com is not Harlow Manufacturing). Keep only "possible website",
    # unconfirmed, and read nothing else off it.
    if confidence == "confirmed":
        for u, b in pages:
            facts.extend(extract_page(b, u, company, confidence))
    for f in facts:
        if basis != "domain":
            f["match_basis"] = "resolved-domain+city" if confidence == "confirmed" else "resolved-domain-name-only"
    facts.append({"entity": "company", "entity_id": company["id"], "field": "website", "value": f"https://{domain}",
                  "source_url": home_url, "source_label": "Company website", "confidence": confidence,
                  "match_basis": "domain on file" if basis == "domain" else "homepage names the company"})
    return merge_facts(facts), info


ORG_TYPE_LABEL = {
    "CT": "Texas for-profit corporation", "CL": "Texas LLC", "CF": "Out-of-state for-profit corporation",
    "CI": "Out-of-state LLC", "CP": "Texas professional corporation", "CU": "Out-of-state professional corporation",
    "PL": "Texas limited partnership", "PF": "Out-of-state limited partnership", "PB": "General partnership",
    "PX": "Texas LLP", "PY": "Out-of-state LLP", "AB": "Texas business association", "HF": "Out-of-state holding company",
    "C": "Corporation", "L": "LLC", "M": "Limited liability partnership", "P": "General partnership",
    "S": "Sole proprietorship", "IS": "Sole owner", "J": "Joint venture", "PV": "Texas joint venture",
    "CN": "Texas nonprofit corporation", "CM": "Out-of-state nonprofit corporation", "TR": "Trust",
}
FOREIGN_TYPES = {"CF", "CI", "CU", "PF", "PY", "HF", "CM", "AC", "SF", "TF"}
NAICS_SECTORS = {
    "11": "Agriculture", "21": "Mining, oil and gas", "22": "Utilities", "23": "Construction",
    "31": "Manufacturing", "32": "Manufacturing", "33": "Manufacturing", "42": "Wholesale trade",
    "44": "Retail trade", "45": "Retail trade", "48": "Transportation", "49": "Warehousing",
    "51": "Information", "52": "Finance and insurance", "53": "Real estate", "54": "Professional services",
    "55": "Management of companies", "56": "Administrative services", "61": "Education", "62": "Health care",
    "71": "Arts and recreation", "72": "Accommodation and food", "81": "Other services", "92": "Public administration",
}


def registry_row_facts(company: dict, row: dict, url: str, confidence: str, basis: str) -> list[dict]:
    base = {"entity": "company", "entity_id": company["id"], "source_url": url,
            "source_label": "TX Comptroller franchise-tax registry", "confidence": confidence, "match_basis": basis}
    out = []

    def add(field, value, note=None):
        if value:
            out.append({**base, "field": field, "value": str(value), "note": note})

    add("legal_name", (row.get("taxpayer_name") or "").strip())
    charter = (row.get("sos_charter_date") or "")[:10]
    add("formation_date", charter, "SOS charter date")
    ot = row.get("taxpayer_organizational_type") or row.get("org_type")
    if ot:
        add("entity_type", ORG_TYPE_LABEL.get(ot, f"Registry type {ot}"), f"registry code {ot}")
    add("sos_file_number", row.get("secretary_of_state_sos_or_coa_file_number") or row.get("sos_file_number"))
    addr = row.get("registered_address") or ", ".join(
        x for x in [(row.get("taxpayer_address") or "").title(), (row.get("taxpayer_city") or "").title(),
                    f"{row.get('taxpayer_state') or ''} {row.get('taxpayer_zip') or ''}".strip()] if x)
    add("registered_address", addr, "Franchise-tax mailing address on file with the state")
    naics = (row.get("_621111") or row.get("naics") or "").strip()
    if re.fullmatch(r"\d{6}", naics):
        sector = NAICS_SECTORS.get(naics[:2], "")
        level = "sector level only" if naics.endswith("0000") else ("industry group" if naics.endswith("00") else "full code")
        add("naics", f"{naics}{' (' + sector + ', ' + level + ')' if sector else ''}", "NAICS as recorded by the Comptroller")
    return out


def registry_lookup(company: dict) -> tuple[list[dict], str]:
    """Registry facts for a company. Registry-sourced rows use the stored file number; others need name+city."""
    notes = {}
    try:
        notes = json.loads(company.get("notes") or "{}") if (company.get("notes") or "").startswith("{") else {}
    except Exception:
        notes = {}
    tp = notes.get("taxpayer_number")
    if company.get("source") == "tx-franchise-registry" and tp:
        url = SOCRATA + "?" + urllib.parse.urlencode({"taxpayer_number": tp})
        _, body = polite_get(url, accept="application/json")
        rows = []
        try:
            rows = json.loads(body) if body else []
        except Exception:
            rows = []
        row = rows[0] if rows else {
            "taxpayer_name": company["name"], "sos_charter_date": notes.get("sos_charter_date"),
            "org_type": notes.get("org_type"), "sos_file_number": notes.get("sos_file_number"),
            "registered_address": notes.get("registered_address"),
        }
        return registry_row_facts(company, row, url, "confirmed", "registry file number on record"), "registry-id"

    core = norm_name_spaced(company.get("name") or "").upper()
    if len(core) < 4:
        return [], "no-name"
    first = core.split()[0]
    where = f"upper(taxpayer_name) like '{first.replace(chr(39), chr(39) * 2)}%' AND taxpayer_state='TX'"
    url = SOCRATA + "?" + urllib.parse.urlencode({"$where": where, "$limit": "200"})
    _, body = polite_get(url, accept="application/json")
    try:
        rows = json.loads(body) if body else []
    except Exception:
        rows = []
    want = norm_name(company["name"])
    city = (company.get("city") or "").strip().upper()
    exact = [r for r in rows if norm_name(r.get("taxpayer_name") or "") == want]
    prefix = [r for r in rows if norm_name(r.get("taxpayer_name") or "").startswith(want)]
    in_city = lambda rs: [r for r in rs if city and (r.get("taxpayer_city") or "").upper() == city]  # noqa: E731
    for rs, basis in ((in_city(exact), "registry name + city match"), (in_city(prefix), "registry name prefix + city match")):
        if len(rs) == 1:
            return registry_row_facts(company, rs[0], url, "confirmed", basis), "name+city"
    if len(exact) == 1:
        return registry_row_facts(company, exact[0], url, "unconfirmed", "registry name match only (city differs or unknown)"), "name-only"
    return [], f"no single match ({len(exact)} exact, {len(prefix)} prefix)"


def collect_gdelt(company: dict, owner: str | None) -> list[dict]:
    """Recent news (GDELT rolling window). One query per company, 1 request / 6 s."""
    q = f'"{company["name"]}"'
    url = GDELT + "?" + urllib.parse.urlencode({"query": q, "mode": "artlist", "format": "json", "maxrecords": "25", "sort": "datedesc"})
    _, body = polite_get(url, gap=6.0, accept="application/json")
    if not body or not body.lstrip().startswith("{"):
        return []
    try:
        arts = json.loads(body).get("articles", [])
    except Exception:
        return []
    out = []
    for a in arts:
        title, link = (a.get("title") or "").strip(), a.get("url") or ""
        conf = news_match(title, a.get("domain") or "", link, company)
        if not conf:
            continue
        seen = a.get("seendate") or ""
        iso = f"{seen[:4]}-{seen[4:6]}-{seen[6:8]}" if len(seen) >= 8 else None
        kind = classify_headline(title, company["name"])
        out.append({"entity": "company", "entity_id": company["id"], "field": kind, "value": title, "source_url": link,
                    "source_label": a.get("domain") or "news", "confidence": conf,
                    "match_basis": "name + city/state/domain" if conf == "confirmed" else "name only",
                    "observed_at": iso})
        own = ownership_from_headline(title, company["name"])
        if own:
            out.append({"entity": "company", "entity_id": company["id"], "field": "ownership_event", "value": f"{own}: {title}",
                        "source_url": link, "source_label": a.get("domain") or "news", "confidence": conf,
                        "match_basis": "news headline", "note": title, "observed_at": iso})
        if owner and last_name(owner).lower() in title.lower():
            out.append({"entity": "company", "entity_id": company["id"], "field": "owner_press", "value": title,
                        "source_url": link, "source_label": a.get("domain") or "news", "confidence": conf,
                        "match_basis": "owner + company named", "observed_at": iso})
    return out[:20]


def signal_table_facts(con: sqlite3.Connection, company: dict) -> list[dict]:
    """Ownership facts from headlines the signal engine already stored (same match discipline)."""
    out = []
    for s in con.execute("SELECT title, url, observed_at FROM signals WHERE company_id=? AND kind='news' AND url IS NOT NULL",
                         (company["id"],)).fetchall():
        title = s[0]
        conf = news_match(title, "", s[1], company)
        if not conf:
            continue
        own = ownership_from_headline(title, company["name"])
        if own:
            out.append({"entity": "company", "entity_id": company["id"], "field": "ownership_event", "value": f"{own}: {title}",
                        "source_url": s[1], "source_label": "news (signal engine)", "confidence": conf,
                        "match_basis": "news headline", "note": title, "observed_at": s[2]})
    return out


_DDG_BLOCKED = False


def search_hosts(query: str) -> list[str]:
    """Candidate hosts from DuckDuckGo's no-JS page (robots allows it), directories dropped.
    Same parsing as email_finder.search_candidates, but through polite_get (robots + honest UA)."""
    global _DDG_BLOCKED
    if _DDG_BLOCKED:
        return []
    _, body = polite_get("https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query), gap=3.0)
    if FETCH_LOG and FETCH_LOG[-1]["status"] == 202:  # bot check: stop asking for the rest of this run
        _DDG_BLOCKED = True
        return []
    hosts: list[str] = []
    for m in re.finditer(r'uddg=([^&"\']+)', body or ""):
        host = urllib.parse.urlparse(urllib.parse.unquote(m.group(1))).netloc.lower().removeprefix("www.")
        if host and not any(d in host for d in ef.DIRECTORY_HOSTS) and host not in hosts:
            hosts.append(host)
    return hosts[:5]


def homepage_names_company(body: str, company_name: str, host: str) -> bool:
    """email_finder.confirm_domain's rule, on a page we already fetched politely."""
    want = norm_name(company_name)
    if len(want) < 5:
        return False
    got = norm_name(re.sub(r"<[^>]+>", " ", body[:200_000]))
    if want in got:
        return True
    lead = re.sub(r"[^a-z0-9]", "", company_name.lower().split()[0])
    return len(lead) >= 5 and lead in got and norm_name(host).startswith(lead[:5])


def guess_domains(name: str) -> list[str]:
    """Obvious .com spellings of a company name. A guess is only kept if its homepage names the company."""
    toks = norm_name_spaced(name).split()
    if not toks:
        return []
    core = [t for t in toks if t not in GENERIC_WORDS]
    mfg = ["mfg" if t == "manufacturing" else t for t in toks]
    cands = ["".join(toks), "".join(mfg), "".join(core), "".join(toks[:2]), "-".join(toks)]
    if len(toks[0]) >= 5:
        cands.append(toks[0])
    out = []
    for c in cands:
        if 4 <= len(c) <= 40 and f"{c}.com" not in out:
            out.append(f"{c}.com")
    return out[:5]


def _resolves(host: str) -> bool:
    import socket
    try:
        socket.getaddrinfo(host, 443)
        return True
    except OSError:
        return False


def resolve_domain(company: dict) -> str | None:
    """Only for companies with no domain on file: the homepage must name the company.

    DuckDuckGo first (its robots.txt allows the no-JS page). When it answers with
    its bot check (HTTP 202) we stop there, never solve it, and fall back to
    obvious .com spellings of the name, each confirmed on its own homepage.
    """
    q = f'"{company["name"]}" {company.get("city") or ""} Texas'.strip()
    hosts = search_hosts(q) + [h for h in guess_domains(company["name"]) if _resolves(h)]
    for h in hosts:
        _, body = polite_get(f"https://{h}/")
        if body and homepage_names_company(body, company["name"], h):
            return h
    return None


# ---------------------------------------------------------------------------
# One company
# ---------------------------------------------------------------------------

def enrich_company(con: sqlite3.Connection, company: dict, dry: bool = False, news: bool = True,
                   resolve: bool = True) -> dict:
    report = {"id": company["id"], "name": company["name"], "writes": {}, "sources": []}
    facts: list[dict] = []
    company["_crm_people"] = [(r[0], r[1]) for r in con.execute(
        "SELECT first_name, last_name FROM contacts WHERE company_id=?", (company["id"],)).fetchall()]

    reg, how = registry_lookup(company)
    facts += reg
    report["registry"] = how

    domain = (company.get("domain") or "").strip().lower().removeprefix("www.") or None
    basis = "domain"
    if not domain:
        existing = con.execute("SELECT value FROM profile_facts WHERE entity='company' AND entity_id=? AND field='website'",
                               (company["id"],)).fetchone()
        if existing:
            domain = urllib.parse.urlparse(existing[0]).netloc
            basis = "resolved"
        elif resolve:
            domain = resolve_domain(company)
            basis = "resolved"
    if domain:
        site_facts, info = collect_site(company, domain, basis)
        facts += site_facts
        report["site"] = info
    else:
        report["site"] = {"error": "no domain on file and none confirmed"}

    facts += signal_table_facts(con, company)
    if news:
        owner = next((f["value"] for f in facts if f["field"] == "owner_name"), None)
        facts += collect_gdelt(company, owner)

    fetched = now_iso()
    counts: dict[str, int] = {}
    for f in facts:
        f["entity_id"] = company["id"]
        if dry:
            res = "dry"
        else:
            res = upsert_fact(con, f, fetched)
        counts[res] = counts.get(res, 0) + 1
    report["writes"] = counts
    report["fields"] = sorted({f["field"] for f in facts})
    if not dry:
        con.execute("UPDATE companies SET profile_refreshed_at=? WHERE id=?", (fetched, company["id"]))
        con.execute(
            "INSERT INTO audit_log (actor_label, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?)",
            ("profile-enrich", "profile.enrich", "company", company["id"],
             json.dumps({"writes": counts, "registry": how, "site": report.get("site"), "at": fetched})),
        )
        con.commit()
    if dry:
        report["facts"] = facts
    return report


# ---------------------------------------------------------------------------
# Fill-rate report
# ---------------------------------------------------------------------------
REPORT_FIELDS = [
    "owner_name", "owner_title", "owner_since", "owner_bio", "owner_linkedin", "owner_other_roles", "owner_press",
    "legal_name", "dba", "website", "summary", "naics", "founded_year", "formation_date", "entity_type",
    "hq_address", "registered_address", "locations", "employee_estimate", "ownership_type", "end_markets",
    "certifications", "family_owned_since", "second_generation", "company_linkedin",
    "ownership_event", "signal_hiring", "signal_expansion", "signal_facility", "signal_award", "signal_ownership", "signal_news",
]


def select_companies(con: sqlite3.Connection, scope: str, limit: int | None, company_id: int | None, offset: int = 0) -> list[dict]:
    con.row_factory = sqlite3.Row
    if company_id:
        rows = con.execute("SELECT * FROM companies WHERE id=?", (company_id,)).fetchall()
    elif scope == "contacts":
        rows = con.execute("SELECT * FROM companies WHERE id IN (SELECT company_id FROM contacts WHERE company_id IS NOT NULL) ORDER BY id").fetchall()
    elif scope == "registry":
        rows = con.execute("SELECT * FROM companies WHERE source='tx-franchise-registry' ORDER BY id LIMIT ? OFFSET ?", (limit or 50, offset)).fetchall()
    elif scope == "enriched":
        rows = con.execute("SELECT * FROM companies WHERE profile_refreshed_at IS NOT NULL ORDER BY id").fetchall()
    else:
        rows = con.execute("SELECT * FROM companies ORDER BY id LIMIT ?", (limit or 100,)).fetchall()
    con.row_factory = None
    out = [dict(r) for r in rows]
    if limit and scope == "contacts":
        out = out[:limit]
    return out


def fill_rates(con: sqlite3.Connection, ids: list[int]) -> dict:
    n = len(ids)
    table = {}
    if not n:
        return {"n": 0, "fields": {}}
    q = ",".join("?" * n)
    for field in REPORT_FIELDS:
        conf = con.execute(f"SELECT COUNT(DISTINCT entity_id) FROM profile_facts WHERE entity='company' AND field=? AND confidence='confirmed' AND entity_id IN ({q})", (field, *ids)).fetchone()[0]
        anyc = con.execute(f"SELECT COUNT(DISTINCT entity_id) FROM profile_facts WHERE entity='company' AND field=? AND entity_id IN ({q})", (field, *ids)).fetchone()[0]
        table[field] = {"confirmed": conf, "any": anyc, "pct_confirmed": round(100 * conf / n), "pct_any": round(100 * anyc / n)}
    return {"n": n, "fields": table}


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_run(args) -> int:
    con = sqlite3.connect(args.db, timeout=30)
    con.execute("PRAGMA busy_timeout = 30000")
    ensure_schema(con)
    companies = select_companies(con, args.scope, args.limit, args.company_id, args.offset)
    if not companies:
        print(json.dumps({"error": "no companies matched"}))
        return 1
    reports = []
    for i, c in enumerate(companies, 1):
        t0 = time.monotonic()
        try:
            rep = enrich_company(con, c, dry=args.dry, news=not args.no_news, resolve=not args.no_resolve)
        except Exception as e:  # one bad site never stops the batch
            rep = {"id": c["id"], "name": c["name"], "error": repr(e)}
        rep["secs"] = round(time.monotonic() - t0, 1)
        reports.append(rep)
        if not args.json:
            print(f"[{i}/{len(companies)}] {c['id']} {c['name'][:40]}: {rep.get('writes') or rep.get('error')} "
                  f"site={(rep.get('site') or {}).get('pages', 0)}p registry={rep.get('registry')} ({rep['secs']}s)", flush=True)
    summary = {"companies": len(companies), "dry": args.dry,
               "fill": fill_rates(con, [c["id"] for c in companies]) if not args.dry else None}
    if args.json:
        print(json.dumps({"reports": reports, "summary": summary}, default=str))
    else:
        print(json.dumps(summary["fill"], indent=1) if summary["fill"] else "dry run: nothing written")
    con.close()
    return 0


def cmd_parse(args) -> int:
    body = open(args.html, encoding="utf-8").read()
    company = {"id": 0, "name": args.company, "city": args.city, "state": args.state, "domain": args.domain}
    facts = merge_facts(extract_page(body, args.url, company))
    print(json.dumps({"facts": [{k: f.get(k) for k in ("field", "value", "note", "confidence", "observed_at")} for f in facts],
                      "links": rank_links(nav_links(body, args.url))}, indent=1))
    return 0


def cmd_news_match(args) -> int:
    items = json.loads(sys.stdin.read())
    out = []
    for it in items:
        c = it["company"]
        out.append({"match": news_match(it.get("title", ""), it.get("snippet", ""), it.get("url", ""), c),
                    "ownership": ownership_from_headline(it.get("title", ""), c.get("name", "")),
                    "kind": classify_headline(it.get("title", ""), c.get("name"))})
    print(json.dumps(out))
    return 0


def cmd_apply(args) -> int:
    """Write a JSON list of sourced facts from stdin. Used by tests and for hand-researched facts."""
    con = sqlite3.connect(args.db, timeout=30)
    ensure_schema(con)
    results = [upsert_fact(con, f) for f in json.loads(sys.stdin.read())]
    con.commit()
    con.close()
    print(json.dumps(results))
    return 0


def cmd_fill(args) -> int:
    con = sqlite3.connect(args.db)
    ensure_schema(con)
    ids = [c["id"] for c in select_companies(con, args.scope, args.limit, None)]
    print(json.dumps(fill_rates(con, ids), indent=1))
    return 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv or argv[0].startswith("-"):
        argv = ["run"] + argv
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="enrich companies and write sourced facts")
    r.add_argument("--db", default="data/harness.db")
    r.add_argument("--limit", type=int, default=None)
    r.add_argument("--offset", type=int, default=0, help="registry scope: skip this many rows (to split a batch)")
    r.add_argument("--company-id", type=int, default=None, dest="company_id")
    r.add_argument("--scope", default="contacts", choices=["contacts", "registry", "all", "enriched"])
    r.add_argument("--dry", action="store_true", help="fetch and parse, write nothing")
    r.add_argument("--no-news", action="store_true", dest="no_news")
    r.add_argument("--no-resolve", action="store_true", dest="no_resolve", help="never search for a missing domain")
    r.add_argument("--json", action="store_true")

    pa = sub.add_parser("parse", help="run the page parser on a local HTML file (no network)")
    pa.add_argument("--html", required=True)
    pa.add_argument("--url", required=True)
    pa.add_argument("--company", required=True)
    pa.add_argument("--city", default=None)
    pa.add_argument("--state", default=None)
    pa.add_argument("--domain", default=None)

    sub.add_parser("news-match", help="apply the news match discipline to JSON items on stdin (no network)")

    ap = sub.add_parser("apply-facts", help="write JSON facts from stdin (each needs a source_url)")
    ap.add_argument("--db", required=True)

    fr = sub.add_parser("fill-rates", help="per-field fill rates")
    fr.add_argument("--db", default="data/harness.db")
    fr.add_argument("--scope", default="enriched", choices=["contacts", "registry", "all", "enriched"])
    fr.add_argument("--limit", type=int, default=None)

    args = p.parse_args(argv)
    return {"run": cmd_run, "parse": cmd_parse, "news-match": cmd_news_match,
            "apply-facts": cmd_apply, "fill-rates": cmd_fill}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
