# Banker Harness: architecture contract

- **Config-driven.** `firm.config.ts` is the only file that names a firm. Reusable code imports from it.
- **Data.** `app/lib/db.ts` exports `db()` (node:sqlite DatabaseSync, sync API) and `audit()`. The schema lives there. Need a schema change? Report it; the main session applies it.
- **Auth.** `app/lib/session.ts`: `requireUser(roles?)` at the top of every API route (returns the user or a Response), `currentUser()` in server components. Roles: owner, principal, member. `proxy.ts` gates every route.
- **API routes** run on the Node runtime (`export const runtime = "nodejs"`), validate input, use prepared statements only, and write an `audit()` row for every state change.
- **Compliance model (FINRA Rule 2210).** Outbound content is approved by a user with role `principal`. Approval binds to `content_hash` (sha256 of subject + body + allowed merge fields). Any edit resets status to draft and voids approval. Messages render only allow-listed merge fields into an approved template. The send pipe re-checks hash, approval, suppression, do_not_contact, lint, mailbox cap and `OUTBOUND_SEND_ENABLED=1` at send time, and fails closed on any miss. The submitter of a template cannot approve it.
- **Styling.** Tailwind 4 utilities plus the CSS variables in `app/globals.css`. No raw hex in components. No status or live indicator dots. No em dashes in copy. Honest empty states, never fake numbers.
- **Nav.** Only `app/lib/nav.ts`. Report new entries to the main session.
- **Shared files (main session only):** firm.config.ts, app/lib/db.ts, app/lib/session.ts, app/lib/nav.ts, proxy.ts, app/layout.tsx, app/globals.css, app/components/Shell.tsx, package.json, next.config.ts.
