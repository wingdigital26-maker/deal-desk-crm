# FRONTIER
| id | parent_id | label | level | status | last_round | source | note |
|---|---|---|---|---|---|---|---|
| B1 | - | auth: login page + login/logout API + seed-user script | 1 | done | 2 | jack | |
| B2 | - | CRM core: companies + contacts (list, detail, create, edit, CSV import) + timeline | 1 | done | 2 | jack | |
| B3 | - | pipeline board + deals + tasks + Today page | 1 | done | 2 | jack | |
| B4 | - | outbound compliance core: templates, voice lint, content-hash approval, approvals queue, audit trail | 1 | done | 2 | jack | Rule 2210 model |
| B5 | - | warmup ramp scheduler + mailboxes + fail-closed send pipe + suppression | 1 | done | 2 | jack | never auto-fires |
| B6 | - | Apollo integration: people/company search to import, sequence push adapter | 1 | done | 2 | jack | key via env only |
| B7 | - | Python zero-usage scrapers: signal engine bridge + sourcing page | 1 | done | 2 | jack | |
| B8 | - | real test suite on gates (approval hash, send gate, lint, ramp math) | 1 | done | 2 | jack | vitest |
| B9 | - | /visual v3 pass on shell + key screens, Jack decides Stage 2 | 1 | open | 1 | jack | after UI exists |
| B10 | B5 | UI to queue an approved template to selected contacts (row selection on /contacts + company contacts; "Queue this template" on template detail) | 2 | done | 2 | practicality | POST /api/outbound/queue has zero UI callers |
| B11 | B5 | owner-only "Run due messages" control on /outbound/queue with a confirm step and the block reasons shown | 2 | done | 2 | practicality | POST /api/outbound/run has zero UI callers |
| B12 | B9 | shared Button + adopt PageHeader/DataTable/EmptyState on pipeline, tasks, outbound, sourcing, audit (11 button variants, 7 hand-rolled headers) | 2 | done | 2 | practicality | consolidation before /visual |
| B13 | B4 | plain-English compliance wording: Lint -> Compliance check, hide raw hash behind "Approval reference", merge fields -> Personalization fields, Suppression -> Do-not-contact list | 2 | done | 2 | practicality | |
| B14 | B2 | one-click "Open a deal" and "Add contact" from /companies/[id] empty states; task form can attach to a deal/contact | 2 | done | 2 | practicality | |
| B15 | B7 | em dash in generated deal title app/components/sourcing/CreateDealButton.tsx:18; replace table "-" placeholders with a plain hyphen or blank | 2 | done | 2 | practicality | hard rule |
| B16 | B8 | fix 4 react-hooks/set-state-in-effect lint errors | 2 | done | 2 | verifier | see BACKLOG |
| B17 | B9 | Quiet Ledger applied to every screen (frame, CRM, work, outbound, sourcing, sign-in) | 2 | done | 3 | jack | Jack's Stage 2 pick |
| B18 | B5 | legal footer as approved content + public one-click opt-out + never re-email a replier | 2 | done | 3 | jack | CAN-SPAM |
| B19 | B6 | real Apollo send path (free-form approved content), 4 switches, dry-run default | 2 | done | 3 | jack | docs claim needs independent verify |
| B20 | B6 | owner-only enrichment with daily credit cap; replies/bounces/unsubscribes sync; Replies page | 2 | done | 3 | jack | |
| B21 | B1 | People and access, DB rate limits, change password, validation, backups, hidden scheduled tasks (not installed) | 2 | done | 3 | jack | |
| B22 | B7 | real-company research + collector on the 24 real companies (81 signals) | 2 | done | 3 | jack | 7 poor fits found |
| B23 | - | deploy plan, container recipe, Postgres schema | 2 | done | 3 | jack | hosting needs firm IT sign-off |
| B24 | B22 | fit check as a standing gate: every imported company gets an ownership/fit read before it can enter an outbound list | 2 | open | 3 | verifier | ~30% of Apollo owner leads were PE-owned, sold, or out of state |
| B25 | B21 | force "choose your own password" on first sign-in (column exists: users.must_change_password) | 3 | open | 3 | verifier | TODO markers in app/api/users |
| B26 | B19 | independent verify of the Apollo free-form send claim against docs | 3 | open | 3 | jack | load-bearing |
| B9 | - | /visual loop stages 4-9 on the real screens | 1 | active | 3 | jack | capture, gate, conversion lint, judges |
| B27 | B7 | signal attribution: contracts collector matches a federal award recipient by NAME only; require a city/state match against the company before storing, and show "unconfirmed" until then | 3 | open | 3 | jack | 17 contract signals in the real workspace are unverified (three companies) |
| B28 | B7 | SEC filings collector disabled: re-enable only with a CIK identity check (state + address), never a name match | 3 | open | 3 | jack | 46 false attributions removed 2026-09-20 |
| B29 | B1 | go-live hygiene: the real workspace carries placeholder logins (owner@harness.local, "Compliance Principal") and ~130 audit rows of security-test activity; start a FRESH production database with real named accounts at launch and archive this one | 3 | open | 3 | jack | audit log is append-only by design, so archive, never edit |
