import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contentHash, renderTemplate } from "../app/lib/compliance";

// Every test stubs global fetch. Nothing here can reach Instantly.
const SEND_DAY = new Date(2026, 8, 21); // a Monday, so warmup caps are non-zero

const ALLOWED_DOMAIN = "send.example.com"; // stand-in for a real firm sending domain
const OTHER_TENANT_DOMAIN = "other-agency.example.com"; // stand-in for another tenant's sending domain

const ALL_INSTANTLY_ENV = {
  OUTBOUND_SEND_ENABLED: "1",
  OUTBOUND_PROVIDER: "instantly",
  INSTANTLY_API_KEY: "test-key",
  INSTANTLY_CAMPAIGN_ID: "11111111-2222-3333-4444-555555555555",
  INSTANTLY_ALLOWED_DOMAINS: ALLOWED_DOMAIN,
} as const;
const ENV_KEYS = Object.keys(ALL_INSTANTLY_ENV) as (keyof typeof ALL_INSTANTLY_ENV)[];

/** Sets exactly the reply-poll env (campaign id + allowlist), independent of the send-side switches. */
function setReplyPollEnv(campaignId: string = ALL_INSTANTLY_ENV.INSTANTLY_CAMPAIGN_ID, allowedDomains: string = ALLOWED_DOMAIN) {
  process.env.INSTANTLY_API_KEY = "test-key";
  process.env.INSTANTLY_CAMPAIGN_ID = campaignId;
  process.env.INSTANTLY_ALLOWED_DOMAINS = allowedDomains;
}

let tmpDir: string;
let dbModule: typeof import("../app/lib/db");
let sendGate: typeof import("../app/lib/outbound/sendGate");
let providerModule: typeof import("../app/lib/outbound/provider");
let poll: typeof import("../app/lib/replies/instantly");
let accounts: typeof import("../app/lib/instantly/accounts");

function setAllEnv() {
  for (const k of ENV_KEYS) process.env[k] = ALL_INSTANTLY_ENV[k];
}
function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}

function throwingFetch() {
  const f = vi.fn(() => {
    throw new Error("network I/O attempted");
  });
  vi.stubGlobal("fetch", f);
  return f;
}

function jsonFetch(responder: (url: string, init?: RequestInit) => unknown) {
  const f = vi.fn(async (url: string, init?: RequestInit) =>
    new Response(JSON.stringify(responder(url, init)), { status: 200, headers: { "Content-Type": "application/json" } })
  );
  vi.stubGlobal("fetch", f);
  return f;
}

async function freshDb() {
  tmpDir = mkdtempSync(path.join(tmpdir(), "harness-db-"));
  process.env.HARNESS_DB_PATH = path.join(tmpDir, "test.db");
  process.env.APP_BASE_URL = "https://harness.example.com";
  vi.resetModules();
  dbModule = await import("../app/lib/db");
  sendGate = await import("../app/lib/outbound/sendGate");
  providerModule = await import("../app/lib/outbound/provider");
  poll = await import("../app/lib/replies/instantly");
  accounts = await import("../app/lib/instantly/accounts");
  dbModule.db();
}

const d = () => dbModule.db();

function seedCompany(name: string) {
  return Number(d().prepare(`INSERT INTO companies (name) VALUES (?)`).run(name).lastInsertRowid);
}

function seedContact(email: string, companyId: number | null = null) {
  return Number(
    d()
      .prepare(`INSERT INTO contacts (first_name, last_name, email, email_status, company_id) VALUES ('Dana','Owner',?, 'valid', ?)`)
      .run(email, companyId).lastInsertRowid
  );
}

function seedTemplate(status: "approved" | "draft" | "pending" = "approved") {
  const subject = "Intro from {{sender_name}}";
  const body = "Hello {{first_name}}, a note about {{company_name}}.";
  const fields = ["sender_name", "first_name", "company_name"];
  const hash = contentHash(subject, body, fields);
  const id = Number(
    d()
      .prepare(
        `INSERT INTO templates (name, segment_id, subject, body, allowed_merge_fields, content_hash, status) VALUES ('T','owners',?,?,?,?,?)`
      )
      .run(subject, body, JSON.stringify(fields), hash, status).lastInsertRowid
  );
  return { id, subject, body, fields, hash };
}

let tok = 0;
function seedQueuedMessage(contactId: number, template: ReturnType<typeof seedTemplate>, mailbox: string) {
  tok += 1;
  const token = `tok-${tok}`;
  const merge = { sender_name: "Jordan Hale", first_name: "Dana", company_name: "Acme Co" };
  const r = renderTemplate(
    { subject: template.subject, body: template.body, allowedMergeFields: template.fields },
    merge,
    { unsubscribeUrl: `${process.env.APP_BASE_URL}/u/${token}` }
  );
  if (!r.ok) throw new Error(r.error);
  const id = Number(
    d()
      .prepare(
        `INSERT INTO outbound_messages (contact_id, template_id, template_hash, merge_json, rendered_subject, rendered_body, status, mailbox, unsubscribe_token, rendered_footer)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`
      )
      .run(contactId, template.id, template.hash, JSON.stringify(merge), r.subject, r.body, mailbox, token, r.footer).lastInsertRowid
  );
  return { id, subject: r.subject, body: r.body, footer: r.footer };
}

function seedMailbox(address = "jordan@send.example.com", dailyCap: number | null = null) {
  d()
    .prepare(`INSERT INTO mailboxes (address, provider, warmup_started, paused, daily_cap) VALUES (?, 'instantly', '2020-01-01', 0, ?)`)
    .run(address, dailyCap);
  return address;
}

type Email = Record<string, unknown>;
function email(overrides: Partial<Email> & { id: string; from: string; ts: string }): Email {
  const { from, ts, ...rest } = overrides;
  return {
    timestamp_created: ts,
    timestamp_email: ts,
    subject: "Re: Intro from Jordan Hale",
    from_address_email: from,
    lead: from,
    eaccount: "jordan@send.example.com",
    campaign_id: ALL_INSTANTLY_ENV.INSTANTLY_CAMPAIGN_ID,
    ue_type: 2,
    is_auto_reply: 0,
    thread_id: "thread-1",
    body: { text: "Happy to talk next week.\n\nOn Mon, Jordan wrote:\n> Hello Dana\n> unsubscribe here: https://harness.example.com/u/tok-1" },
    content_preview: "Happy to talk next week.",
    ...rest,
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(SEND_DAY);
  clearEnv();
  await freshDb();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearEnv();
  delete process.env.HARNESS_DB_PATH;
  delete process.env.APP_BASE_URL;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("InstantlyProvider gating", () => {
  it.each(ENV_KEYS)("refuses to construct when %s is missing, and getProvider falls back to dry run", (missing) => {
    const f = throwingFetch();
    for (const k of ENV_KEYS) if (k !== missing) process.env[k] = ALL_INSTANTLY_ENV[k];
    expect(() => new providerModule.InstantlyProvider()).toThrow(/not configured/);
    expect(providerModule.getProvider()).toBeInstanceOf(providerModule.DryRunProvider);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses when OUTBOUND_SEND_ENABLED is anything but exactly 1", () => {
    setAllEnv();
    process.env.OUTBOUND_SEND_ENABLED = "true";
    expect(providerModule.getProvider()).toBeInstanceOf(providerModule.DryRunProvider);
  });

  it("returns InstantlyProvider only when all four switches are set, without any network call", () => {
    const f = throwingFetch();
    setAllEnv();
    expect(providerModule.getProvider()).toBeInstanceOf(providerModule.InstantlyProvider);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("InstantlyProvider push", () => {
  it("pushes only the approved rendered content plus the lead identity, to the Create lead endpoint", async () => {
    setAllEnv();
    const companyId = seedCompany("Acme Co");
    const contactId = seedContact("dana@acme.test", companyId);
    const mailbox = seedMailbox();
    const msg = seedQueuedMessage(contactId, seedTemplate(), mailbox);
    expect(sendGate.checkSend(msg.id).ok).toBe(true);

    const f = jsonFetch(() => ({ id: "lead-123" }));
    const provider = providerModule.getProvider();
    const fullBody = `${msg.body}\n\n${msg.footer}`;
    const result = await provider.send({
      messageId: msg.id,
      mailboxAddress: mailbox,
      toEmail: "dana@acme.test",
      subject: msg.subject,
      body: fullBody,
      lead: { firstName: "Dana", lastName: "Owner", companyName: "Acme Co" },
    });

    expect(result).toEqual({ ok: true, providerId: "instantly_lead_lead-123" });
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.instantly.ai/api/v2/leads");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-key");
    const sent = JSON.parse(String(init.body));
    expect(Object.keys(sent).sort()).toEqual(
      ["campaign", "company_name", "custom_variables", "email", "first_name", "last_name", "skip_if_in_campaign"].sort()
    );
    expect(sent.campaign).toBe(ALL_INSTANTLY_ENV.INSTANTLY_CAMPAIGN_ID);
    expect(sent.skip_if_in_campaign).toBe(true);
    expect(sent.custom_variables).toEqual({ subject: msg.subject, body: fullBody });
    expect(sent.custom_variables.body).toContain("/u/tok-"); // the per-recipient opt-out link travels with the approved text
  });

  it("reports failure without throwing when Instantly returns no lead id", async () => {
    setAllEnv();
    jsonFetch(() => ({}));
    const r = await providerModule.getProvider().send({
      messageId: 1,
      mailboxAddress: "a@b.c",
      toEmail: "x@y.z",
      subject: "s",
      body: "b",
    });
    expect(r.ok).toBe(false);
  });
});

describe("send gate still runs first with Instantly configured", () => {
  it("blocks an unapproved template", () => {
    setAllEnv();
    const f = throwingFetch();
    const msg = seedQueuedMessage(seedContact("a@acme.test"), seedTemplate("pending"), seedMailbox());
    const r = sendGate.checkSend(msg.id);
    expect(r.ok).toBe(false);
    expect(r.blocks.join(" ")).toMatch(/not sendable/);
    expect(f).not.toHaveBeenCalled();
  });

  it("blocks a suppressed contact", () => {
    setAllEnv();
    const msg = seedQueuedMessage(seedContact("s@acme.test"), seedTemplate(), seedMailbox());
    d().prepare(`INSERT INTO suppression (email, reason) VALUES ('s@acme.test', 'unsubscribe')`).run();
    const r = sendGate.checkSend(msg.id);
    expect(r.ok).toBe(false);
    expect(r.blocks.join(" ")).toMatch(/suppression/);
  });

  it("blocks a contact who replied through Instantly", async () => {
    setAllEnv();
    const contactId = seedContact("r@acme.test", seedCompany("Acme Co"));
    const msg = seedQueuedMessage(contactId, seedTemplate(), seedMailbox());
    jsonFetch(() => ({ items: [email({ id: "e1", from: "r@acme.test", ts: "2026-09-20T10:00:00.000Z" })] }));
    await poll.pollInstantlyReplies();
    const r = sendGate.checkSend(msg.id);
    expect(r.ok).toBe(false);
    expect(r.blocks.join(" ")).toMatch(/replied/);
    // and the message that was waiting was cancelled
    const row = d().prepare(`SELECT status FROM outbound_messages WHERE id = ?`).get(msg.id) as { status: string };
    expect(["cancelled", "held"]).toContain(row.status);
  });

  it("a recorded mailbox daily cap tightens the ramp, never loosens it", () => {
    setAllEnv();
    const mailbox = seedMailbox("capped@send.example.com", 0);
    const msg = seedQueuedMessage(seedContact("c@acme.test"), seedTemplate(), mailbox);
    const r = sendGate.checkSend(msg.id);
    expect(r.ok).toBe(false);
    expect(r.blocks.join(" ")).toMatch(/zero capacity/);
  });
});

describe("pollInstantlyReplies", () => {
  it("does nothing and makes no request when Instantly is not configured", async () => {
    const f = throwingFetch();
    const r = await poll.pollInstantlyReplies();
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Instantly is not configured.");
    expect(f).not.toHaveBeenCalled();
  });

  it("stores the full text, writes the timeline, and is idempotent on the Instantly id", async () => {
    setReplyPollEnv();
    const contactId = seedContact("dana@acme.test", seedCompany("Acme Co"));
    const items = [email({ id: "e1", from: "dana@acme.test", ts: "2026-09-20T10:00:00.000Z" })];
    jsonFetch(() => ({ items }));

    const first = await poll.pollInstantlyReplies();
    expect(first).toMatchObject({ ok: true, fetched: 1, inserted: 1, replies: 1 });
    const second = await poll.pollInstantlyReplies();
    expect(second).toMatchObject({ ok: true, fetched: 1, inserted: 0, dealsOpened: 0 });

    const rows = d().prepare(`SELECT kind, body, provider, provider_id FROM inbound_replies`).all() as {
      kind: string;
      body: string;
      provider: string;
      provider_id: string;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "reply", provider: "instantly", provider_id: "instantly:e1" });
    expect(rows[0].body).toContain("Happy to talk next week.");
    expect(rows[0].body).toContain("> Hello Dana"); // full text kept, quote included

    const acts = d().prepare(`SELECT kind, body FROM activities WHERE contact_id = ? AND kind = 'email-in'`).all(contactId) as {
      kind: string;
      body: string;
    }[];
    expect(acts).toHaveLength(1);
    expect(acts[0].body).toMatch(/^Reply received via Instantly/);
    expect(acts[0].body).toContain("Happy to talk next week.");
  });

  it("classifies on the replier's own words, so a quoted unsubscribe link does not unsubscribe them", async () => {
    setReplyPollEnv();
    const contactId = seedContact("dana@acme.test");
    jsonFetch(() => ({ items: [email({ id: "e1", from: "dana@acme.test", ts: "2026-09-20T10:00:00.000Z" })] }));
    await poll.pollInstantlyReplies();
    const c = d().prepare(`SELECT do_not_contact FROM contacts WHERE id = ?`).get(contactId) as { do_not_contact: number };
    expect(c.do_not_contact).toBe(0);
  });

  it("opens one first-stage deal per company, with an audit row", async () => {
    setReplyPollEnv();
    const companyId = seedCompany("Acme Co");
    seedContact("dana@acme.test", companyId);
    seedContact("lee@acme.test", companyId);
    jsonFetch(() => ({
      items: [
        email({ id: "e1", from: "dana@acme.test", ts: "2026-09-20T10:00:00.000Z" }),
        email({ id: "e2", from: "lee@acme.test", ts: "2026-09-20T11:00:00.000Z", thread_id: "thread-2" }),
      ],
    }));
    const r = await poll.pollInstantlyReplies();
    expect(r.dealsOpened).toBe(1);
    const deals = d().prepare(`SELECT title, stage FROM deals WHERE company_id = ?`).all(companyId) as { title: string; stage: string }[];
    expect(deals).toEqual([{ title: "Acme Co: replied to outreach", stage: "Sourced" }]);
    const audits = d().prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'deal.create'`).get() as { n: number };
    expect(audits.n).toBe(1);
  });

  it("does not open a deal when the company already has an open one", async () => {
    setReplyPollEnv();
    const companyId = seedCompany("Acme Co");
    seedContact("dana@acme.test", companyId);
    d().prepare(`INSERT INTO deals (company_id, title, stage) VALUES (?, 'Existing', 'NDA')`).run(companyId);
    jsonFetch(() => ({ items: [email({ id: "e1", from: "dana@acme.test", ts: "2026-09-20T10:00:00.000Z" })] }));
    const r = await poll.pollInstantlyReplies();
    expect(r.dealsOpened).toBe(0);
    const n = d().prepare(`SELECT COUNT(*) AS n FROM deals`).get() as { n: number };
    expect(n.n).toBe(1);
  });

  it.each([
    ["Instantly's is_auto_reply flag", { is_auto_reply: 1, subject: "Re: Intro" }],
    ["an out-of-office subject", { is_auto_reply: 0, subject: "Out of Office: back Monday" }],
  ])("stores an auto-reply (%s) but opens no deal and does not suppress the contact", async (_label, extra) => {
    setReplyPollEnv();
    const companyId = seedCompany("Acme Co");
    const contactId = seedContact("dana@acme.test", companyId);
    jsonFetch(() => ({ items: [email({ id: "ooo1", from: "dana@acme.test", ts: "2026-09-20T10:00:00.000Z", ...extra })] }));
    const r = await poll.pollInstantlyReplies();
    expect(r).toMatchObject({ inserted: 1, autoReplies: 1, replies: 0, dealsOpened: 0 });
    const kind = d().prepare(`SELECT kind FROM inbound_replies`).get() as { kind: string };
    expect(kind.kind).toBe("auto-reply");
    const deals = d().prepare(`SELECT COUNT(*) AS n FROM deals`).get() as { n: number };
    expect(deals.n).toBe(0);
    const replied = d().prepare(`SELECT COUNT(*) AS n FROM inbound_replies WHERE contact_id = ? AND kind = 'reply'`).get(contactId) as {
      n: number;
    };
    expect(replied.n).toBe(0);
  });

  it("advances the cursor and uses it as min_timestamp_created on the next poll", async () => {
    setReplyPollEnv();
    seedContact("dana@acme.test");
    const f = jsonFetch(() => ({
      items: [
        email({ id: "e1", from: "dana@acme.test", ts: "2026-09-20T10:00:00.000Z" }),
        email({ id: "e2", from: "dana@acme.test", ts: "2026-09-20T12:30:00.000Z" }),
      ],
    }));
    expect(poll.getCursor(poll.INSTANTLY_CURSOR)).toBeNull();
    const r = await poll.pollInstantlyReplies();
    expect(r.cursor).toBe("2026-09-20T12:30:00.000Z");
    expect(poll.getCursor(poll.INSTANTLY_CURSOR)).toBe("2026-09-20T12:30:00.000Z");

    const firstUrl = new URL(String(f.mock.calls[0][0]));
    expect(firstUrl.pathname).toBe("/api/v2/emails");
    expect(firstUrl.searchParams.get("email_type")).toBe("received");
    expect(firstUrl.searchParams.get("campaign_id")).toBe(ALL_INSTANTLY_ENV.INSTANTLY_CAMPAIGN_ID);

    await poll.pollInstantlyReplies();
    const secondUrl = new URL(String(f.mock.calls[1][0]));
    expect(secondUrl.searchParams.get("min_timestamp_created")).toBe("2026-09-20T12:30:00.000Z");
  });

  it("follows next_starting_after across pages", async () => {
    setReplyPollEnv();
    seedContact("dana@acme.test");
    const f = jsonFetch((url) => {
      const after = new URL(url).searchParams.get("starting_after");
      return after
        ? { items: [email({ id: "e2", from: "dana@acme.test", ts: "2026-09-20T12:00:00.000Z" })] }
        : { items: [email({ id: "e1", from: "dana@acme.test", ts: "2026-09-20T10:00:00.000Z" })], next_starting_after: "e1" };
    });
    const r = await poll.pollInstantlyReplies();
    expect(f).toHaveBeenCalledTimes(2);
    expect(r.fetched).toBe(2);
    expect(r.inserted).toBe(2);
  });
});

describe("Instantly accounts into Mailboxes (shared-workspace isolation)", () => {
  it("adds missing mailboxes with domain and daily cap, and never touches non-Instantly rows", () => {
    process.env.INSTANTLY_ALLOWED_DOMAINS = ALLOWED_DOMAIN;
    d().prepare(`INSERT INTO mailboxes (address, provider, daily_cap) VALUES ('old@apollo.test', 'apollo', NULL)`).run();
    const r = accounts.upsertInstantlyAccounts(
      [
        { email: "Jordan@Send.Example.com", daily_limit: 30, timestamp_warmup_start: "2026-08-01T00:00:00.000Z" },
        { email: "old@apollo.test", daily_limit: 5 },
      ],
      null
    );
    // old@apollo.test's domain (apollo.test) is not in the allowlist, so it is
    // counted as skipped, not imported or updated -- same net effect as
    // before (its provider was never 'instantly'), but now for the right
    // reason: domain isolation, not just "not an Instantly row".
    expect(r).toEqual({ fetched: 2, added: 1, updated: 0, skippedNotAllowed: 1 });
    const rows = d().prepare(`SELECT address, provider, domain, daily_cap, warmup_started FROM mailboxes ORDER BY id`).all();
    expect(rows).toEqual([
      { address: "old@apollo.test", provider: "apollo", domain: null, daily_cap: null, warmup_started: null },
      { address: "jordan@send.example.com", provider: "instantly", domain: "send.example.com", daily_cap: 30, warmup_started: "2026-08-01" },
    ]);
  });

  it("does not import another tenant's mailbox even though it shares the same Instantly workspace", () => {
    process.env.INSTANTLY_ALLOWED_DOMAINS = ALLOWED_DOMAIN;
    const r = accounts.upsertInstantlyAccounts(
      [
        { email: "jordan@send.example.com", daily_limit: 30 },
        { email: `outreach@${OTHER_TENANT_DOMAIN}`, daily_limit: 50 },
      ],
      null
    );
    expect(r).toEqual({ fetched: 2, added: 1, updated: 0, skippedNotAllowed: 1 });
    const rows = d().prepare(`SELECT address FROM mailboxes`).all() as { address: string }[];
    expect(rows.map((row) => row.address)).toEqual(["jordan@send.example.com"]);
    // The other tenant's address never appears in the mailboxes table at all.
    expect(rows.some((row) => row.address.includes(OTHER_TENANT_DOMAIN))).toBe(false);
  });

  it("imports nothing when INSTANTLY_ALLOWED_DOMAINS is empty or unset", () => {
    delete process.env.INSTANTLY_ALLOWED_DOMAINS;
    const r = accounts.upsertInstantlyAccounts(
      [
        { email: "jordan@send.example.com", daily_limit: 30 },
        { email: `outreach@${OTHER_TENANT_DOMAIN}`, daily_limit: 50 },
      ],
      null
    );
    expect(r).toEqual({ fetched: 2, added: 0, updated: 0, skippedNotAllowed: 2 });
    const n = d().prepare(`SELECT COUNT(*) AS n FROM mailboxes`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("rejects a substring match: mail.send.example.com is not send.example.com", () => {
    process.env.INSTANTLY_ALLOWED_DOMAINS = ALLOWED_DOMAIN;
    const r = accounts.upsertInstantlyAccounts([{ email: "jordan@mail.send.example.com", daily_limit: 30 }], null);
    expect(r).toEqual({ fetched: 1, added: 0, updated: 0, skippedNotAllowed: 1 });
  });
});

describe("Instantly mailbox pull route refuses without an allowlist (unit-level equivalent)", () => {
  it("getAllowedDomains parses a comma list case-insensitively and drops blanks", async () => {
    process.env.INSTANTLY_ALLOWED_DOMAINS = " YourFirm-Mail.example , yourfirmadvisory.example ,, ";
    const client = await import("../app/lib/instantly/client");
    expect(client.getAllowedDomains()).toEqual(["yourfirm-mail.example", "yourfirmadvisory.example"]);
  });

  it("getAllowedDomains returns an empty list when unset", async () => {
    delete process.env.INSTANTLY_ALLOWED_DOMAINS;
    const client = await import("../app/lib/instantly/client");
    expect(client.getAllowedDomains()).toEqual([]);
  });
});

describe("InstantlyProvider refuses without INSTANTLY_ALLOWED_DOMAINS (shared workspace)", () => {
  it("refuses to construct when every other switch is set but the allowlist is empty", () => {
    const f = throwingFetch();
    setAllEnv();
    delete process.env.INSTANTLY_ALLOWED_DOMAINS;
    expect(() => new providerModule.InstantlyProvider()).toThrow(/not configured/);
    expect(providerModule.getProvider()).toBeInstanceOf(providerModule.DryRunProvider);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("pollInstantlyReplies refuses without campaign id + allowlist configured (shared workspace)", () => {
  it("refuses when INSTANTLY_API_KEY is set but INSTANTLY_CAMPAIGN_ID and INSTANTLY_ALLOWED_DOMAINS are not", async () => {
    const f = throwingFetch();
    process.env.INSTANTLY_API_KEY = "test-key";
    const r = await poll.pollInstantlyReplies();
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not configured/i);
    expect(f).not.toHaveBeenCalled();
  });

  it("refuses when the campaign id is set but the allowlist is not", async () => {
    const f = throwingFetch();
    process.env.INSTANTLY_API_KEY = "test-key";
    process.env.INSTANTLY_CAMPAIGN_ID = ALL_INSTANTLY_ENV.INSTANTLY_CAMPAIGN_ID;
    const r = await poll.pollInstantlyReplies();
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("skips and never stores a reply whose campaign_id is not one of ours, even though it passed the server-side filter", async () => {
    setReplyPollEnv();
    seedContact("dana@acme.test");
    jsonFetch(() => ({
      items: [email({ id: "e1", from: "dana@acme.test", ts: "2026-09-20T10:00:00.000Z", campaign_id: "99999999-0000-0000-0000-000000000000" })],
    }));
    const r = await poll.pollInstantlyReplies();
    expect(r.inserted).toBe(0);
    expect(r.fetched).toBe(1);
    const n = d().prepare(`SELECT COUNT(*) AS n FROM inbound_replies`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("skips and never stores a reply on an allowed campaign sent through a mailbox that is not an allowed domain", async () => {
    setReplyPollEnv();
    seedContact("dana@acme.test");
    jsonFetch(() => ({
      items: [email({ id: "e1", from: "dana@acme.test", ts: "2026-09-20T10:00:00.000Z", eaccount: `outreach@${OTHER_TENANT_DOMAIN}` })],
    }));
    const r = await poll.pollInstantlyReplies();
    expect(r.inserted).toBe(0);
    expect(r.fetched).toBe(1);
    const n = d().prepare(`SELECT COUNT(*) AS n FROM inbound_replies`).get() as { n: number };
    expect(n.n).toBe(0);
  });

  it("still imports a reply that passes both the campaign and domain checks", async () => {
    setReplyPollEnv();
    seedContact("dana@acme.test");
    jsonFetch(() => ({ items: [email({ id: "e1", from: "dana@acme.test", ts: "2026-09-20T10:00:00.000Z" })] }));
    const r = await poll.pollInstantlyReplies();
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(1);
  });
});
