# BACKLOG-jaswarm
- [ ] 2026-09-19 lint: react-hooks/set-state-in-effect in components/pipeline/CompanySearch.tsx:25, components/sending/QueueClient.tsx:54, components/sending/SuppressionPanel.tsx:35, outbound/mailboxes/page.tsx:47 (fetch-in-effect pattern; not a runtime bug)
- [ ] 2026-09-19 perf: N+1 in app/lib/signals/queries.ts:75-102 (one signals query per company, up to 201 round trips). Fold into one query with a window function or a single IN query grouped in JS.
- [ ] 2026-09-19 validation: app/api/companies/route.ts POST accepts a 200,000 char name and negative employees; non-numeric employees silently becomes null. Add bounds + a 400 with a clear message. Same audit on contacts/deals/tasks.
- [ ] 2026-09-19 UX: turning Do not contact back OFF leaves the do-not-contact list entry in place (by design, owner-only removal). Say so in the toggle copy so nobody thinks the contact is reachable again.
- [ ] 2026-09-19 DataTable: Apollo results table keeps a local checkbox table until DataTable selection props land; adopt once crm-r2 ships them.
- [ ] 2026-09-19 login rate limit is in-memory per process; move to the DB before any multi-instance deploy.
