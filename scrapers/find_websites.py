#!/usr/bin/env python3
"""
find_websites.py - find the real website of a registry company that has no domain.

Stdlib only. Public sources only, no login, no paid API, no LLM call.
Reuses profile_enrich.py for polite fetching (robots.txt obeyed, 1 request per
second per host, capped body reads) and for text parsing.

HOW A WEBSITE IS FOUND
----------------------
1. candidate_domains(): the legal name is cut down to the words that make it
   distinctive (LLC / Inc / Ltd / Co / Corp / Group / Holdings / Services / The
   ... removed) and turned into a short, ordered list of spellings: joined,
   hyphenated, common abbreviations (mfg, equip, fab), an "and" form, a "tx"
   suffix, initials, and .com / .net / .us.
2. Each candidate is resolved with DNS-over-HTTPS (dns.google and
   cloudflare-dns.com, the same kind of lookup as the MX check). No SMTP, no
   port scan: an A record either exists or it does not.
3. The homepage of a resolving candidate is fetched (plus /contact and /about
   when the homepage does not show where the company is).

WHEN A WEBSITE IS ACCEPTED (identity proof, never a name alone)
--------------------------------------------------------------
  confirmed    the company name matches STRONGLY (the full name is printed on
               the page, or every distinctive name word is on the page and one
               is in the site title or domain) AND the page shows the company's
               Texas city, its registered street address, a Texas address with
               a Texas ZIP, or a Texas phone area code.
  unconfirmed  the name matches strongly but no Texas location is shown, or the
               name matches only weakly but the city is shown. Stored as a
               profile fact labelled unconfirmed, with the evidence, and the
               companies.domain column is NOT written.
  rejected     parked or for-sale domains, hosting placeholders ("coming soon",
               default server pages, suspended accounts), redirects to big
               brands, marketplaces or directories, and pages that do not name
               the company.

Every stored fact carries the URL of the page it was read from.

Usage:
  python scrapers/find_websites.py candidates --name "BARNETT & MCKEE CABINETS, L.L.C."
  python scrapers/find_websites.py check --name "Acme Steel, LLC" --city Dallas --html page.html --url https://acmesteel.com/
  python scrapers/find_websites.py run --db data/sample/harness.db --limit 20
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.parse
from collections import Counter
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import profile_enrich as pe  # noqa: E402

pe.TIMEOUT = 10  # house rule for the sourcing layer: 10 second timeout

# ---------------------------------------------------------------------------
# Request accounting + 429 back-off, wrapped around profile_enrich's fetcher so
# every request the sourcing pipeline makes (robots.txt included) is counted.
# ---------------------------------------------------------------------------
REQUESTS: Counter = Counter()
_orig_raw_get = pe._raw_get


HARD_CAP = 40  # seconds, wall clock, for any one request or DNS lookup (a stalled TLS handshake can hang for 30 minutes)


def with_deadline(fn, *a, default=None, seconds: float = HARD_CAP):
    """Run fn(*a) in a daemon thread; give up (and return default) after `seconds`."""
    box: dict = {}

    def run():
        try:
            box["v"] = fn(*a)
        except Exception:
            box["v"] = default
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(seconds)
    return box.get("v", default)


_LOCK = threading.Lock()


def _slot_throttle(host: str, gap: float) -> None:
    """Thread-safe 1-request-per-`gap`-seconds per host: each caller reserves the next free slot."""
    with _LOCK:
        now = time.monotonic()
        slot = max(now, pe._last_hit.get(host, 0.0) + gap)
        pe._last_hit[host] = slot
    if slot > now:
        time.sleep(slot - now)


pe._throttle = _slot_throttle  # the pipeline fetches several companies at once; hosts still get 1 request/second


def _counted_raw_get(url: str, gap: float = 1.0, accept: str = "text/html,application/xhtml+xml"):
    host = urllib.parse.urlparse(url).netloc.lower()
    for attempt in range(3):
        with _LOCK:
            REQUESTS[host] += 1
        status, final, body = with_deadline(lambda: _orig_raw_get(url, gap=gap, accept=accept), default=(0, url, ""))
        if status != 429:
            return status, final, body
        time.sleep(5 * (attempt + 1))  # back off, then try again at most twice
    return status, final, body


pe._raw_get = _counted_raw_get


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# 1. Name -> candidate domains (pure)
# ---------------------------------------------------------------------------
# Legal-form words: never part of a domain.
LEGAL_WORDS = {
    "llc", "inc", "incorporated", "ltd", "limited", "liability", "lp", "llp", "pllc", "pc",
    "corp", "corporation", "company", "co", "the", "gp", "lc", "plc", "pa",
}
# Words that describe the business shape rather than the name. Dropped for the
# "core" spelling, kept for the "full" spelling.
SOFT_WORDS = {
    "group", "holdings", "holding", "services", "service", "enterprises", "enterprise", "international",
    "of", "texas", "tx", "usa", "us", "america", "american", "and", "no", "i", "ii", "iii", "iv",
}
ABBREV = {
    "manufacturing": "mfg", "equipment": "equip", "fabrication": "fab", "fabricators": "fab",
    "industries": "ind", "industrial": "ind", "international": "intl", "products": "prod",
    "technologies": "tech", "technology": "tech", "machine": "mach", "precision": "prec",
}


def name_tokens(name: str) -> list[str]:
    """Lower-case word tokens of a legal name, legal-form words removed, & read as 'and'."""
    s = (name or "").lower().replace("&", " and ").replace("'", "")
    s = re.sub(r"\bl\.\s*l\.\s*c\.?", " llc ", s)
    s = re.sub(r"\bl\.\s*p\.?", " lp ", s)
    s = re.sub(r"\bno\.\s*\d+\b", " ", s)          # "INDUSTRIAL NO. 1"
    s = re.sub(r"#\s*\d+\b", " ", s)
    s = s.replace(" - ", " ")
    toks = re.findall(r"[a-z0-9]+", s)
    toks = [t for t in toks if t not in LEGAL_WORDS]
    # a trailing roman numeral or "texas" on a legal name is a filing suffix, not the brand
    while toks and toks[-1] in {"i", "ii", "iii", "iv", "texas", "tx"} and len(toks) > 1:
        toks.pop()
    return toks


def core_tokens(name: str) -> list[str]:
    toks = name_tokens(name)
    core = [t for t in toks if t not in SOFT_WORDS]
    return core or [t for t in toks if t != "and"]


def candidate_domains(name: str, max_n: int = 10) -> list[str]:
    """Ordered, de-duplicated candidate domains for a legal name. Pure; no network."""
    full = [t for t in name_tokens(name)]
    core = core_tokens(name)
    if not core:
        return []
    labels: list[str] = []

    def add(label: str):
        label = re.sub(r"[^a-z0-9-]", "", label).strip("-")
        if 5 <= len(label.replace("-", "")) <= 40 and label not in labels:
            labels.append(label)

    full_no_and = [t for t in full if t != "and"]
    add("".join(core))                                   # barnettmckeecabinets
    if len(core) >= 4:
        add("".join(core[:2]))                           # long names: the first two words are the brand
    add("".join(full_no_and))                            # ...incl. services / group
    if "and" in full:
        add("".join(t for t in full if t not in SOFT_WORDS or t == "and"))  # barnettandmckeecabinets
    if len(core) > 1:
        add("-".join(core))                              # barnett-mckee-cabinets
    abbr = [ABBREV.get(t, t) for t in core]
    if abbr != core:
        add("".join(abbr))                               # tjmachtool / acmemfg
    add("".join(core) + "tx")                            # acmesteeltx
    if len(core) >= 3:
        add("".join(core[:2]))                           # first two words
        add("".join(t[0] for t in core[:-1]) + core[-1]) # initials + last word: bmcabinets
    if len(core) == 2 and len(core[0]) >= 5:
        add(core[0] + "tx")
    base = labels[:]
    out = [f"{lb}.com" for lb in base]
    first = "".join(core)
    for tld in ("net", "us"):
        if 5 <= len(first) <= 40:
            out.append(f"{first}.{tld}")
    seen, uniq = set(), []
    for d in out:
        if d not in seen:
            seen.add(d)
            uniq.append(d)
    return uniq[:max_n]


# ---------------------------------------------------------------------------
# 2. Page verdicts (pure)
# ---------------------------------------------------------------------------
PARKED_PATTERNS = [
    r"this domain (?:name )?(?:is|may be) for sale", r"buy this domain", r"domain (?:is )?for sale",
    r"make (?:an )?offer on this domain", r"this domain has (?:been registered|expired)",
    r"hugedomains", r"afternic", r"\bsedo\b", r"dan\.com", r"undeveloped\.com", r"parkingcrew",
    r"bodis\.com", r"above\.com", r"domain parking", r"parked (?:free|domain|by)",
    r"related searches", r"the domain name .{0,40} is (?:available|registered)",
    r"future home of something quite cool", r"godaddy\.com/.{0,20}domain",
]
PLACEHOLDER_PATTERNS = [
    r"\bcoming soon\b", r"under construction", r"website (?:is )?(?:coming soon|under construction)",
    r"apache2? (?:ubuntu|debian)? ?default page", r"welcome to nginx", r"it works!",
    r"account (?:has been )?suspended", r"this account has been suspended", r"index of /",
    r"default web ?site page", r"iis windows server", r"site not found", r"no website configured",
    r"launching soon", r"web hosting by", r"cpanel", r"plesk", r"this site can.t be reached",
    r"just another wordpress site",
]
# Where a redirect or a page belonging to someone else ends up. Never the company.
BIG_HOSTS = (
    "facebook.com", "linkedin.com", "instagram.com", "twitter.com", "x.com", "youtube.com", "google.com",
    "amazon.com", "ebay.com", "yelp.com", "bbb.org", "mapquest.com", "yellowpages.com", "manta.com",
    "godaddy.com", "wix.com", "squarespace.com", "weebly.com", "shopify.com", "wordpress.com",
    "homedepot.com", "lowes.com", "walmart.com", "microsoft.com", "apple.com", "bizbuysell.com",
    "opencorporates.com", "bizapedia.com", "dnb.com", "zoominfo.com", "indeed.com", "glassdoor.com",
    "sedo.com", "afternic.com", "hugedomains.com", "dan.com", "buydomains.com", "namecheap.com",
    "networksolutions.com", "register.com", "hostgator.com", "bluehost.com", "ionos.com",
    "domainlions.com", "domainmarket.com", "brandbucket.com", "squadhelp.com", "atom.com", "perfectdomain.com",
    "epik.com", "undeveloped.com", "efty.com", "sav.com", "porkbun.com", "dynadot.com",
)
# Second-level public suffixes: the registrable domain is three labels deep.
TWO_LEVEL_SUFFIXES = {"co.uk", "org.uk", "ac.uk", "com.au", "net.au", "co.nz", "com.mx", "com.br", "co.za",
                      "co.in", "co.jp", "com.cn", "com.sg", "co.il", "com.tr", "com.ar"}

TX_AREA_CODES = (
    "210", "214", "254", "281", "325", "346", "361", "409", "430", "432", "469", "512", "682",
    "713", "726", "737", "806", "817", "830", "832", "903", "915", "936", "940", "945", "956", "972", "979",
)
TX_PHONE_RE = re.compile(r"(?<!\d)\(?(" + "|".join(TX_AREA_CODES) + r")\)?[\s.\-]?\d{3}[\s.\-]\d{4}(?!\d)")
TX_ADDR_RE = re.compile(r"\b(?:TX|Tx|Texas|TEXAS)\.?,?\s+(7[5-9]\d{3}|88[5-9]\d{2})(?:-\d{4})?\b")

GENERIC_NAME_WORDS = {
    "manufacturing", "mfg", "products", "product", "industries", "industrial", "industry", "company",
    "group", "services", "service", "solutions", "systems", "international", "enterprises", "holdings",
    "texas", "usa", "america", "american", "national", "north", "south", "east", "west", "the", "and",
    "equipment", "supply", "metals", "metal", "steel", "tool", "tools", "machine", "precision",
    "fabrication", "cabinets", "printing", "packaging", "concrete", "electronics", "furniture",
    "specialists", "specialist", "sales", "custom", "works", "shop", "parts", "plastics", "wire",
    "machinery", "machining", "machines", "fabricators", "fabricating", "welding", "tooling", "instruments",
    "supplies", "structures", "buildings", "coatings", "cabinetry", "millwork", "technologies", "technology",
}


def registrable(host: str) -> str:
    host = (host or "").lower().split(":")[0].removeprefix("www.")
    parts = host.split(".")
    if len(parts) >= 3 and ".".join(parts[-2:]) in TWO_LEVEL_SUFFIXES:
        return ".".join(parts[-3:])
    return ".".join(parts[-2:]) if len(parts) >= 2 else host


def _norm_join(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower().replace("&", "and"))


def page_title(body: str) -> str:
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", body or "")
    t = pe.htmllib.unescape(re.sub(r"\s+", " ", m.group(1))).strip() if m else ""
    site = pe.meta_content(body or "", "og:site_name") or ""
    return f"{t} {site}".strip()


def page_kind(body: str, text: str) -> str | None:
    """'parked', 'placeholder', 'thin' or None for a real page."""
    low = (text or "").lower() + " " + page_title(body).lower()
    if any(re.search(p, low) for p in PARKED_PATTERNS):
        return "parked"
    words = len(re.findall(r"[a-zA-Z]{2,}", text or ""))
    if words < 400 and any(re.search(p, low) for p in PLACEHOLDER_PATTERNS):
        return "placeholder"
    if words < 25:
        return "thin"
    return None


def name_match(name: str, text: str, title: str, host: str) -> tuple[str, str]:
    """('strong'|'weak'|'none', evidence). The page text is the visible text of the page."""
    core = core_tokens(name)
    joined = "".join(t for t in name_tokens(name) if t != "and")
    page = _norm_join(text) + " " + _norm_join(title)
    distinct = [t for t in core if t not in GENERIC_NAME_WORDS and len(t) >= 2] or core
    words = set(re.findall(r"[a-z0-9]+", (text + " " + title).lower().replace("&", " and ")))
    host_n = _norm_join(registrable(host).split(".")[0])
    title_n = _norm_join(title)
    if len(joined) >= 7 and joined in page:
        return "strong", f"full name '{' '.join(name_tokens(name))}' printed on the page"
    core_joined = "".join(core)
    if all(t in GENERIC_NAME_WORDS for t in core):
        # "American Machinery Group" -> only "machinery" is left: a generic word proves nothing
        return "none", f"only generic name words ({', '.join(core)}) to match on"
    if len(core_joined) >= 7 and core_joined in page and (len(core) >= 2 or core_joined in host_n):
        return "strong", f"name '{' '.join(core)}' printed on the page"
    if distinct and all(t in words for t in core) and any(t in title_n or t in host_n for t in distinct if len(t) >= 3):
        return "strong", f"every name word ({', '.join(core)}) on the page and in the site title or domain"
    hits = [t for t in distinct if len(t) >= 4 and t in words]
    if hits and any(t in host_n for t in hits):
        return "weak", f"name word(s) {', '.join(hits)} on the page and in the domain"
    return "none", "the page does not name the company"


def location_evidence(text: str, city: str | None, registered_address: str | None) -> list[str]:
    """Texas location proof printed on the page. Each item is a plain-English line."""
    ev: list[str] = []
    t = text or ""
    if city and re.search(rf"\b{re.escape(city.strip())}\b", t, re.I):
        ev.append(f"city '{city.strip()}' on the page")
    if registered_address:
        m = re.match(r"\s*(\d{2,6})\s+([A-Za-z][A-Za-z]+)", registered_address)
        if m and re.search(rf"\b{m.group(1)}\s+(?:[NSEW]\.?\s+)?{re.escape(m.group(2))}\b", t, re.I):
            ev.append(f"registered street address '{m.group(1)} {m.group(2)}' on the page")
    reg_zip = re.search(r"\b(7[5-9]\d{3})\b", registered_address or "")
    zips = [m.group(1) for m in TX_ADDR_RE.finditer(t)]
    near = [z for z in zips if reg_zip and z[:3] == reg_zip.group(1)[:3]]
    if near:
        ev.append(f"Texas ZIP {near[0]} on the page, same area as the registered ZIP {reg_zip.group(1)}")
    elif zips:
        ev.append(f"Texas address with ZIP {zips[0]} on the page")
    p = TX_PHONE_RE.search(t)
    if p:
        ev.append(f"Texas phone area code {p.group(1)} on the page")
    return ev


def judge(name: str, city: str | None, registered_address: str | None, pages: list[tuple[str, str]],
          candidate_host: str) -> dict:
    """Verdict for one candidate site. pages = [(final_url, html)], homepage first. Pure."""
    if not pages:
        return {"verdict": "rejected", "reason": "unreachable", "evidence": []}
    home_url, home = pages[0]
    final_host = urllib.parse.urlparse(home_url).netloc.lower()
    reg_final = registrable(final_host)
    if any(reg_final == b or reg_final.endswith("." + b) for b in BIG_HOSTS):
        return {"verdict": "rejected", "reason": f"redirects to {reg_final}", "evidence": [], "host": reg_final}
    if registrable(candidate_host) != reg_final:
        # a redirect is followed only to a domain that still carries a name word
        label = _norm_join(reg_final.split(".")[0])
        words = [t for t in core_tokens(name) if len(t) >= 3]
        if not any(t in label for t in words):
            return {"verdict": "rejected", "reason": f"redirects to an unrelated domain ({reg_final})", "evidence": [],
                    "host": reg_final}
    home_text = pe.visible_text(home)
    kind = page_kind(home, home_text)
    if kind:
        return {"verdict": "rejected", "reason": f"{kind} page", "evidence": [], "host": reg_final}
    all_text = "\n".join(pe.visible_text(b) for _, b in pages)
    strength, name_ev = name_match(name, home_text + "\n" + all_text, page_title(home), final_host)
    loc = location_evidence(all_text, city, registered_address)
    evidence = [name_ev] + loc
    if registrable(candidate_host) != reg_final:
        evidence.append(f"{candidate_host} redirects to {reg_final}")
    city_hit = any(e.startswith(("city ", "registered street", "Texas ZIP ")) for e in loc)
    full_name = name_ev.startswith(("full name", "name '"))
    # Texas-only proof (a Texas ZIP or area code somewhere else in the state) is
    # enough only when the whole name is printed; a page that merely has every
    # name word needs the company's own city, street or ZIP area.
    # A page whose only address is a Texas ZIP in a different area from the
    # registered one is more likely a same-name company elsewhere in the state.
    far_zip = (not city_hit and registered_address and re.search(r"\b7[5-9]\d{3}\b", registered_address)
               and any(e.startswith("Texas address with ZIP") for e in loc))
    if strength == "strong" and (city_hit or (loc and full_name and not far_zip)):
        return {"verdict": "confirmed", "reason": "name and Texas location on the site", "evidence": evidence, "host": reg_final}
    if strength == "strong" and far_zip:
        return {"verdict": "unconfirmed", "reason": "name matches but the Texas address is in another area",
                "evidence": evidence, "host": reg_final}
    if strength == "strong":
        return {"verdict": "unconfirmed", "reason": "name matches but no Texas location shown", "evidence": evidence, "host": reg_final}
    if strength == "weak" and city_hit:
        return {"verdict": "unconfirmed", "reason": "partial name match with the city shown", "evidence": evidence, "host": reg_final}
    return {"verdict": "rejected", "reason": name_ev, "evidence": evidence, "host": reg_final}


# ---------------------------------------------------------------------------
# 3. Network
# ---------------------------------------------------------------------------
DOH = ("https://dns.google/resolve?type=A&name=", "https://cloudflare-dns.com/dns-query?type=A&name=")
_doh_turn = [0]
# Some networks (this desk's included, 2026-09-28) block every DNS-over-HTTPS
# endpoint at the connection level. After two connection failures in a row the
# run switches to the operating system's own resolver, which answers the same
# question (does this name have an address record) without HTTP.
DOH_STATE = {"fails": 0, "disabled": False, "system_lookups": 0}


def _system_resolves(host: str) -> bool | None:
    import socket
    DOH_STATE["system_lookups"] += 1

    def look():
        try:
            socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
            return True
        except socket.gaierror:
            return False
        except OSError:
            return None
    return with_deadline(look, default=None, seconds=10)


def resolves(host: str) -> bool | None:
    """A record via DNS-over-HTTPS (system resolver when DoH is blocked). None = lookup failed."""
    if DOH_STATE["disabled"]:
        return _system_resolves(host)
    for _ in range(2):
        base = DOH[_doh_turn[0] % len(DOH)]
        _doh_turn[0] += 1
        status, _, body = pe._raw_get(base + urllib.parse.quote(host), accept="application/dns-json")
        if status == 0:
            DOH_STATE["fails"] += 1
            if DOH_STATE["fails"] >= 2:
                DOH_STATE["disabled"] = True
                return _system_resolves(host)
            continue
        DOH_STATE["fails"] = 0
        if status == 200 and body:
            try:
                data = json.loads(body)
            except Exception:
                continue
            if data.get("Status") == 3:  # NXDOMAIN
                return False
            return any(a.get("type") in (1, 5) for a in data.get("Answer") or [])
    return None


def has_mx(domain: str) -> tuple[bool | None, str]:
    """(has MX, how it was checked). DNS only, never an SMTP conversation."""
    if not DOH_STATE["disabled"]:
        status, _, body = pe._raw_get("https://dns.google/resolve?type=MX&name=" + urllib.parse.quote(domain),
                                      accept="application/dns-json")
        if status == 200 and body:
            try:
                return bool(json.loads(body).get("Answer")), "https://dns.google/resolve?type=MX&name=" + domain
            except Exception:
                pass
        if status == 0:
            DOH_STATE["disabled"] = True
    import subprocess
    try:
        out = subprocess.run(["nslookup", "-type=mx", domain], capture_output=True, text=True, timeout=10).stdout
    except Exception:
        return None, ""
    if re.search(r"mail exchanger|MX preference", out, re.I):
        return True, "dns:MX " + domain
    # only the zone's SOA came back (no mail exchanger line): the domain has no MX
    if re.search(r"Non-existent domain|No answer|can't find|primary name server|\*\*\*", out, re.I):
        return False, "dns:MX " + domain
    return None, ""


def fetch_home(host: str) -> tuple[str, str]:
    url, body = pe.polite_get(f"https://{host}/")
    if not body:
        url, body = pe.polite_get(f"http://{host}/")
    return url, body


def extra_pages(home_url: str, home: str, want: int = 2) -> list[tuple[str, str]]:
    """Contact / About pages from the site's own nav, else the usual paths."""
    links = [u for u, label in pe.nav_links(home, home_url)]
    contact = [m.group(1) for m in re.finditer(r'(?is)<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>\s*(?:<[^>]+>\s*)*contact', home)]
    urls = [urllib.parse.urljoin(home_url, c) for c in contact[:1]]
    urls += [u for u in pe.rank_links([(u, "") for u in links]) if re.search(r"about|contact|history|company", u, re.I)]
    urls += [urllib.parse.urljoin(home_url, p) for p in ("/contact", "/about", "/contact-us", "/about-us")]
    host = registrable(urllib.parse.urlparse(home_url).netloc)
    out, seen = [], {home_url.rstrip("/")}
    for u in urls:
        if registrable(urllib.parse.urlparse(u).netloc) != host or u.rstrip("/") in seen:
            continue
        seen.add(u.rstrip("/"))
        fu, b = pe.polite_get(u)
        if b and fu.rstrip("/") not in {p.rstrip("/") for p, _ in out}:
            out.append((fu, b))
        if len(out) >= want:
            break
    return out


def registry_notes(company: dict) -> dict:
    try:
        n = company.get("notes") or ""
        return json.loads(n) if n.startswith("{") else {}
    except Exception:
        return {}


def find_site(company: dict, max_homepages: int = 4) -> dict:
    """Try the candidates for one company. Returns the best verdict plus the fetched pages.

    Stops at the first confirmed site. Otherwise returns the first unconfirmed one.
    """
    notes = registry_notes(company)
    reg_addr = notes.get("registered_address")
    tried: list[dict] = []
    best: dict | None = None
    homepages = 0
    for host in candidate_domains(company["name"]):
        ok = resolves(host)
        if not ok:
            tried.append({"host": host, "result": "no DNS" if ok is False else "DNS lookup failed"})
            continue
        if homepages >= max_homepages:
            tried.append({"host": host, "result": "skipped (homepage cap)"})
            continue
        homepages += 1
        url, body = fetch_home(host)
        if not body:
            tried.append({"host": host, "result": "homepage unreachable or robots-disallowed"})
            continue
        pages = [(url, body)]
        v = judge(company["name"], company.get("city"), reg_addr, pages, host)
        if v["verdict"] == "unconfirmed" or (v["verdict"] == "rejected" and "does not name" not in v["reason"] and
                                              not re.search(r"parked|placeholder|thin|redirects|generic", v["reason"])):
            pages += extra_pages(url, body)
            v = judge(company["name"], company.get("city"), reg_addr, pages, host)
        elif v["verdict"] == "confirmed":
            pages += extra_pages(url, body, want=1)
        tried.append({"host": host, "result": f"{v['verdict']}: {v['reason']}"})
        if v["verdict"] == "confirmed":
            return {**v, "url": url, "pages": pages, "tried": tried}
        if v["verdict"] == "unconfirmed" and best is None:
            best = {**v, "url": url, "pages": pages}
    if best:
        return {**best, "tried": tried}
    return {"verdict": "none", "reason": "no candidate proved identity", "evidence": [], "pages": [], "tried": tried}


# ---------------------------------------------------------------------------
# 4. Store
# ---------------------------------------------------------------------------

def store_site(con: sqlite3.Connection, company: dict, res: dict) -> str:
    """Write the verdict. Returns 'confirmed', 'unconfirmed', 'conflict' or 'none'."""
    fetched = now_iso()
    verdict = res.get("verdict")
    if verdict not in ("confirmed", "unconfirmed"):
        con.execute("UPDATE companies SET website_checked_at=? WHERE id=?", (fetched, company["id"]))
        return "none"
    host = res["host"]
    note = "; ".join(res.get("evidence") or [])
    conf = verdict
    if verdict == "confirmed":
        clash = con.execute("SELECT id, name FROM companies WHERE domain=? AND id<>?", (host, company["id"])).fetchone()
        if clash:
            conf = "unconfirmed"
            note += f"; domain already on company #{clash[0]}"
        else:
            con.execute("UPDATE companies SET domain=?, updated_at=datetime('now') WHERE id=? AND (domain IS NULL OR domain='')",
                        (host, company["id"]))
    pe.upsert_fact(con, {
        "entity": "company", "entity_id": company["id"], "field": "website", "value": f"https://{host}",
        "source_url": res["url"], "source_label": "Company website", "confidence": conf,
        "match_basis": "find_websites: " + res.get("reason", ""), "note": note[:900],
    }, fetched)
    con.execute("UPDATE companies SET website_checked_at=? WHERE id=?", (fetched, company["id"]))
    return conf if not (verdict == "confirmed" and conf == "unconfirmed") else "conflict"


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("candidates", help="print the candidate domains for a name (no network)")
    c.add_argument("--name", required=True)
    k = sub.add_parser("check", help="judge a saved page (no network)")
    k.add_argument("--name", required=True)
    k.add_argument("--city")
    k.add_argument("--address")
    k.add_argument("--html", required=True)
    k.add_argument("--url", required=True)
    r = sub.add_parser("run", help="find websites for companies with no domain")
    r.add_argument("--db", required=True)
    r.add_argument("--limit", type=int, default=20)
    args = p.parse_args(argv)
    if args.cmd == "candidates":
        print(json.dumps(candidate_domains(args.name), indent=1))
        return 0
    if args.cmd == "check":
        body = open(args.html, encoding="utf-8", errors="replace").read()
        v = judge(args.name, args.city, args.address, [(args.url, body)], urllib.parse.urlparse(args.url).netloc)
        print(json.dumps(v, indent=1))
        return 0
    con = sqlite3.connect(args.db)
    con.row_factory = sqlite3.Row
    pe.ensure_schema(con)
    rows = con.execute("""SELECT id, name, city, notes FROM companies WHERE (domain IS NULL OR domain='')
                          ORDER BY id LIMIT ?""", (args.limit,)).fetchall()
    for row in rows:
        company = dict(row)
        res = find_site(company)
        print(f"[{company['id']}] {company['name']}: {res['verdict']} {res.get('host', '')} ({res.get('reason')})")
        store_site(con, company, res)
        con.commit()
    con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
