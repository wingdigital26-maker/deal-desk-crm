#!/usr/bin/env python3
"""
fit_score.py - how well a company fits a lower-middle-market sell-side mandate.

Stdlib only. No network of its own, no LLM call. Reads the website pages that
find_websites.py already fetched (and the registry row), and produces:

  fit_score     0-100, stored on companies.fit_score (companies.signal_score is
                never touched here)
  fit_reasons   one plain-English line per reason, stored as profile_facts rows
                (field 'fit_reasons'), each with the URL of the page it came from
  industry_tag  the keyword-taxonomy industry, stored as a profile fact

The target: founder-owned Texas operating companies with roughly $3M-$20M of
EBITDA. The score rewards what such a company looks like from the outside
(an operating industry, 15+ years in business, a real headcount, a fleet or a
plant, certifications, family or founder ownership) and caps anything that is
not an operating business (holding and property shells, churches, HOAs,
residential real estate, single restaurants, no working website).

Nothing is guessed: every point is tied to text printed on a page or in the
state registry. A company with no confirmed website is scored from its name and
registry row only and can never reach the "good fit" line (60).

Usage:
  python scrapers/fit_score.py classify --name "Acme Steel LLC" --html about.html --url https://acme.com/about
"""

import argparse
import json
import os
import re
import sys
import urllib.parse
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import profile_enrich as pe  # noqa: E402

THIS_YEAR = datetime.now().year
GOOD_FIT = 60

# ---------------------------------------------------------------------------
# Industry taxonomy. label -> (points, [regex]). Counted on the site text; the
# legal name counts double. Points reflect how often the industry produces
# founder-owned $3M-$20M EBITDA sell-side mandates.
# ---------------------------------------------------------------------------
INDUSTRIES: dict[str, tuple[int, list[str]]] = {
    "Manufacturing": (22, [r"manufactur\w*", r"fabricat\w*", r"machin(?:ing|e shop)", r"\bcnc\b", r"weld\w*",
                           r"stamping", r"injection mold\w*", r"extrusion", r"foundry", r"castings?", r"assembly",
                           r"\bplant\b", r"production facility", r"millwork", r"powder coat\w*", r"sheet metal",
                           r"tool (?:and|&) die", r"\boem\b", r"precision parts"]),
    "Distribution": (20, [r"distribut\w*", r"wholesal\w*", r"supplier of", r"\binventory\b", r"warehouse\w*",
                          r"stocking", r"\bline card\b", r"master distributor", r"same[- ]day shipping"]),
    "Industrial services": (20, [r"industrial services", r"maintenance services", r"\brepair\b", r"field service",
                                 r"calibration", r"inspection", r"rebuild\w*", r"millwright", r"rigging",
                                 r"industrial cleaning", r"\brentals?\b"]),
    "Construction and trades": (16, [r"general contractor", r"\bconstruction\b", r"\bhvac\b", r"plumbing",
                                     r"electrical contractor", r"roofing", r"concrete", r"paving", r"excavat\w*",
                                     r"site work", r"commercial contractor", r"mechanical contractor", r"fire protection"]),
    "Transportation and logistics": (15, [r"trucking", r"freight", r"logistics", r"\bfleet\b", r"hauling",
                                          r"\bltl\b", r"\bftl\b", r"dispatch", r"heavy haul", r"transportation services"]),
    "Energy services": (18, [r"oilfield", r"oil (?:and|&) gas", r"pipeline", r"well ?site", r"midstream",
                             r"upstream", r"drilling", r"frac\b", r"compression", r"utility services", r"power generation"]),
    "Food production": (18, [r"food (?:processing|production|manufactur\w*)", r"\bbakery\b", r"co-?packer",
                             r"\bsqf\b", r"\bhaccp\b", r"\busda\b", r"meat processing", r"beverage"]),
    "Healthcare services": (12, [r"home health", r"medical practice", r"clinic", r"dental", r"physical therapy",
                                 r"patients?", r"hospice", r"medical billing", r"pharmacy"]),
    "Business services": (12, [r"staffing", r"consulting", r"outsourc\w*", r"managed services", r"it services",
                               r"janitorial", r"facility services", r"security services", r"printing services",
                               r"marketing services", r"engineering services"]),
    "Environmental services": (16, [r"environmental services", r"waste management", r"recycling", r"remediation",
                                    r"hazardous waste", r"disposal"]),
    # A shop that sells to the public: rarely a sell-side mandate at this size.
    "Retail": (4, [r"\b(?:furniture|retail|our|the) store\b", r"showroom", r"shop now", r"add to cart",
                   r"shop online", r"in[- ]store", r"\bretail\b", r"free delivery"]),
}

# Not an operating target. Any hit caps the score at 10 and says why.
EXCLUSIONS: list[tuple[str, str]] = [
    (r"\b(?:holdings?|investments?|investors|capital|ventures?|equities)\b", "holding or investment entity"),
    (r"\b(?:properties|property|realty|real estate|land|apartments?|leasing)\b", "property or real-estate entity"),
    (r"\b(?:ministr(?:y|ies)|church|chapel|temple|mosque|congregation|diocese)\b", "church or ministry"),
    (r"\b(?:homeowners|hoa|owners association|condominium|property owners)\b", "homeowners association"),
    (r"\b(?:trust|estate of|family limited partnership|flp)\b", "trust or family estate"),
    (r"\bmanagement(?: company| co| llc| inc)?\b(?!.*\b(?:manufactur|fabricat|machin|steel|equipment)\w*)", "management-company shell"),
    (r"\b(?:gp|general partner)\b", "general-partner shell of another entity"),
    (r"\b(?:surgery|surgical|dds|dmd|md|pllc|law firm|attorneys?|cpas?)\b", "professional practice (medical, dental, legal)"),
]
# Only read from the site text (not the name): signs the business is a single
# restaurant, a residential realtor, or a practice too small for a mandate.
SITE_EXCLUSIONS: list[tuple[str, str]] = [
    (r"\b(?:our menu|order online|reservations|happy hour|dine[- ]in)\b", "restaurant"),
    (r"\b(?:homes for sale|list your home|mls listings?|buy(?:ing)? a home|realtor)\b", "residential real estate"),
    (r"\b(?:sunday service|worship|sermons?)\b", "church or ministry"),
]

FAMILY_RE = re.compile(r"\bfamily[- ](?:owned|run|operated)\b|\bfounder[- ](?:owned|led)\b|\bowner[- ]operated\b"
                       r"|\bfounded by\b|\bowned and operated by\b|\bthird[- ]generation\b|\bsecond[- ]generation\b", re.I)
PE_RE = re.compile(r"\bportfolio company\b|\bbacked by\b[^.\n]{0,60}(?:capital|partners|equity)|\ba subsidiary of\b"
                   r"|\ba division of\b|\bNYSE\b|\bNASDAQ\b|\bacquired by\b", re.I)
FLEET_RE = re.compile(r"\b(?:fleet of|over|more than)\s+(\d{2,4})\+?\s+(?:trucks|vehicles|tractors|trailers|units|service vans)\b", re.I)
SQFT_RE = re.compile(r"\b(\d{1,3}(?:,\d{3})+|\d{4,7})\s*(?:\+\s*)?(?:sq\.?\s?ft\.?|square[- ]f(?:oo|ee)t)\b", re.I)
LOCATIONS_RE = re.compile(r"\b(\d{1,2}|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty)\s+"
                          r"(?:locations|branches|offices|facilities|plants|warehouses|service centers|yards)\b", re.I)
WORDNUM = {"two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
           "twelve": 12, "fifteen": 15, "twenty": 20}


def quote(text: str, a: int, b: int, pad: int = 60) -> str:
    """A short, clean quote around text[a:b]: whole words only, no stray symbols."""
    lo = text.rfind("\n", 0, a) + 1
    hi = text.find("\n", b)
    hi = len(text) if hi < 0 else hi
    lo, hi = max(lo, a - pad), min(hi, b + pad)
    q = text[lo:hi]
    if lo > 0 and not text[lo - 1].isspace():
        q = q.split(" ", 1)[-1]
    if hi < len(text) and not text[hi].isspace():
        q = q.rsplit(" ", 1)[0]
    q = re.sub(r"[^\w\s.,;:'&()/-]", " ", q)
    return re.sub(r"\s+", " ", q).strip(" ,;:-")


def public_parent(name: str, text: str) -> tuple[str, str] | None:
    """(parent, phrase) when the name leads with an SEC registrant's name AND the site says so.

    "ARCOSA SHORING PRODUCTS" leads with Arcosa (SEC list) and its footer reads
    "Arcosa, Inc.". The name alone is never enough: plenty of private companies
    share a first word with some public one. Fails soft when the SEC list is absent.
    """
    try:
        import tx_registry as tr
        public = tr._sec_names()
    except Exception:
        return None
    if not public:
        return None
    toks = re.findall(r"[a-z0-9]+", (name or "").lower())
    for k in (2, 1):
        if len(toks) <= k:
            continue
        lead = "".join(toks[:k])
        if len(lead) < 5 or lead in {"texas", "american", "national", "united", "southern", "northern"} or lead not in public:
            continue
        words = r"\s+".join(re.escape(t) for t in toks[:k])
        m = re.search(rf"\b{words},?\s+(?:Inc|Corp|Corporation|Company)\b\.?|\ban?\s+{words}\s+company\b|\b{words}\b[^.\n]{{0,40}}\b(?:NYSE|NASDAQ)\b",
                      text or "", re.I)
        if m:
            return " ".join(toks[:k]).title(), m.group(0)
    return None


def _hits(pats: list[str], text: str) -> int:
    return sum(len(re.findall(p, text, re.I)) for p in pats)


# Words in a LEGAL NAME that point at an industry. Read from the name only (a site
# that says "steel" may just sell to steel mills). Each hit counts double.
NAME_HINTS: dict[str, list[str]] = {
    "Manufacturing": [r"manufactur\w*", r"\bmfg\b", r"fabricat\w*", r"machin\w*", r"\btool(?:s|ing)?\b",
                      r"\bsteel\b", r"\bmetals?\b", r"metal ?works", r"plastics?\b(?! surgery)", r"cabinet\w*", r"millwork",
                      r"furniture", r"printing", r"packaging", r"\bwire\b", r"castings?", r"stamping\w*",
                      r"extrusions?", r"coatings?", r"welding", r"iron ?works", r"electronics", r"instruments?",
                      r"\bproducts\b", r"precision", r"\bmolds?\b", r"\bfoam\b", r"\bglass\b"],
    "Distribution": [r"\bsupply\b", r"\bsupplies\b", r"wholesale", r"distribut\w*", r"\bsales\b", r"\bequipment\b"],
    "Industrial services": [r"equipment services", r"industrial services", r"\brepair\b", r"\bmaintenance\b"],
    "Energy services": [r"oilfield", r"\benergy\b", r"pipe ?line", r"\bwell\b", r"drilling", r"\bpetro\w*"],
    "Construction and trades": [r"construction", r"concrete", r"roofing", r"plumbing", r"\bhvac\b", r"\belectric\b",
                                r"contractors?", r"builders?", r"paving"],
    "Transportation and logistics": [r"trucking", r"freight", r"logistics", r"transport\w*", r"hauling"],
    "Food production": [r"\bfoods?\b", r"bakery", r"\bmeats?\b", r"beverage"],
}


def classify_industry(name: str, text: str) -> tuple[str | None, int]:
    """(industry label, hit count). The legal name counts double."""
    best, best_n = None, 0
    for label, (_, pats) in INDUSTRIES.items():
        n = _hits(pats, text or "") + 2 * _hits(pats + NAME_HINTS.get(label, []), name or "")
        if n > best_n:
            best, best_n = label, n
    return (best, best_n) if best_n >= 2 else (None, best_n)


def exclusion(name: str, text: str) -> str | None:
    n = (name or "").lower()
    for pat, why in EXCLUSIONS:
        if re.search(pat, n, re.I):
            return why
    t = (text or "")
    for pat, why in SITE_EXCLUSIONS:
        if len(re.findall(pat, t, re.I)) >= 2:
            return why
    return None


def size_clues(text: str) -> dict:
    """Founded year, employees, locations, fleet, square footage, certifications. Each with a snippet."""
    out: dict = {}
    fy = pe.find_founded_year(text or "")
    if fy:
        out["founded"] = (int(fy[0]), fy[1])
    emp = pe.find_employees(text or "")
    if emp:
        out["employees"] = (int(emp[0]), emp[1])
    m = LOCATIONS_RE.search(text or "")
    if m:
        v = m.group(1).lower()
        out["locations"] = (int(v) if v.isdigit() else WORDNUM[v], pe._snippet(text, m.start(), m.end(), 50))
    m = FLEET_RE.search(text or "")
    if m:
        out["fleet"] = (int(m.group(1)), pe._snippet(text, m.start(), m.end(), 50))
    m = SQFT_RE.search(text or "")
    if m:
        out["sqft"] = (int(m.group(1).replace(",", "")), pe._snippet(text, m.start(), m.end(), 50))
    certs = pe.find_certifications(text or "")
    if certs:
        out["certs"] = [c for c, _ in certs]
    return out


def score_company(name: str, pages: list[tuple[str, str]], site_status: str, registry: dict | None = None,
                  registry_url: str | None = None) -> dict:
    """Fit score and reasons. pages = [(url, html)] from a site we fetched. Pure.

    site_status: 'confirmed' | 'unconfirmed' | 'none'. Only a confirmed site's text
    is read; an unconfirmed one might be a namesake.
    """
    reasons: list[dict] = []
    reg_url = registry_url or "https://data.texas.gov/resource/9cir-efmm.json"

    def why(text: str, url: str, pts: int):
        reasons.append({"reason": text, "url": url, "points": pts})

    read = [(u, b) for u, b in pages] if site_status == "confirmed" else []
    texts = [(u, pe.visible_text(b)) for u, b in read]
    all_text = "\n".join(t for _, t in texts)

    def src(pattern: re.Pattern | str) -> str:
        rx = pattern if isinstance(pattern, re.Pattern) else re.compile(pattern, re.I)
        for u, t in texts:
            if rx.search(t):
                return u
        return texts[0][0] if texts else reg_url

    score = 0
    if site_status == "confirmed":
        score += 30
        why("Operating website confirmed (name and Texas location on the site)", read[0][0], 30)
    elif site_status == "unconfirmed":
        why("A possible website was found but it does not prove it is this company", reg_url, 0)
    else:
        why("No working website found, so this is scored from the registry name only", reg_url, 0)

    ex = exclusion(name, all_text)
    industry, n = classify_industry(name, all_text)
    if industry:
        pts = INDUSTRIES[industry][0] if site_status == "confirmed" else INDUSTRIES[industry][0] // 2
        score += pts
        where = "site and name" if site_status == "confirmed" else "name only"
        why(f"Industry looks like {industry.lower()} ({where})", src("|".join(INDUSTRIES[industry][1])) if texts else reg_url, pts)

    clues = size_clues(all_text) if texts else {}
    founded = clues.get("founded")
    charter = (registry or {}).get("sos_charter_date") or ""
    year, year_src, year_label = None, None, None
    if founded:
        year, year_src, year_label = founded[0], src(str(founded[0])), "the site says founded"
    elif re.match(r"\d{4}", charter):
        year, year_src, year_label = int(charter[:4]), reg_url, "Texas registry charter date"
    if year:
        age = THIS_YEAR - year
        pts = 12 if age >= 20 else 8 if age >= 10 else 0
        if pts:
            score += pts
            why(f"In business about {age} years ({year_label} {year})", year_src, pts)
    emp = clues.get("employees")
    if emp:
        e = emp[0]
        pts = 15 if 20 <= e <= 500 else 5 if 10 <= e < 20 else -15 if e > 1000 else 0
        score += pts
        label = "right size for the mandate" if pts == 15 else "small" if pts == 5 else "likely too large" if pts < 0 else "outside the usual range"
        why(f"About {e} employees mentioned ({label})", src(str(e)), pts)
    loc = clues.get("locations")
    if loc and 2 <= loc[0] <= 30:
        score += 5
        why(f"{loc[0]} locations mentioned", src(LOCATIONS_RE), 5)
    fleet = clues.get("fleet")
    if fleet:
        score += 5
        why(f"Fleet of about {fleet[0]} vehicles mentioned", src(FLEET_RE), 5)
    sq = clues.get("sqft")
    if sq and sq[0] >= 10000:
        score += 5
        why(f"{sq[0]:,} square foot facility mentioned", src(SQFT_RE), 5)
    certs = clues.get("certs") or []
    if certs:
        pts = min(10, 5 * len(certs))
        score += pts
        why(f"Certifications on the site: {', '.join(certs[:4])}", src(r"ISO|AS9100|API|ASME|UL|HUB|ITAR|SQF|HACCP|AWS|owned"), pts)
    if texts:
        fm = FAMILY_RE.search(all_text)
        if fm:
            score += 10
            why(f"Founder or family ownership language: \"{quote(all_text, fm.start(), fm.end())}\"", src(FAMILY_RE), 10)
        pm = PE_RE.search(all_text)
        parent = public_parent(name, all_text)
        if pm:
            score -= 30
            why(f"Not founder-owned: \"{quote(all_text, pm.start(), pm.end())}\"", src(PE_RE), -30)
        elif parent:
            score -= 30
            why(f"Not founder-owned: part of public company {parent[0]} (\"{parent[1]}\" on the site)",
                src(re.escape(parent[1])), -30)

    if site_status == "none":
        score = min(score, 30)
    elif site_status == "unconfirmed":
        score = min(score, 40)
    if ex:
        score = min(score, 10)
        why(f"Not an operating target: {ex}", reg_url if re.search(r"|".join(p for p, _ in EXCLUSIONS), name, re.I) else src(r"."), 0)
    score = max(0, min(100, score))
    return {"fit_score": score, "industry": industry, "exclusion": ex, "reasons": reasons, "clues": {
        k: (v[0] if isinstance(v, tuple) else v) for k, v in clues.items()}}


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("classify", help="score saved pages (no network)")
    c.add_argument("--name", required=True)
    c.add_argument("--html", action="append", default=[])
    c.add_argument("--url", action="append", default=[])
    c.add_argument("--site", default="confirmed")
    args = p.parse_args(argv)
    pages = [(u, open(h, encoding="utf-8", errors="replace").read()) for h, u in zip(args.html, args.url)]
    print(json.dumps(score_company(args.name, pages, args.site), indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
