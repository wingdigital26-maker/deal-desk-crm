// Mirrors Instantly's sending accounts into the mailboxes table so the ramp
// and cap math on the Mailboxes page reflect the mailboxes that actually send.
// Source: GET https://api.instantly.ai/api/v2/accounts
// (https://developer.instantly.ai/api-reference/account/list-account).
// Adds missing mailboxes and refreshes domain + daily cap on Instantly ones.
// Never deletes, never unpauses, never changes a warmup date already recorded.
//
// SHARED WORKSPACE ISOLATION: this Instantly workspace may also hold another
// tenant's mailboxes (for example an agency's). Only accounts whose domain is in
// INSTANTLY_ALLOWED_DOMAINS (see app/lib/instantly/client.ts) are ever
// imported. If that allowlist is empty (the firm's own sending domains don't
// exist yet), nothing is imported. Skipped accounts are counted, never
// listed by address, so another tenant's mailbox addresses never surface in this app.
import { db, audit } from "../db";
import { listAccounts, getAllowedDomains, isAllowedDomain, domainOfAddress, type InstantlyAccount } from "./client";

export type AccountSyncResult = { fetched: number; added: number; updated: number; skippedNotAllowed: number };

export function domainOf(address: string): string | null {
  return domainOfAddress(address);
}

export function upsertInstantlyAccounts(accounts: InstantlyAccount[], actorUserId: number | null): AccountSyncResult {
  const allowedDomains = getAllowedDomains();
  let added = 0;
  let updated = 0;
  let skippedNotAllowed = 0;
  for (const a of accounts) {
    const address = (a.email || "").trim().toLowerCase();
    if (!address.includes("@")) continue;
    if (allowedDomains.length === 0 || !isAllowedDomain(address, allowedDomains)) {
      skippedNotAllowed += 1;
      continue;
    }
    const cap = typeof a.daily_limit === "number" && a.daily_limit >= 0 ? Math.floor(a.daily_limit) : null;
    const warmup = a.timestamp_warmup_start ? a.timestamp_warmup_start.slice(0, 10) : null;
    const existing = db().prepare(`SELECT id, provider FROM mailboxes WHERE address = ?`).get(address) as
      | { id: number; provider: string }
      | undefined;
    if (!existing) {
      const info = db()
        .prepare(`INSERT INTO mailboxes (address, provider, warmup_started, paused, domain, daily_cap) VALUES (?, 'instantly', ?, 0, ?, ?)`)
        .run(address, warmup, domainOf(address), cap);
      audit({ actorUserId, action: "mailbox.create", entity: "mailbox", entityId: Number(info.lastInsertRowid), detail: { address, source: "instantly", dailyCap: cap, warmupStarted: warmup } });
      added += 1;
    } else if (existing.provider === "instantly") {
      db().prepare(`UPDATE mailboxes SET domain = ?, daily_cap = ? WHERE id = ?`).run(domainOf(address), cap, existing.id);
      audit({ actorUserId, action: "mailbox.update", entity: "mailbox", entityId: existing.id, detail: { source: "instantly", dailyCap: cap } });
      updated += 1;
    }
  }
  return { fetched: accounts.length, added, updated, skippedNotAllowed };
}

export async function syncInstantlyAccounts(actorUserId: number | null): Promise<AccountSyncResult> {
  const accounts = await listAccounts();
  const result = upsertInstantlyAccounts(accounts, actorUserId);
  audit({ actorUserId, action: "mailboxes.instantly.sync", entity: "mailbox", detail: result });
  return result;
}
