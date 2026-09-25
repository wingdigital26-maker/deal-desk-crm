# Sourcing targets without Apollo

How the harness finds founder-owned Texas companies and a real named contact at
each one, using only free public sources. Written 2026-09-20, replacing the
Apollo-only path.

## Why replace Apollo

Apollo is good at one thing here: it already has the email. On the 2026-09-20
enrichment it returned 17 verified addresses for 17 requests. It is bad at three
things that matter more for a sell-side mandate:

1. **Wrong universe.** 8 of the 25 leads it gave us were unusable: already sold,
   private-equity owned, or headquartered outside Texas. Apollo indexes
   employees, not ownership, so it cannot tell a founder-owned machine shop from
   a subsidiary of a public parent.
2. **Cost scales with volume.** One credit per address, and the credits reset
   monthly. Sourcing a real pipeline means thousands of lookups.
3. **It is someone else's list.** Every other bank buys the same rows. The only
   durable edge is a list nobody else has.

The free sources below have the opposite profile: they know ownership, entity age
and legal status cold, and know nothing about email. So the design is to take the
universe from the state and the email from the company's own website.

## Stage 1 -- the universe: Texas franchise tax registry

`scrapers/tx_registry.py`

- Source: Texas Comptroller, *Active Franchise Tax Permit Holders*, via the
  Socrata JSON API at `data.texas.gov/resource/9cir-efmm.json`.
- **No API key. No login. No rate limit hit in testing. 3,463,622 active
  entities** as of 2026-09-20.
- Gives, as state-filed fact: legal name, street address, city, county, ZIP,
  organisational type, SOS file number, **SOS charter date** and current
  right-to-transact-business status.
- Gives nothing about industry, revenue, headcount, website or people.

The charter date is the quietly valuable field. It is the real founding year from
the state, not a vendor's estimate, so "incorporated 1978 and still in good
standing" is a hard fact about succession pressure. The default filter is
chartered before 2006, which makes every hit at least 20 years old.

Because the file has no NAICS code, the industry filter is a **name-keyword
match** (`MANUFACTURING`, `FABRICATION`, `MACHINE`, `STEEL`, ...) with word
boundaries. This is explicitly a candidate filter, not a fact:
`companies.industry` is left NULL and the row records
`"verified": false` in its notes. That distinction is the lesson from the SEC
signal bug (see `harness_signals.py` line 289) where a name-only match was
written down as though it were established.

### What this stage cannot do

It cannot tell public from private. The first live run surfaced two large
public manufacturers alongside genuine founder-owned targets. Filtering those out needs a
second pass; the cheapest is SEC's free static `company_tickers.json`, which
lists every public registrant name. **Not yet built.**

Measured on the first run: 8,341 registry rows scanned produced 15 candidates,
of which roughly half survived a human read. So expect ~0.1% of the registry to
be worth reviewing, which across 3.46M rows is still thousands of candidates.

## Stage 2 -- name to website

`email_finder.py resolve-domain`

DuckDuckGo's no-JavaScript HTML endpoint gives candidate hostnames. A candidate
is only accepted if **the site's own homepage text contains the company name**,
and directory hosts (Yelp, BBB, Manta, ZoomInfo, LinkedIn, Bizapedia, ...) are
rejected outright, because a hit there is a page *about* the company rather than
the company. A rejected candidate leaves `domain` NULL rather than guessing.

## Stage 3 -- the email

`email_finder.py harvest`

Fetches the homepage plus 15 likely paths (`/contact`, `/about`, `/team`,
`/leadership`, `/management`, `/staff`, ...) and pulls two things:

- **Addresses**, on-domain only, including `mailto:` links and the common
  obfuscations (`name (at) co (dot) com`, `&#64;`). An address at someone else's
  domain is not theirs and is dropped.
- **Named people**, but only where a decision-making title is *printed next to
  the name* on the page (President, CEO, Owner, Founder, Principal, CFO). It
  never infers a person from a company name.

Then it infers the company's address format, two ways:

1. **Name-matched proof.** If a harvested address resolves against a harvested
   name (`j.smith@` + "Jane Smith"), the format is proven.
2. **Shape-only inference.** If the site publishes staff addresses but no staff
   names, the format is still often obvious. `acmeprecision.example.com` publishes
   `bharlow@`, `dpratt@`, `jwhitman@`, `mfowler@`, `mbennett@`, `rvillareal@` and
   not one name. That is unmistakably `flast`.

Shape-only inference requires three agreeing examples whose lengths cluster
tightly (standard deviation <= 2). That guard exists because of `northwind.example.com`,
which publishes `donations@`, `exports@`, `sponsorships@`, `marketing@` and
`greg@`. Averaging those lengths suggested `flast` and produced
`dwhitlock@northwind.example.com` for the CEO, where the real address is `dana@northwind.example.com`. The
lengths there are 9, 7, 12 and 4 -- a grab bag, not a scheme -- so the cluster
test now makes it decline. **No pattern is better than a wrong pattern.**

## Confidence tiers -- what `contacts.email_status` means

| Status | Meaning | Trust |
|---|---|---|
| `verified` | Apollo returned it and marked it verified | high |
| `published` | printed on the company's own website | high |
| `pattern-derived` | built from a format proven on that same domain | good |
| `guessed` | common format, nothing on the domain proves it (`--guess-patterns` only) | lead, not fact |
| `mx-only` | domain accepts mail, mailbox unconfirmed | partial |
| `no-mx` | domain cannot receive mail | do not send |

## Stage 4 -- verification, and its honest limit

`email_finder.py verify` does a DNS MX lookup over DNS-over-HTTPS. That proves
the *domain* can receive mail. It does not prove the *mailbox* exists.

Mailbox-level checking means opening an SMTP session against someone else's mail
server and issuing `RCPT TO`. **This toolchain deliberately does not do that**,
for two reasons. First, `scrapers/README.md` promises a bank's compliance
reviewer in writing that it "never sends email or probes a mailbox"; quietly
breaking that promise would be worse than the missing capability. Second it
barely works: Google Workspace and Microsoft 365 host most small manufacturers,
both throttle probes by IP reputation, and a catch-all domain accepts every
address you try. Two of the 17 Apollo contacts were already flagged catch-all,
so SMTP verification would have told us nothing about them anyway.

Two honest ways to close the last mile:

- **Let the first send be the test.** The harness already syncs bounces and
  suppresses on hard failure, so a wrong `pattern-derived` address is caught once
  and never retried. At this deal flow -- tens of contacts a week, not thousands
  -- this is the cheapest correct answer.
- **Pay per check** when volume justifies it, roughly $0.001-$0.004 per address.
  A spending decision for Jack, not a default, and not wired up.

## Sources checked and rejected, with reasons

| Source | Verdict |
|---|---|
| TX Comptroller franchise file | **In use.** Free, no key, 3.46M entities. |
| TX Comptroller public API (`api.comptroller.texas.gov/public-data/v1`) | **Wanted.** Has a `franchise-tax/{id}` endpoint reported to return officer detail, which would give owner names directly. Returns `{"message":"Forbidden"}` without an `x-api-key`. **Jack action: request a key.** Response fields unverified until then. |
| DOL / OSHA enforcement data | **Wanted.** Establishment records carry NAICS, address and employee count, which is exactly the industry and size filter the franchise file lacks. Free key at `dataportal.dol.gov/registration`. The old bulk CSV path now redirects to a portal. **Jack action: register.** |
| SEC `company_tickers.json` | **Should add.** Free static file of every public registrant; would drop the public companies automatically. |
| SEC EDGAR full-text | **Already disabled.** Private companies do not file, so name-only matches were other companies' documents. |
| USAspending | In `harness_signals.py`. Finds federal contractors, which is a narrow slice of the target universe. |
| LinkedIn | **No.** Scraping it is against its terms and the account risk lands on the firm. |
| Apollo | Kept for the last mile only, on explicit approval per batch. |

## Running it

```
python scrapers/tx_registry.py discover --db data/harness.db --metro dfw --limit 200 --dry
python scrapers/tx_registry.py discover --db data/harness.db --metro dfw --limit 200
python scrapers/email_finder.py resolve-domain --db data/harness.db --limit 50
python scrapers/email_finder.py harvest --db data/harness.db --limit 50
python scrapers/email_finder.py verify --db data/harness.db
python scrapers/email_finder.py selftest          # offline, no network or db
```

Both scripts are stdlib-only, throttle to one request per second per host, fail
soft on a dead source, and write an `audit_log` row per run. Nothing in this
pipeline sends an email.
