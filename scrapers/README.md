# harness_signals.py

Zero-usage lead sourcing for the banker harness. Pure Python 3.10+ standard
library (urllib, json, sqlite3, xml, argparse, time). No paid APIs, no LLM
calls, no npm packages. Writes straight into the harness's own SQLite
database (`data/harness.db` by default), reusing the schema in
`app/lib/db.ts` -- there is no separate database and no company-import step.

## What this collects and what it never does

This section is written for a bank's compliance review.

- Reads public sources only: public job boards (Greenhouse, Lever, Ashby),
  Google News RSS, SEC EDGAR full-text search, and USAspending federal
  contract awards. Nothing behind a login, paywall, or terms-gated API.
- Never logs into anything. No credentials, cookies, or sessions are used
  against any third-party site.
- Never calls a paid API or LLM. No API keys are read by this script.
- Never sends email or probes a mailbox. The MX check (`verify-emails`)
  looks up a domain's DNS records only; it never opens an SMTP connection,
  never sends a test message, and never confirms an individual mailbox
  exists.
- Never invents data. If a source does not return a domain, email, or
  contact, the field is left null rather than guessed.
- Rate-limited and polite: one request per second per host, a 10-second
  timeout, and back-off on HTTP 429. A slow or unavailable source is
  skipped, not retried aggressively.

## What it does

- **`collect`**: for companies already in the harness, pulls hiring signals
  (Greenhouse/Lever/Ashby public boards, guessed from the domain), ownership
  transition news (Google News RSS, weighted up for words like "succession",
  "retire", "private equity", "recapitalization", "founder"), SEC EDGAR
  full-text filing mentions, and federal contract awards (USAspending).
  Inserts into `signals`, deduped on `(company_id, kind, url)`.
- **`discover`**: finds NEW candidate companies from free public sources
  (USAspending recipient search by state/NAICS, SEC EDGAR company search by
  state) and inserts them with `source = 'signal-engine'`. Never invents a
  domain -- if the source did not return one, the column is left null.
- **`verify-emails`**: checks MX records via DNS-over-HTTPS
  (`dns.google/resolve`) for contacts with an email and unknown status. Sets
  `email_status` to `mx-only` or `no-mx`. Never does an SMTP handshake.
- **`score`**: recomputes `companies.signal_score` as the sum of each
  signal's weight times a 45-day half-life recency decay.
- **`run`**: does collect, verify-emails, score in order, prints a JSON
  summary, and appends one `audit_log` row (`actor_label = "signal-engine"`,
  `action = "signals.run"`).

Every collector is independent and fails soft -- a dead source is skipped,
never a crash. Requests are throttled to 1/second per host with a 10-second
timeout and back off on HTTP 429.

## Run it locally

```
python scrapers/harness_signals.py run --db data/harness.db
python scrapers/harness_signals.py collect --db data/harness.db --limit 50
python scrapers/harness_signals.py discover --db data/harness.db --segment owners --state TX --naics 336
python scrapers/harness_signals.py verify-emails --db data/harness.db
python scrapers/harness_signals.py score --db data/harness.db
```

## Schedule it

### Windows Task Scheduler (hidden, no console box)

1. Open Task Scheduler -> Create Task.
2. Trigger: Weekly, whatever day/time fits the desk's cadence.
3. Action: Start a program -> `wscript.exe` -> Arguments:
   `"C:\path\to\banker-harness\scrapers\run_weekly.vbs"`.
4. `run_weekly.vbs` launches `run_weekly.cmd` hidden (`objShell.Run ..., 0,
   False`), which runs the Python script against `data\harness.db`.

### cron (Linux/macOS host)

```
0 6 * * 1 cd /path/to/banker-harness && python3 scrapers/harness_signals.py run --db data/harness.db >> scrapers/run.log 2>&1
```

## Notes

- The script never creates the schema. It assumes the Next.js app (via
  `app/lib/db.ts`) has already created `data/harness.db` at least once.
- Testing against a scratch copy: point `--db` at a throwaway path (e.g.
  `scrapers/.tmp/scratch.db`), never `data/harness.db`. Delete the scratch
  file when done.

# Sourcing pipeline (v2): website, fit, owners, signals

One command does all four steps for up to N companies not checked in the last
30 days (registry companies never checked go first):

```
python scrapers/pipeline.py run --db data/harness.db --limit 200 [--sample-ids ids.txt] [--log run.jsonl]
python -m unittest discover -s scrapers/tests        # offline tests, fixture HTML only
```

| Step | Script | What it writes |
| --- | --- | --- |
| Website | `find_websites.py` | Candidate domains from the legal name, DNS check, homepage identity proof (name AND Texas city / street / ZIP / area code). Confirmed -> `companies.domain`; unconfirmed -> `profile_facts` website row labelled unconfirmed, with the evidence. Parked, for-sale, placeholder and big-brand redirects are rejected. |
| Fit | `fit_score.py` | `companies.fit_score` 0-100 and one `profile_facts` row per reason (`fit_reasons`), each with its source URL. Industry taxonomy, exclusions (holding / property / church / HOA / trust / GP / practice / restaurant), size clues, family or founder ownership, PE or parent ownership. No confirmed site caps the score at 30. `signal_score` is never touched here. |
| Owners | `tx_officers.py` | Owner-level people from the company's own confirmed site (About / Team / Leadership), stored as contacts with no email, `source = 'company-website'`. The Comptroller's officer list is used only through its official Public Data API and only when `TX_COMPTROLLER_API_KEY` is set (free key, registration required); its public search endpoint is robots-disallowed and is never scraped. Then a DNS-only MX check. |
| Signals | `sourcing_signals.py` | `officer-change` (snapshots differ between runs, weight 5), `owner-news`, `business-journal` / `news`, via the GDELT DOC API. Google News RSS is robots-disallowed and is not used by this pipeline. |

Each company is one transaction, so a stopped run loses at most the company in
flight and the next run resumes. Every run writes a `sourcing_runs` row (shown
at the top of the Sourcing page) and an `audit_log` row (`sourcing.run`).

On networks that block DNS-over-HTTPS the website finder falls back to the
operating system resolver, and the MX check falls back to `nslookup -type=mx`.

The weekly task (`scripts/run-signals-weekly.bat`, registered by
`scripts/install-tasks.ps1`) runs the signal engine and then this pipeline with
`--limit 500`, logging to `scrapers/.tmp/weekly.log`. Installing the task is a
separate, deliberate step:

```
powershell -ExecutionPolicy Bypass -File scripts/install-tasks.ps1
```
