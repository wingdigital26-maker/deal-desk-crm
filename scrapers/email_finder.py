#!/usr/bin/env python3
"""
email_finder.py - find a real named decision maker and a real email address for
a company the registry gave us, without Apollo and without paying anyone.

Stdlib only. No API key, no paid API, no LLM call, no login, and NO SMTP.
Writes into the harness's own SQLite database.

THE PIPELINE, AND HOW MUCH TO TRUST EACH STAGE
----------------------------------------------
The Texas registry (tx_registry.py) gives a legal entity name and a street
address and nothing else. Four stages turn that into a contactable person.

  1. resolve-domain   name + city -> website.  Accepted only if the site's own
                      homepage text contains the company name. Directory sites
                      (Yelp, BBB, Manta, ZoomInfo, LinkedIn, ...) are rejected,
                      because a hit there is a listing about the company, not
                      the company.

  2. harvest          fetch homepage + contact/about/team/leadership pages,
                      pull every on-domain address, including mailto: links and
                      the common obfuscations ("name (at) co (dot) com", &#64;).
                      Also pull NAMED people whose title is explicitly printed
                      on the page (President, CEO, Owner, Founder, Principal).

  3. infer-pattern    if the harvest found even one personal address on the
                      domain, the company's address format is now a known fact
                      (j.smith@ -> "f.last"). Apply that proven pattern to the
                      named officers who had no address printed.

  4. verify           DNS MX lookup over DNS-over-HTTPS. Confirms the domain can
                      receive mail at all. It does NOT confirm an individual
                      mailbox exists -- that needs an SMTP conversation, which
                      this script will not do (see below).

CONFIDENCE TIERS written to contacts.email_status
-------------------------------------------------
  published        the address is printed on the company's own website. Safe.
  pattern-derived  built from a pattern another address on the SAME domain
                   proves. Usually right, occasionally wrong.
  guessed          built from a common pattern with nothing proving it on that
                   domain. Only produced with --guess-patterns. Treat as a lead
                   to verify, never as a fact.
  no-mx            the domain cannot receive mail. Do not send.

WHY THERE IS NO SMTP PROBE HERE
-------------------------------
scrapers/README.md promises a bank's compliance reviewer, in writing, that this
toolchain "never sends email or probes a mailbox". Mailbox-level verification
means opening an SMTP session and issuing RCPT TO against someone else's mail
server, which is exactly that. It is also unreliable in practice: Google
Workspace and Microsoft 365 host most small manufacturers, both rate-limit
probes by IP reputation, and any catch-all domain accepts every address you try,
so a "valid" result there means nothing. Two honest ways to close the last mile:

  a. Let the first send be the test. The harness already syncs bounces, so a
     pattern-derived address that hard-bounces is caught on the first attempt
     and suppressed. At this deal flow (tens of contacts, not thousands) this
     is the cheapest correct answer.
  b. Pay a verifier per address when the volume justifies it. Budget roughly
     $0.001-$0.004 per check. That is a spending decision for Jack, not a
     default, and it is not wired up here.

Usage:
  python scrapers/email_finder.py resolve-domain --db data/harness.db --limit 20 --dry
  python scrapers/email_finder.py harvest --db data/harness.db --limit 20
  python scrapers/email_finder.py verify --db data/harness.db
  python scrapers/email_finder.py run --db data/harness.db --limit 20
"""

import argparse
import html
import json
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
TIMEOUT = 12

CONTACT_PATHS = [
    "", "/contact", "/contact-us", "/contactus", "/about", "/about-us",
    "/team", "/our-team", "/leadership", "/management", "/staff", "/people",
    "/who-we-are", "/company", "/executive-team", "/meet-the-team",
]

# A hit on one of these is a listing ABOUT the company, not the company.
DIRECTORY_HOSTS = (
    "yelp.", "bbb.org", "manta.com", "zoominfo.com", "linkedin.com",
    "facebook.com", "instagram.com", "twitter.com", "x.com", "dnb.com",
    "bloomberg.com", "crunchbase.com", "buzzfile.com", "indeed.com",
    "glassdoor.com", "mapquest.com", "yellowpages.com", "chamberofcommerce",
    "opencorporates.com", "bizapedia.com", "corporationwiki.com", "apollo.io",
    "rocketreach.co", "signalhire.com", "lead411.com", "zippia.com",
    "wikipedia.org", "youtube.com", "tiktok.com", "pinterest.",
    "thomasnet.com", "google.", "bing.com", "duckduckgo.com", "amazon.",
)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
JUNK_EMAIL = (
    "example.com", "example.org", "domain.com", "yourdomain", "email.com",
    "sentry", "wixpress", "godaddy", "squarespace", "shopify", "cloudflare",
    "sentry.io", "@2x", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp",
    "no-reply", "noreply", "donotreply", "postmaster", "abuse@", "webmaster",
)
ROLE_LOCALPARTS = {
    "info", "sales", "contact", "office", "admin", "support", "hello", "help",
    "service", "services", "inquiries", "enquiries", "general", "mail",
    "accounting", "ap", "ar", "billing", "hr", "jobs", "careers", "quotes",
    "estimating", "orders", "purchasing", "rfq", "team", "marketing",
    # Added after the northwind.example.com test: donations@, exports@ and sponsorships@ were
    # read as staff addresses, which made the shape inference pick "flast" and
    # produce dwhitlock@ for a company that actually uses dana@.
    "donations", "exports", "imports", "sponsorships", "sponsorship", "press",
    "media", "legal", "compliance", "safety", "quality", "engineering",
    "production", "shipping", "receiving", "warehouse", "dispatch", "parts",
    "returns", "warranty", "claims", "payroll", "invoices", "invoicing",
    "customerservice", "customercare", "reception", "frontdesk", "webmaster",
    "newsletter", "subscribe", "unsubscribe", "privacy", "security", "it",
    "helpdesk", "training", "events", "community", "charity", "giving",
    "recruiting", "recruitment", "resumes", "apply", "applications", "bids",
    "tenders", "procurement", "vendors", "suppliers", "partners", "dealers",
    "distributors", "wholesale", "retail", "online", "web", "website", "shop",
    "store", "billing2", "main", "corporate", "headquarters", "hq", "plant",
}
# A length heuristic cannot separate a department from a person here: both
# "donations" (9) and "jpendleton" (10) are bare lowercase words. What does
# separate them is CONSISTENCY -- a company's staff addresses are all built the
# same way, so their lengths cluster tightly, while leftover department
# addresses vary wildly. See _tight_cluster below.

# A title we care about, printed on the page next to a human name.
DECIDER_TITLES = (
    "chief executive officer", "ceo", "president", "owner", "founder",
    "co-founder", "cofounder", "principal", "managing partner",
    "managing director", "chairman", "chief financial officer", "cfo",
)
NAME_RE = r"[A-Z][a-zA-Z'\.\-]+(?:\s+[A-Z][a-zA-Z'\.\-]+){1,2}"

# Words that sit in front of a real name in running prose and got swallowed into
# it on the first live run ("With Dana Whitlock", "Until Mark Ellison"), plus
# business-noun tails that made "Specialty Sales Charlie" look like a name.
NAME_STOPWORDS = {
    "with", "until", "and", "by", "from", "under", "our", "the", "a", "an",
    "meet", "contact", "about", "founder", "since", "when", "after", "before",
    "led", "join", "welcome", "team", "staff", "read", "more", "learn", "see",
}
NAME_BAD_TOKENS = {
    "sales", "marketing", "operations", "service", "services", "specialty",
    "international", "domestic", "national", "regional", "division", "group",
    "department", "office", "corporate", "executive", "senior", "junior",
    "vice", "assistant", "director", "manager", "president", "officer",
    "chief", "chairman", "owner", "partner", "inc", "llc", "ltd", "corp",
    "company", "co", "products", "industries", "manufacturing",
}

_last_hit: dict[str, float] = {}


def _throttle(host: str, gap: float = 1.0):
    last = _last_hit.get(host, 0.0)
    wait = gap - (time.monotonic() - last)
    if wait > 0:
        time.sleep(wait)
    _last_hit[host] = time.monotonic()


def fetch(url: str, gap: float = 1.0) -> str:
    """GET a page as text. Returns "" on any failure -- never raises."""
    try:
        host = urllib.parse.urlparse(url).netloc
        _throttle(host, gap)
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
        })
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            ctype = r.headers.get("Content-Type", "")
            if "html" not in ctype and "text" not in ctype:
                return ""
            return r.read(1_500_000).decode("utf-8", "replace")
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Stage 1: company name -> website
# ---------------------------------------------------------------------------

def _norm(s: str) -> str:
    """Comparable form of a company name: letters and digits only, no suffix."""
    s = re.sub(r"\b(inc|llc|ltd|lp|llp|corp|corporation|company|co|the|inc\.)\b",
               " ", s.lower())
    return re.sub(r"[^a-z0-9]", "", s)


def search_candidates(query: str) -> list[str]:
    """Candidate hostnames from DuckDuckGo's no-JS HTML endpoint."""
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    body = fetch(url, gap=2.0)
    if not body:
        return []
    hosts: list[str] = []
    # DDG wraps results as /l/?uddg=<urlencoded target>
    for m in re.finditer(r'uddg=([^&"\']+)', body):
        try:
            target = urllib.parse.unquote(m.group(1))
        except Exception:
            continue
        host = urllib.parse.urlparse(target).netloc.lower().lstrip("www.")
        if not host or any(d in host for d in DIRECTORY_HOSTS):
            continue
        if host not in hosts:
            hosts.append(host)
    return hosts[:6]


def confirm_domain(host: str, company_name: str) -> bool:
    """Only accept a domain whose own homepage names the company."""
    body = fetch(f"https://{host}/")
    if not body:
        body = fetch(f"http://{host}/")
    if not body:
        return False
    want = _norm(company_name)
    got = _norm(re.sub(r"<[^>]+>", " ", body[:200_000]))
    if not want or len(want) < 5:
        return False
    if want in got:
        return True
    # Fall back to the distinctive leading token, e.g. "atco" for ATCO RUBBER.
    lead = re.sub(r"[^a-z0-9]", "", company_name.lower().split()[0])
    return len(lead) >= 5 and lead in got and _norm(host).startswith(lead[:5])


def resolve_domains(con: sqlite3.Connection, args) -> dict:
    rows = con.execute(
        """SELECT id, name, city FROM companies
           WHERE (domain IS NULL OR domain = '') ORDER BY id LIMIT ?""",
        (args.limit,),
    ).fetchall()
    found = 0
    for cid, name, city in rows:
        q = f'"{name}" {city or ""} Texas'.strip()
        hosts = search_candidates(q)
        hit = next((h for h in hosts if confirm_domain(h, name)), None)
        if hit:
            found += 1
            print(f"  [{cid}] {name} -> {hit}")
            if not args.dry:
                con.execute("UPDATE companies SET domain=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
                            (hit, cid))
        else:
            print(f"  [{cid}] {name} -> no confirmed domain ({len(hosts)} candidates rejected)")
    if not args.dry:
        con.commit()
    print(f"resolve-domain: {len(rows)} companies tried, {found} domains confirmed")
    return {"tried": len(rows), "found": found}


# ---------------------------------------------------------------------------
# Stage 2: harvest addresses and named people from the company's own site
# ---------------------------------------------------------------------------

def deobfuscate(text: str) -> str:
    t = html.unescape(text)
    t = re.sub(r"\s*(?:\(|\[|\{)?\s*(?:at|AT)\s*(?:\)|\]|\})?\s*", "@", t) if "@" not in t else t
    t = re.sub(r"\s*(?:\(|\[|\{)\s*(?:dot|DOT)\s*(?:\)|\]|\})\s*", ".", t)
    return t


def harvest_site(domain: str) -> dict:
    """Every on-domain address and every explicitly-titled person we can see."""
    emails: set[str] = set()
    people: list[dict] = []
    seen_pages = 0
    for path in CONTACT_PATHS:
        body = fetch(f"https://{domain}{path}")
        if not body:
            continue
        seen_pages += 1
        text = html.unescape(body)
        for m in EMAIL_RE.finditer(text):
            e = m.group(0).lower().rstrip(".,;:")
            if any(j in e for j in JUNK_EMAIL):
                continue
            # on-domain only: an address at someone else's domain is not theirs
            if e.split("@")[-1].replace("www.", "") not in (domain, "www." + domain):
                continue
            emails.add(e)
        # obfuscated forms, e.g. "jsmith (at) atco (dot) com"
        for m in re.finditer(r"[A-Za-z0-9._%+\-]+\s*(?:\(at\)|\[at\]|\sat\s)\s*[A-Za-z0-9.\-]+\s*(?:\(dot\)|\[dot\]|\sdot\s)\s*[A-Za-z]{2,}", text, re.I):
            cand = deobfuscate(m.group(0)).replace(" ", "").lower()
            if EMAIL_RE.fullmatch(cand) and cand.split("@")[-1] == domain:
                emails.add(cand)
        people += extract_people(body)
        time.sleep(0.2)
    # dedupe people by name, keep the first title seen
    uniq: dict[str, dict] = {}
    for p in people:
        uniq.setdefault(p["name"].lower(), p)
    return {"emails": sorted(emails), "people": list(uniq.values()), "pages": seen_pages}


def clean_name(raw: str) -> str | None:
    """Trim prose words off a captured name, or reject it outright.

    Returns a two-or-three token human name, or None if what we captured is not
    one. This is where "With Dana Whitlock" becomes "Dana Whitlock" and
    "Specialty Sales Charlie" is thrown away.
    """
    tokens = [t for t in raw.split() if t]
    while tokens and tokens[0].lower().strip(".,'-") in NAME_STOPWORDS:
        tokens.pop(0)
    while tokens and tokens[-1].lower().strip(".,'-") in NAME_STOPWORDS:
        tokens.pop()
    if not 2 <= len(tokens) <= 3:
        return None
    lowered = [t.lower().strip(".,'-") for t in tokens]
    if any(t in NAME_BAD_TOKENS for t in lowered):
        return None
    if any(len(t) < 2 for t in lowered):
        return None
    name = " ".join(tokens)
    return name if 5 <= len(name) <= 40 else None


def extract_people(body: str) -> list[dict]:
    """Named people whose decision-making title is printed on the page.

    Only returns a name that sits next to an explicit title string. Never
    infers a person from a company name or a stray capitalised phrase.
    """
    out: list[dict] = []
    text = re.sub(r"<[^>]+>", " | ", html.unescape(body))
    text = re.sub(r"\s+", " ", text)
    for title in DECIDER_TITLES:
        # "Jane Doe | President" and "President | Jane Doe"
        for pat in (rf"({NAME_RE})\s*(?:\||,|-|–|:)\s*{re.escape(title)}\b",
                    rf"\b{re.escape(title)}\s*(?:\||,|-|–|:)\s*({NAME_RE})"):
            for m in re.finditer(pat, text, re.I):
                name = clean_name(m.group(1))
                if name:
                    out.append({"name": name, "title": title})
    # JSON-LD Person blocks
    for m in re.finditer(r'"@type"\s*:\s*"Person".{0,400}?"name"\s*:\s*"([^"]{5,40})"', body, re.S):
        nm = clean_name(m.group(1))
        if nm:
            out.append({"name": nm, "title": "person (schema.org)"})
    return out


# ---------------------------------------------------------------------------
# Stage 3: pattern inference
# ---------------------------------------------------------------------------

PATTERNS = {
    "first.last": lambda f, l: f"{f}.{l}",
    "firstlast": lambda f, l: f"{f}{l}",
    "first_last": lambda f, l: f"{f}_{l}",
    "flast": lambda f, l: f"{f[0]}{l}",
    "f.last": lambda f, l: f"{f[0]}.{l}",
    "first": lambda f, l: f,
    "firstl": lambda f, l: f"{f}{l[0]}",
    "lastf": lambda f, l: f"{l}{f[0]}",
    "last.first": lambda f, l: f"{l}.{f}",
}
# Order to try when nothing on the domain proves a pattern. Ordering reflects
# what the 17 verified Apollo addresses on real TX manufacturers actually used
# (first.last and flast dominated, then first, then f.last).
GUESS_ORDER = ["first.last", "flast", "first", "f.last", "firstlast"]


def infer_pattern_structural(emails: list[str]) -> str | None:
    """Infer the pattern from the SHAPE of existing addresses, with no names.

    Found by testing against acmeprecision.example.com, which publishes six addresses --
    bharlow@, dpratt@, jwhitman@, mfowler@, mbennett@, rvillareal@ -- and not one
    staff name. The old name-matching inference returned nothing there even
    though the format is unmistakable. Needs two agreeing examples, so a single
    odd address cannot set the pattern for the whole company.
    """
    locals_ = [e.split("@")[0].lower() for e in emails if not is_role(e)]
    if len(locals_) < 2:
        return None
    shapes = {
        "first.last": re.compile(r"^[a-z]{2,}\.[a-z]{2,}$"),
        "first_last": re.compile(r"^[a-z]{2,}_[a-z]{2,}$"),
        "f.last": re.compile(r"^[a-z]\.[a-z]{3,}$"),
        "flast": re.compile(r"^[a-z][a-z]{4,}$"),
        "first": re.compile(r"^[a-z]{3,9}$"),
    }
    # Most specific first: "flast" and "first" are both bare words, so a
    # separator-bearing shape always wins when one is present.
    for pname in ("first.last", "first_last", "f.last"):
        if sum(1 for l in locals_ if shapes[pname].match(l)) >= 2:
            return pname
    bare = [l for l in locals_ if re.match(r"^[a-z]+$", l)]
    if len(bare) >= 3 and _tight_cluster(bare):
        avg = sum(len(l) for l in bare) / len(bare)
        return "first" if avg <= 6 else "flast"
    return None


def _tight_cluster(words: list[str], max_spread: float = 2.0) -> bool:
    """Do these local parts look like one scheme rather than a grab bag?

    Staff addresses built from a template cluster tightly in length
    (bharlow/dpratt/jwhitman/mfowler = 7,6,8,7). A residue of department
    mailboxes does not (donations/exports/sponsorships/greg = 9,7,12,4). When
    the spread is wide we return False and the caller declines to guess, which
    is the behaviour we want: no pattern is better than a wrong one.
    """
    lens = [len(w) for w in words]
    mean = sum(lens) / len(lens)
    var = sum((x - mean) ** 2 for x in lens) / len(lens)
    return var ** 0.5 <= max_spread


def infer_pattern(emails: list[str], people: list[dict]) -> str | None:
    """Which pattern does a KNOWN address on this domain demonstrate?

    Name-matched proof first (strongest), then shape-only inference.
    """
    for e in emails:
        local = e.split("@")[0].lower()
        if is_role_local(local):
            continue
        for p in people:
            parts = p["name"].lower().split()
            if len(parts) < 2:
                continue
            f, l = re.sub(r"[^a-z]", "", parts[0]), re.sub(r"[^a-z]", "", parts[-1])
            if not f or not l:
                continue
            for pname, build in PATTERNS.items():
                if build(f, l) == local:
                    return pname
    return infer_pattern_structural(emails)


def build_address(name: str, domain: str, pattern: str) -> str | None:
    parts = name.lower().split()
    if len(parts) < 2:
        return None
    f = re.sub(r"[^a-z]", "", parts[0])
    l = re.sub(r"[^a-z]", "", parts[-1])
    if not f or not l:
        return None
    return f"{PATTERNS[pattern](f, l)}@{domain}"


# Compound department mailboxes (accountspayable@, techsupport@, orderentry@,
# marketingservices@, finishwarranty@) slipped past the exact-match set on the
# 2026-09-25 run and were stored as people. Any of these fragments inside the
# local part marks it as a role mailbox.
ROLE_FRAGMENTS = (
    "payable", "receivable", "account", "support", "service", "order", "entry",
    "warranty", "technical", "marketing", "sales", "billing", "invoice", "quote",
    "estimat", "purchas", "shipping", "customer", "career", "recruit", "info",
    "office", "dispatch", "parts", "noreply", "no-reply", "webmaster",
)


def is_role_local(local: str) -> bool:
    local = local.lower()
    return local in ROLE_LOCALPARTS or any(f in local for f in ROLE_FRAGMENTS)


def is_role(email: str) -> bool:
    return is_role_local(email.split("@")[0])


def harvest(con: sqlite3.Connection, args) -> dict:
    rows = con.execute(
        """SELECT id, name, domain FROM companies
           WHERE domain IS NOT NULL AND domain <> '' ORDER BY id LIMIT ?""",
        (args.limit,),
    ).fetchall()
    stats = {"companies": 0, "published": 0, "derived": 0, "guessed": 0, "role_only": 0, "nothing": 0}
    for cid, cname, domain in rows:
        stats["companies"] += 1
        h = harvest_site(domain)
        if not h["pages"]:
            print(f"  [{cid}] {cname} ({domain}) -> site unreachable")
            stats["nothing"] += 1
            continue
        pattern = infer_pattern(h["emails"], h["people"])
        person_emails = [e for e in h["emails"] if not is_role(e)]
        print(f"  [{cid}] {cname} ({domain}): {len(h['emails'])} addr "
              f"({len(person_emails)} personal), {len(h['people'])} named people, "
              f"pattern={pattern or 'unknown'}")

        wrote = 0
        # (a) addresses printed on the site, matched to a named person if we can
        for e in person_emails:
            local = e.split("@")[0]
            match = next((p for p in h["people"]
                          if all(t in local.lower() for t in
                                 [re.sub(r'[^a-z]', '', p['name'].lower().split()[-1])[:4]])), None)
            first, last = _split_name(match["name"]) if match else ("", "")
            title = match["title"] if match else None
            wrote += _upsert_contact(con, cid, first, last, title, e, "published", args.dry)
            stats["published"] += 1
        # (b) named people with no printed address, using a proven pattern
        for p in h["people"]:
            first, last = _split_name(p["name"])
            if not last:
                continue
            if any(last.lower()[:4] in e.split("@")[0].lower() for e in person_emails):
                continue
            if pattern:
                addr = build_address(p["name"], domain, pattern)
                if addr:
                    wrote += _upsert_contact(con, cid, first, last, p["title"], addr,
                                             "pattern-derived", args.dry)
                    stats["derived"] += 1
            elif args.guess_patterns:
                addr = build_address(p["name"], domain, GUESS_ORDER[0])
                if addr:
                    wrote += _upsert_contact(con, cid, first, last, p["title"], addr,
                                             "guessed", args.dry)
                    stats["guessed"] += 1
        if not wrote:
            if h["emails"]:
                stats["role_only"] += 1
            else:
                stats["nothing"] += 1
    if not args.dry:
        con.execute(
            "INSERT INTO audit_log (actor_label, action, entity, entity_id, detail_json) VALUES (?,?,?,?,?)",
            ("email-finder", "emails.harvest", "company", None, json.dumps(stats)),
        )
        con.commit()
    print("harvest: " + json.dumps(stats))
    return stats


def _split_name(name: str) -> tuple[str, str]:
    parts = [p for p in name.split() if p]
    if len(parts) < 2:
        return (parts[0] if parts else "", "")
    return parts[0], parts[-1]


def _upsert_contact(con: sqlite3.Connection, company_id: int, first: str, last: str,
                    title: str | None, email: str, status: str, dry: bool) -> int:
    if dry:
        print(f"      would write: {first} {last} <{email}> [{status}] {title or ''}")
        return 1
    dup = con.execute("SELECT id FROM contacts WHERE lower(email)=lower(?)", (email,)).fetchone()
    if dup:
        return 0
    con.execute(
        """INSERT INTO contacts (company_id, first_name, last_name, title, email,
                                 email_status, source, enriched_at)
           VALUES (?,?,?,?,?,?,'site-scrape',CURRENT_TIMESTAMP)""",
        (company_id, first or None, last or None, title, email, status),
    )
    return 1


# ---------------------------------------------------------------------------
# Stage 4: MX verification (DNS only -- never an SMTP conversation)
# ---------------------------------------------------------------------------

def has_mx(domain: str) -> bool | None:
    url = "https://dns.google/resolve?type=MX&name=" + urllib.parse.quote(domain)
    body = fetch(url, gap=0.3)
    if not body:
        return None
    try:
        data = json.loads(body)
    except Exception:
        return None
    return bool(data.get("Answer"))


def verify(con: sqlite3.Connection, args) -> dict:
    rows = con.execute(
        """SELECT id, email, email_status FROM contacts
           WHERE email IS NOT NULL AND email <> ''
             AND (email_status IS NULL OR email_status IN ('published','pattern-derived','guessed'))"""
    ).fetchall()
    checked = {}
    killed = 0
    for cid, email, status in rows:
        dom = email.split("@")[-1].lower()
        if dom not in checked:
            checked[dom] = has_mx(dom)
        ok = checked[dom]
        if ok is False:
            con.execute("UPDATE contacts SET email_status='no-mx' WHERE id=?", (cid,))
            killed += 1
    con.commit()
    print(f"verify: {len(rows)} addresses, {len(checked)} domains checked, {killed} marked no-mx")
    return {"addresses": len(rows), "domains": len(checked), "no_mx": killed}


def selftest() -> int:
    """Offline checks on the inference rules. No network, no database.

    Every case here is a real result from a live run against a real company
    site, kept so a later tweak to the heuristics cannot quietly break them.
    """
    fails = 0

    def check(label, got, want):
        nonlocal fails
        ok = got == want
        fails += 0 if ok else 1
        print(f"  {'ok  ' if ok else 'FAIL'} {label}: got {got!r}, want {want!r}")

    # Pattern inference from address shape alone.
    check("acme: six staff addresses in one scheme",
          infer_pattern_structural(["bharlow@e.com", "careers@e.com", "dpratt@e.com",
                                    "inquiries@e.com", "jwhitman@e.com", "mfowler@e.com",
                                    "mbennett@e.com", "rvillareal@e.com"]), "flast")
    check("northwind: department residue must NOT yield a pattern",
          infer_pattern_structural(["donations@r.com", "exports@r.com", "marketing@r.com",
                                    "sponsorships@r.com", "greg@r.com"]), None)
    check("separator scheme beats bare words",
          infer_pattern_structural(["jane.doe@x.com", "bob.smith@x.com", "info@x.com"]), "first.last")
    check("short bare words are first names",
          infer_pattern_structural(["mike@x.com", "greg@x.com", "sarah@x.com", "info@x.com"]), "first")
    check("a single address proves nothing",
          infer_pattern_structural(["dana@r.com"]), None)

    # Name cleanup.
    check("strips a leading prose word", clean_name("With Dana Whitlock"), "Dana Whitlock")
    check("rejects a business phrase", clean_name("Specialty Sales Charlie"), None)
    check("keeps a plain name", clean_name("Ed Harlan"), "Ed Harlan")
    check("rejects a lone token", clean_name("Tony"), None)
    check("rejects a company", clean_name("Northwind Products Inc"), None)

    # Address construction.
    check("flast build", build_address("John Pendleton", "acmeprecision.example.com", "flast"),
          "jpendleton@acmeprecision.example.com")
    check("first.last build", build_address("Ed Harlan", "globex.example.com", "first.last"),
          "ed.harlan@globex.example.com")

    # Role classification.
    check("info@ is a role", is_role("info@x.com"), True)
    check("sponsorships@ is a role", is_role("sponsorships@x.com"), True)
    check("jpendleton@ is not a role", is_role("jpendleton@x.com"), False)

    print(f"selftest: {'all passed' if not fails else str(fails) + ' FAILED'}")
    return 1 if fails else 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("selftest", help="offline checks on the inference rules")
    for name in ("resolve-domain", "harvest", "verify", "run"):
        s = sub.add_parser(name)
        s.add_argument("--db", default="data/harness.db")
        s.add_argument("--limit", type=int, default=20)
        s.add_argument("--dry", action="store_true")
        s.add_argument("--guess-patterns", action="store_true", dest="guess_patterns",
                       help="also write unproven common-pattern addresses as email_status='guessed'")
    args = p.parse_args()
    if args.cmd == "selftest":
        return selftest()

    con = sqlite3.connect(args.db)
    try:
        if args.cmd == "resolve-domain":
            resolve_domains(con, args)
        elif args.cmd == "harvest":
            harvest(con, args)
        elif args.cmd == "verify":
            verify(con, args)
        else:
            resolve_domains(con, args)
            harvest(con, args)
            if not args.dry:
                verify(con, args)
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
