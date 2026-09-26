// Outlook / Graph auto-capture against a temp database with a mocked fetch.
// No test ever reaches a real Microsoft endpoint: fetch is stubbed globally and
// every credential below is a fake placeholder.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SECRET = "g".repeat(32);
const MAILBOX = "banker@firm.example";
let currentToken: string | undefined;

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "harness_session" ? { value: currentToken } : undefined),
  }),
}));

let dbModule: typeof import("../app/lib/db");
let sessionModule: typeof import("../app/lib/session");
let captureModule: typeof import("../app/lib/graph/capture");
let statusRoute: typeof import("../app/api/capture/graph/status/route");
let syncRoute: typeof import("../app/api/capture/graph/sync/route");

const GRAPH_ENV = ["GRAPH_CAPTURE_ENABLED", "GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_MAILBOX"];

function turnOn() {
  process.env.GRAPH_CAPTURE_ENABLED = "1";
  process.env.GRAPH_TENANT_ID = "00000000-0000-0000-0000-000000000000";
  process.env.GRAPH_CLIENT_ID = "11111111-1111-1111-1111-111111111111";
  process.env.GRAPH_CLIENT_SECRET = "fake-test-secret";
  process.env.GRAPH_MAILBOX = MAILBOX;
}

type Fixture = { messages?: unknown[]; events?: unknown[] };

function mockGraph(fx: Fixture) {
  return vi.fn(async (input: string) => {
    const url = String(input);
    if (url.startsWith("https://login.microsoftonline.com/")) {
      return Response.json({ access_token: "fake-token", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.includes("/messages?")) return Response.json({ value: fx.messages ?? [] });
    if (url.includes("/calendarView?")) return Response.json({ value: fx.events ?? [] });
    return new Response("unexpected", { status: 404 });
  });
}

beforeEach(async () => {
  const tmpDir = mkdtempSync(path.join(tmpdir(), "harness-graph-"));
  process.env.HARNESS_DB_PATH = path.join(tmpDir, "test.db");
  process.env.SESSION_SECRET = SECRET;
  for (const k of GRAPH_ENV) delete process.env[k];
  currentToken = undefined;
  vi.resetModules();
  dbModule = await import("../app/lib/db");
  sessionModule = await import("../app/lib/session");
  captureModule = await import("../app/lib/graph/capture");
  statusRoute = await import("../app/api/capture/graph/status/route");
  syncRoute = await import("../app/api/capture/graph/sync/route");
  dbModule.db();
});

afterEach(() => {
  delete process.env.SESSION_SECRET;
  delete process.env.HARNESS_DB_PATH;
  for (const k of GRAPH_ENV) delete process.env[k];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function signInAs(role: "owner" | "principal" | "member") {
  const email = `${role}-${Math.random()}@example.com`;
  const info = dbModule
    .db()
    .prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)")
    .run(email, `Test ${role}`, role, "scrypt$aa$bb");
  const id = Number(info.lastInsertRowid);
  currentToken = (await sessionModule.signSession({ id, email, name: `Test ${role}`, role })) ?? undefined;
  return id;
}

function insertContact(email: string) {
  const co = dbModule.db().prepare("INSERT INTO companies (name) VALUES (?)").run("Example Holdings");
  const companyId = Number(co.lastInsertRowid);
  const c = dbModule
    .db()
    .prepare("INSERT INTO contacts (company_id, first_name, email) VALUES (?,?,?)")
    .run(companyId, "Pat", email);
  return { contactId: Number(c.lastInsertRowid), companyId };
}

const activities = () =>
  dbModule.db().prepare("SELECT kind, body, contact_id, company_id, created_at FROM activities ORDER BY id").all() as {
    kind: string;
    body: string;
    contact_id: number;
    company_id: number;
    created_at: string;
  }[];

const outgoing = (to: string, id = "AAMk-1") => ({
  id,
  internetMessageId: `<${id}@firm.example>`,
  subject: "Following up on our call",
  from: { emailAddress: { address: MAILBOX } },
  toRecipients: [{ emailAddress: { address: to } }],
  ccRecipients: [],
  sentDateTime: "2026-09-20T14:03:00Z",
  receivedDateTime: "2026-09-20T14:03:01Z",
  bodyPreview: "Thanks for the time today. " + "x".repeat(900),
  conversationId: "conv-1",
});

describe("flag off", () => {
  it("sync route refuses with 409 and never calls fetch", async () => {
    const fetchMock = mockGraph({});
    vi.stubGlobal("fetch", fetchMock);
    await signInAs("owner");
    const res = await syncRoute.POST();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/turned off/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enabled but missing settings still refuses with 409 and no fetch", async () => {
    const fetchMock = mockGraph({});
    vi.stubGlobal("fetch", fetchMock);
    process.env.GRAPH_CAPTURE_ENABLED = "1";
    await signInAs("owner");
    const res = await syncRoute.POST();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/GRAPH_CLIENT_SECRET/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("status reports off and names missing settings without values", async () => {
    const fetchMock = mockGraph({});
    vi.stubGlobal("fetch", fetchMock);
    await signInAs("member");
    const res = await statusRoute.GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.enabled).toBe(false);
    expect(json.configured).toBe(false);
    expect(json.missing).toContain("GRAPH_MAILBOX");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a value other than exactly 1 stays off", async () => {
    turnOn();
    process.env.GRAPH_CAPTURE_ENABLED = "true";
    const fetchMock = mockGraph({});
    const r = await captureModule.captureFromGraph({ fetchImpl: fetchMock });
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("auth", () => {
  it("signed out gets 401 on both routes", async () => {
    expect((await statusRoute.GET()).status).toBe(401);
    expect((await syncRoute.POST()).status).toBe(401);
  });

  it("member gets 403 on sync", async () => {
    turnOn();
    const fetchMock = mockGraph({});
    vi.stubGlobal("fetch", fetchMock);
    await signInAs("member");
    expect((await syncRoute.POST()).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("capture on", () => {
  it("a message to a known contact writes exactly one email-out activity, bounded, and audits", async () => {
    turnOn();
    const { contactId, companyId } = insertContact("Pat@Example.com");
    const fetchMock = mockGraph({ messages: [outgoing("pat@example.com")] });
    vi.stubGlobal("fetch", fetchMock);
    await signInAs("owner");

    const res = await syncRoute.POST();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.counts).toEqual({ messagesSeen: 1, eventsSeen: 0, activitiesWritten: 1, skippedUnknown: 0 });

    const rows = activities();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("email-out");
    expect(rows[0].contact_id).toBe(contactId);
    expect(rows[0].company_id).toBe(companyId);
    expect(rows[0].body.startsWith("Following up on our call: Thanks")).toBe(true);
    expect(rows[0].body.length).toBeLessThanOrEqual(500);
    expect(rows[0].created_at).toBe("2026-09-20 14:03:00");

    const auditRow = dbModule.db().prepare("SELECT detail_json FROM audit_log WHERE action = 'capture.graph.sync'").get() as
      | { detail_json: string }
      | undefined;
    expect(JSON.parse(auditRow!.detail_json).activitiesWritten).toBe(1);

    // Only Microsoft hosts were called, and the secret only went to the token endpoint.
    for (const [url, init] of fetchMock.mock.calls as unknown as [string, RequestInit | undefined][]) {
      expect(url.startsWith("https://login.microsoftonline.com/") || url.startsWith("https://graph.microsoft.com/")).toBe(true);
      if (url.startsWith("https://graph.microsoft.com/")) expect(String(init?.body ?? "")).not.toContain("fake-test-secret");
    }
  });

  it("an inbound message from a known contact is email-in", async () => {
    turnOn();
    insertContact("pat@example.com");
    const msg = {
      ...outgoing(MAILBOX, "AAMk-in"),
      from: { emailAddress: { address: "pat@example.com" } },
      toRecipients: [{ emailAddress: { address: MAILBOX } }],
    };
    const r = await captureModule.captureFromGraph({ fetchImpl: mockGraph({ messages: [msg] }) });
    expect(r.ok).toBe(true);
    expect(activities().map((a) => a.kind)).toEqual(["email-in"]);
  });

  it("running capture twice writes nothing new", async () => {
    turnOn();
    insertContact("pat@example.com");
    const fx = { messages: [outgoing("pat@example.com")] };
    const first = await captureModule.captureFromGraph({ fetchImpl: mockGraph(fx) });
    const second = await captureModule.captureFromGraph({ fetchImpl: mockGraph(fx) });
    expect(first.ok && first.counts.activitiesWritten).toBe(1);
    expect(second.ok && second.counts.activitiesWritten).toBe(0);
    expect(activities()).toHaveLength(1);
    const cursor = dbModule.db().prepare("SELECT value FROM sync_cursors WHERE name = 'graph.messages'").get() as { value: string };
    expect(cursor.value).toBe("2026-09-20T14:03:01Z");
  });

  it("messages with no known participant are skipped and no contact is created", async () => {
    turnOn();
    const before = (dbModule.db().prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n;
    const r = await captureModule.captureFromGraph({
      fetchImpl: mockGraph({ messages: [outgoing("stranger@unknown.example")] }),
    });
    expect(r.ok && r.counts).toEqual({ messagesSeen: 1, eventsSeen: 0, activitiesWritten: 0, skippedUnknown: 1 });
    expect(activities()).toHaveLength(0);
    const after = (dbModule.db().prepare("SELECT COUNT(*) AS n FROM contacts").get() as { n: number }).n;
    expect(after).toBe(before);
  });

  it("a calendar event with a known attendee writes a meeting activity", async () => {
    turnOn();
    const { contactId } = insertContact("pat@example.com");
    const event = {
      id: "evt-1",
      iCalUId: "ical-1",
      subject: "Intro meeting",
      start: { dateTime: "2026-09-21T15:00:00.0000000", timeZone: "UTC" },
      end: { dateTime: "2026-09-21T16:00:00.0000000", timeZone: "UTC" },
      organizer: { emailAddress: { address: MAILBOX } },
      attendees: [{ emailAddress: { address: "PAT@example.com" } }, { emailAddress: { address: "nobody@else.example" } }],
    };
    const r = await captureModule.captureFromGraph({
      fetchImpl: mockGraph({ events: [event] }),
      now: new Date("2026-09-25T12:00:00Z"),
    });
    expect(r.ok && r.counts).toEqual({ messagesSeen: 0, eventsSeen: 1, activitiesWritten: 1, skippedUnknown: 0 });
    const rows = activities();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("meeting");
    expect(rows[0].contact_id).toBe(contactId);
    expect(rows[0].body).toBe("Intro meeting (2026-09-21 15:00:00 UTC)");
  });

  it("follows nextLink only on the Graph host and stops at the page cap", async () => {
    turnOn();
    insertContact("pat@example.com");
    let pageCalls = 0;
    const fetchMock = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.startsWith("https://login.microsoftonline.com/")) return Response.json({ access_token: "fake-token" });
      if (url.includes("/calendarView")) return Response.json({ value: [] });
      pageCalls++;
      return Response.json({
        value: [outgoing("pat@example.com", `m-${pageCalls}`)],
        "@odata.nextLink": `https://graph.microsoft.com/v1.0/users/x/messages?page=${pageCalls + 1}`,
      });
    });
    const r = await captureModule.captureFromGraph({ fetchImpl: fetchMock });
    expect(pageCalls).toBe(10);
    expect(r.ok && r.counts.activitiesWritten).toBe(10);

    const evil = vi.fn(async (input: string) => {
      const url = String(input);
      if (url.startsWith("https://login.microsoftonline.com/")) return Response.json({ access_token: "fake-token" });
      return Response.json({ value: [], "@odata.nextLink": "https://attacker.example/steal" });
    });
    await captureModule.captureFromGraph({ fetchImpl: evil });
    expect(evil.mock.calls.some(([u]) => String(u).includes("attacker.example"))).toBe(false);
  });
});
