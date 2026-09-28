# Deal Desk: request for compliance and IT sign-off

For: the firm's compliance and IT principal. From: the M&A deal team.
Purpose: a yes or no on three things, listed at the bottom as a checklist.
This brief describes how the system works today. It is not legal advice;
where it reads a rule, it says so, and the firm's own reading governs.

## What we are asking

1. **Host Deal Desk privately, with login on.** One server at a hosting
   provider, reachable over HTTPS only, every user with their own login.
   The step-by-step recipe is in `docs/HOSTED-DEPLOY.md`; the security
   checklist is in `docs/DEPLOY.md`.
2. **Hold live deal data in it**: buyer lists, buyer stages and bids,
   deal documents (NDAs, CIMs), with access limited to people who need it.
3. **Optionally, turn on Outlook capture**: read-only metadata from one
   banker's mailbox, described in `docs/OUTLOOK-CAPTURE.md`. It is built
   and switched off.

## What data, where it lives, who sees it

- **Data.** Companies, contacts (name, title, work email and phone), deals
  (stage, fee terms), per-deal buyer logs (stage, decline reason, IOI and
  LOI terms), uploaded deal documents, timeline notes, and, only if item 3
  is approved, email and meeting metadata (sender, recipients, subject,
  date, a preview of at most 500 characters; no bodies, no attachments).
- **Where.** One database file and one document folder on one encrypted
  disk volume at the chosen host (Fly.io or Railway, US region). Nothing is
  copied to any other service. Outbound sending is off (`OUTBOUND_SEND_ENABLED=0`).
- **Who.** Only named users with their own password; sessions expire after
  12 hours; no shared logins. Roles: owner, principal, member. Today there
  are two users. **Need-to-know is enforced per deal:** a user sees a deal,
  its buyer log, bids, documents, tasks and reports only if they are on that
  deal's team. Users with the owner role can open any deal to run the desk,
  and each such view of a deal they are not on is written to the audit log.
  Deals can carry a code name ("Project Juniper") that replaces the company
  name on the seller report and every export. See decision 4.
- **Backups.** A nightly snapshot of the database and documents is kept on
  the server (newest 14), a copy is pulled off the server to a machine the
  firm approves, and a restore drill is run before real data goes in
  (`scripts/backup-db.mjs`, `scripts/restore-db.mjs`).

## Records: the append-only trail

Rule 17a-4(f)(2)(i) lets a firm keep electronic records either on
non-rewriteable storage or in a system with a complete, time-stamped audit
trail that can recreate the original. Deal Desk is built toward the audit
trail alternative:

- **Buyer stage history**: every stage move is a new row, never edited.
- **Term revisions**: every change to a bid term keeps the old and new value.
- **Document versions**: a new upload is a new version; the database itself
  refuses to delete or rewrite a stored version.
- **audit_log**: sign-ins, approvals, imports, exports and downloads, append-only.
- Buyers and contacts are soft-removed, not deleted.

Honest limit: someone with server access could still alter the database
file. It is not WORM storage. The firm's existing archive (including
Outlook journaling) stays the book of record for communications. The firm
should decide whether Deal Desk holds any required books and records at all.

## MNPI controls (Exchange Act Section 15(g))

Deal names, buyers and bid values are material non-public information.
Controls in place: login on every page and API (the only public page is
the email unsubscribe link, which shows no deal data); exports and seller report
downloads are written to the audit log; no data leaves the system on its
own; a seller report hides bid values unless the banker turns them on.
Recommended: logins only for people inside the relevant information
barrier, and an IP allow-list or the firm's single sign-on as the next step.

## Vendor oversight (FINRA Notice 21-29, Rule 3110)

Two vendors are involved: the hosting provider, and Wing Digital, which
built the system and administers it. The firm keeps the supervisory
obligation for an outsourced function. Suggested file: the host's security
and SOC report, the vendor's access (who can reach the server, and how that
is revoked), and a written supervisory procedure naming who reviews the
audit log and how often.

## Reg S-P (our reading, not legal advice)

Reg S-P protects nonpublic personal information of *consumers* and
*customers*. 17 CFR 248.3 defines a consumer as an individual who obtains
a financial product or service primarily for personal, family or household
purposes. Deal Desk holds business deal data about companies and the people
at them acting in a business role, so our reading is that Reg S-P likely
does not reach most of it. Compliance should confirm, especially for any
business owner who is also a retail customer of the firm.

## Outbound communications (FINRA Rule 2210)

Already built: an outreach template cannot be sent until a principal
approves it, the approval is tied to the exact text (any edit voids it),
and every approved message handed to a sender is kept word for word.
Sending is disabled in the hosted recipe until the firm says otherwise.

## Decisions for the firm (yes or no)

| # | Decision | Yes / No |
| --- | --- | --- |
| 1 | Host Deal Desk at the named provider, HTTPS only, individual logins | |
| 2 | Hold live buyer lists, bids and deal documents in it | |
| 3 | Deal Desk is a working system, not a book of record; the firm's archive stays the record | |
| 4 | Approve per-deal need-to-know as built (deal team only; owner role sees all, audited) | |
| 5 | Decide who holds the owner role (sees every deal) versus member (deal team only) | |
| 6 | Nightly backup kept on the server plus a regular off-server copy to a firm-approved location | |
| 7 | Vendor file for the host and Wing Digital accepted under Notice 21-29 | |
| 8 | Named reviewer for the audit log, and review frequency: ________ | |
| 9 | Our Reg S-P reading above is acceptable | |
| 10 | Turn on Outlook capture for one mailbox: ________ (read-only, metadata only) | |
| 11 | Outbound sending stays off until a separate approval | |

Signed: ______________________  Date: ____________
