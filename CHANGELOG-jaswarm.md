# CHANGELOG-jaswarm

## Round 1 · banker-harness · 2026-09-19
| Lane | Change | Proof |
|---|---|---|
| auth | sign-in, login/logout, seed script | tsc, smoke 200 |
| crm core | companies, contacts, timeline, CSV import | 5,000 rows imported in 2.5s |
| pipeline | deal board, deal detail, tasks, Today | smoke 200 |
| compliance | templates, voice check, hash-bound principal approval, audit trail | attacker could not self-approve, forge, or tamper |
| send pipe | warmup ramp, mailboxes, fail-closed send gate, do-not-contact list | every block reason reproduced live |
| apollo | typed client, import, search UI; key from env only | no key in any response |
| scrapers | stdlib-only Python signal collector | real run: 46 signals, 0 errors, 0 dupes on rerun |
| safety | 1 fixed: role now re-read from DB on every request | forged-role token is a no-op |
| regression | tsc clean, all routes 200 | 29/29 |
**Committed:** fb6aea3, df4e60f, 943f97f, 940aed0, f7dbdf2

## Round 2 · banker-harness · 2026-09-19
| Lane | Change | Proof |
|---|---|---|
| visual | one look: shared Button, PageHeader, DataTable, EmptyState across every section | hand-rolled primary buttons 11 variants to 0 |
| content | queue an approved email to selected contacts; owner-only two-step "Send what is due"; plain-English compliance wording | reachable from Contacts, Company, Template |
| practicality | Queue in nav; one-click deal and contact from a company; tasks attach to deals; no terminal commands as a primary action | reachable |
| perf | pages load data server-side instead of fetch-in-effect | 4 lint errors to 0 |
| safety | login timing parity (93ms vs 96ms), per-account rate limit (8 then 429 under header rotation), CSV formula neutralized, ramp date parsed as local (was a day early in US timezones) | measured live |
| regression | tsc clean, eslint 0 errors, vitest 88/88, all routes 200 | 88/88 |
**Criteria:** 5 yes / 2 partial / 0 no (partial: Apollo import untested against a live key; /visual not yet run) · **Backlog:** 5 items

## Round 3 · banker-harness · 2026-09-20
| Lane | Change | Proof |
|---|---|---|
| visual | Quiet Ledger (Jack's pick) applied across frame, CRM, work, outbound, sourcing, sign-in | builders checked own screenshots at 1440 and 375; rule check: 0 shadows, 0 raw hex |
| content | legal footer in approved content, public one-click opt-out, reply/bounce/unsubscribe sync, Replies page, Find emails with credit confirm + daily cap, People and access | smoke 200 on all routes; opt-out works signed out |
| perf | signals ranking 40 queries to 2, identical output | measured on demo db |
| practicality | real leads imported (25 contacts / 24 companies); free research: 6 strong, 11 possible, 7 poor fits; 81 signals collected | sources on every company page |
| safety | send path behind 4 switches, dry-run default; repliers and unsubscribed never re-emailed; rate limits in DB; input validation | 202 tests |
| regression | tsc clean, eslint 0, vitest 202/202, all routes 200 | 202/202 |
**Criteria:** 6 yes / 1 partial / 0 no (partial: /visual judges not yet run) · **Backlog:** B24, B25, B26
