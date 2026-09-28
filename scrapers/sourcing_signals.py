#!/usr/bin/env python3
"""
sourcing_signals.py - three more "why now" signals for companies the pipeline checked.

Stdlib only. Public sources only, no login, no paid API, no LLM call. Writes
into the existing signals table, deduped on (company_id, kind, url).

  officer-change    the latest two officer snapshots for a company differ: an
                    officer or founder was added or removed. Weight 5 (high).
                    The first snapshot is only a baseline and never a signal.
  owner-news        news naming the owner with retire / retirement / obituary /
                    sells / succession, kept only when the headline also names
                    the company or its city. Weight 4 (6 for an obituary or a
                    retirement).
  business-journal  news naming the company, kept only when the item also names
                    its city or Texas, or comes from its own domain. Local
                    business press (bizjournals, Dallas Morning News ...) is
                    labelled business-journal; other outlets that pass the same
                    identity check are stored as plain news.

NEWS SOURCE, AND WHY NOT GOOGLE NEWS
------------------------------------
news.google.com/robots.txt disallows every path except the home and topic
pages for all user agents, so /rss/search is off limits to an automated
client that obeys robots.txt. This module uses the GDELT DOC 2.0 API instead
(api.gdeltproject.org, public, no key, built for programmatic queries, asks for
at most one request every 5 seconds; we wait 6). Bing's news RSS is allowed by
bing.com/robots.txt but Microsoft's service terms restrict automated querying,
so it is not used either. BizBuySell and any site whose terms forbid scraping
are never touched.
"""

import json
import os
import re
import sqlite3
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import profile_enrich as pe  # noqa: E402

GDELT = "https://api.gdeltproject.org/api/v2/doc/doc"
GDELT_GAP = 6.0
_gdelt_state = {"cooled_until": 0.0, "limited": 0, "calls": 0}

BUSINESS_PRESS = (
    "bizjournals.com", "dallasnews.com", "star-telegram.com", "houstonchronicle.com", "chron.com",
    "expressnews.com", "statesman.com", "communityimpact.com", "dmagazine.com", "fwbusinesspress.com",
    "texastribune.org", "dallasinnovates.com", "sanantonioreport.org", "houstonpublicmedia.org",
    "kera.org", "wfaa.com", "nbcdfw.com", "fox4news.com", "khou.com", "kxan.com", "mysanantonio.com",
    "reporternews.com", "lubbockonline.com", "caller.com", "wacotrib.com", "tylerpaper.com",
    "dentonrc.com", "mckinneyonline.com", "starlocalmedia.com", "texasbusiness.org",
)
OWNER_WORDS = ("retire", "retirement", "retiring", "obituary", "obituaries", "passed away", "sells", "sold",
               "succession", "steps down", "hands over")


def insert_signal(con: sqlite3.Connection, company_id: int, kind: str, title: str, url: str,
                  observed_at: str | None, weight: float) -> bool:
    """Dedupe on (company_id, kind, url). The table has no unique index, so check first."""
    if not url:
        return False
    if con.execute("SELECT 1 FROM signals WHERE company_id=? AND kind=? AND url=?", (company_id, kind, url)).fetchone():
        return False
    con.execute("INSERT INTO signals (company_id, kind, title, url, observed_at, weight) VALUES (?,?,?,?,?,?)",
                (company_id, kind, title[:300], url, observed_at, weight))
    return True


# ---------------------------------------------------------------------------
# officer-change
# ---------------------------------------------------------------------------

def diff_officers(prev: list[str], cur: list[str]) -> tuple[list[str], list[str]]:
    """(added, removed), compared case-insensitively. Pure."""
    p = {n.lower(): n for n in prev}
    c = {n.lower(): n for n in cur}
    return [c[k] for k in c if k not in p], [p[k] for k in p if k not in c]


def officer_change_signals(con: sqlite3.Connection, company_id: int) -> int:
    new = 0
    for src in [r[0] for r in con.execute("SELECT DISTINCT source FROM officer_snapshots WHERE company_id=?", (company_id,))]:
        snaps = con.execute(
            "SELECT names_json, source_url, taken_at FROM officer_snapshots WHERE company_id=? AND source=? ORDER BY id DESC LIMIT 2",
            (company_id, src)).fetchall()
        if len(snaps) < 2:
            continue
        cur, prev = json.loads(snaps[0][0]), json.loads(snaps[1][0])
        if not cur and prev and src != "tx-comptroller-pir":
            continue  # a website page that failed to load is not a departure
        added, removed = diff_officers(prev, cur)
        if not added and not removed:
            continue
        parts = []
        if removed:
            parts.append("no longer listed: " + ", ".join(removed))
        if added:
            parts.append("newly listed: " + ", ".join(added))
        where = "state franchise-tax report" if src == "tx-comptroller-pir" else "company website"
        title = f"Officer change on the {where}: " + "; ".join(parts)
        tag = re.sub(r"[^a-z0-9]+", "-", ("|".join(sorted(added)) + "/" + "|".join(sorted(removed))).lower())[:80]
        url = f"{snaps[0][1]}#officer-change-{snaps[0][2][:10]}-{tag}"
        if insert_signal(con, company_id, "officer-change", title, url, snaps[0][2][:10], 5.0):
            new += 1
    return new


# ---------------------------------------------------------------------------
# GDELT
# ---------------------------------------------------------------------------

def gdelt(query: str) -> list[dict]:
    """GDELT DOC artlist. [] on any failure or rate limit (fail soft)."""
    if time.monotonic() < _gdelt_state["cooled_until"]:
        return []
    url = GDELT + "?" + urllib.parse.urlencode({"query": query, "mode": "artlist", "format": "json",
                                                "maxrecords": "50", "sort": "datedesc"})
    for attempt in range(2):
        _gdelt_state["calls"] += 1
        if not pe.robots_allows(url):
            return []
        status, _, body = pe._raw_get(url, gap=GDELT_GAP, accept="application/json")
        if status == 200 and not (body or "").strip():
            return []  # GDELT answers an empty body when nothing matched
        if body and body.lstrip().startswith("{"):
            _gdelt_state["cooldowns"] = 0
            try:
                return json.loads(body).get("articles", []) or []
            except Exception:
                return []
        if "limit requests" in (body or "") or not body:
            _gdelt_state["limited"] += 1
            time.sleep(12 * (attempt + 1))
            continue
        return []
    _gdelt_state["cooldowns"] = _gdelt_state.get("cooldowns", 0) + 1
    # give GDELT two minutes before asking again; after three refusals, stop asking this run
    _gdelt_state["cooled_until"] = time.monotonic() + (10 ** 9 if _gdelt_state["cooldowns"] >= 3 else 120)
    return []


def _iso(seen: str) -> str | None:
    return f"{seen[:4]}-{seen[4:6]}-{seen[6:8]}" if seen and len(seen) >= 8 else None


def owner_news_match(title: str, owner: str, company: dict) -> bool:
    """Owner's surname AND (company word or city) AND an owner-event word in the headline. Pure."""
    t = (title or "").lower()
    last = pe.last_name(owner).lower()
    if not last or len(last) < 3 or not re.search(rf"\b{re.escape(last)}\b", t):
        return False
    if not any(w in t for w in OWNER_WORDS):
        return False
    city = (company.get("city") or "").lower()
    toks = [x for x in pe.core_tokens(company.get("name") or "") if len(x) >= 4]
    return bool((city and city in t) or any(re.search(rf"\b{re.escape(x)}\b", t) for x in toks))


def owner_news(company: dict, owner: str) -> list[dict]:
    """owner-news signal rows (not yet stored). Network only, no database."""
    q = f'"{owner}" (retire OR retirement OR obituary OR sells OR succession) sourcecountry:US'
    out = []
    for a in gdelt(q):
        title = (a.get("title") or "").strip()
        if not owner_news_match(title, owner, company):
            continue
        w = 6.0 if re.search(r"obituar|passed away|retir", title, re.I) else 4.0
        out.append({"kind": "owner-news", "title": f"{owner}: {title}", "url": a.get("url") or "",
                    "observed_at": _iso(a.get("seendate") or ""), "weight": w})
    return out


def press_kind(domain: str) -> str:
    d = (domain or "").lower().removeprefix("www.")
    return "business-journal" if any(d == p or d.endswith("." + p) for p in BUSINESS_PRESS) else "news"


def company_news(company: dict) -> list[dict]:
    """business-journal / news signal rows (not yet stored). Network only, no database."""
    name = " ".join(w for w in re.findall(r"[A-Za-z0-9&']+", company["name"])
                    if w.lower().strip(".") not in {"llc", "inc", "ltd", "lp", "l", "p", "c", "co", "corp", "company", "the"})
    if len(name) < 6:
        return []
    out = []
    for a in gdelt(f'"{name}" sourcecountry:US'):
        title = (a.get("title") or "").strip()
        conf = pe.news_match(title, a.get("domain") or "", a.get("url") or "", company)
        kind = press_kind(a.get("domain") or "")
        # a Texas outlet (or a Texas edition of the Business Journals) is itself the place proof
        texas_outlet = kind == "business-journal" and (
            "bizjournals.com" not in (a.get("domain") or "")
            or re.search(r"bizjournals\.com/(dallas|houston|austin|sanantonio)/", a.get("url") or ""))
        if conf != "confirmed" and not (conf == "unconfirmed" and texas_outlet):
            continue
        weight = 3.0 if kind == "business-journal" else 2.0
        if pe.ownership_from_headline(title, company["name"]):
            weight += 2.0
        out.append({"kind": kind, "title": title, "url": a.get("url") or "",
                    "observed_at": _iso(a.get("seendate") or ""), "weight": weight})
    return out
