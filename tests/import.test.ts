// IMPORTERS: the 4Degrees Deal List buyer import and the Outlook / Google
// contacts CSV mapping, against a real temp database.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cookieMock, freshApp, params, jsonReq, cleanup, harness, type App } from "./_harness";
import { detectMapping, planStage, parseDate, splitName, parseLocation, forwardStage } from "../app/lib/import4dMap";
import { detectContactSource, guessContactMapping } from "../app/lib/contactImportMap";
import { parseCsvWithHeader } from "../app/lib/csv";

vi.mock("next/headers", () => cookieMock());

const FIXTURE = readFileSync(path.join(__dirname, "fixtures", "import", "4degrees-list.csv"), "utf8");
const SAMPLE = readFileSync(path.join(__dirname, "..", "docs", "samples", "4degrees-sample.csv"), "utf8");

describe("column detection", () => {
  it("maps the 4Degrees list view headers", () => {
    const { headers } = parseCsvWithHeader(FIXTURE);
    expect(detectMapping(headers)).toMatchObject({
      company: "Company/Contact",
      contact: "Primary Contact",
      stage: "Stage",
      outcome: "Outcome",
      notes: "Notes",
      last_interaction: "Last Interaction",
      location: "Location",
      domain: "Website",
    });
  });
  it("is case, space and punctuation insensitive and knows synonyms", () => {
    const m = detectMapping(["COMPANY NAME", "primary_contact", "list stage", "Pass Reason", "comments", "last interaction date", "City", "Domain", "Owner"]);
    expect(m).toEqual({
      company: "COMPANY NAME",
      contact: "primary_contact",
      stage: "list stage",
      outcome: "Pass Reason",
      notes: "comments",
      last_interaction: "last interaction date",
      location: "City",
      domain: "Domain",
    });
  });
  it("leaves fields unmapped when nothing fits", () => {
    expect(detectMapping(["Foo", "Bar"])).toEqual({});
  });
});

describe("stage mapping", () => {
  it.each([
    ["1 - Teaser Sent", "teaser_sent"],
    ["2 - Contacted", "teaser_sent"],
    ["3 - NDA Sent", "nda_sent"],
    ["4 - NDA Signed", "nda_signed"],
    ["5 - CIM Sent", "cim_sent"],
    ["6 - IOI Received", "ioi"],
    ["7 - Management Meeting", "mgmt_meeting"],
    ["8 - LOI", "loi"],
    ["9 - Exclusivity", "exclusivity"],
    ["10 - Closed", "closed"],
    ["5", "cim_sent"],
    ["CIM sent", "cim_sent"],
    ["nda executed", "nda_signed"],
  ])("%s -> %s", (cell, stage) => {
    expect(planStage(cell, "").stage).toBe(stage);
  });
  it("an empty stage is Teaser sent with no warning; an unknown one warns", () => {
    expect(planStage("", "")).toMatchObject({ stage: "teaser_sent", warning: null });
    expect(planStage("Waiting on board", "").warning).toMatch(/not recognised/);
  });
  it("words win over a mismatched number", () => {
    expect(forwardStage("3 - CIM Sent")).toBe("cim_sent");
  });
});

describe("pass reasons", () => {
  it("strips the Pass prefix and keeps commas in the reason", () => {
    expect(planStage("Pass", "Pass - To much exposure to change in reimbursement, prefer cash pay")).toEqual({
      stage: "declined",
      declined_from_stage: "teaser_sent",
      decline_reason: "To much exposure to change in reimbursement, prefer cash pay",
      warning: null,
    });
  });
  it("strips quotes", () => {
    expect(planStage("Pass", '"Outside of mandate"').decline_reason).toBe("Outside of mandate");
  });
  it("reads the stage hint in the outcome as where the buyer dropped out", () => {
    expect(planStage("6 - IOI Received", "Pass - CIM Sent - Valuation gap")).toMatchObject({
      stage: "declined",
      declined_from_stage: "cim_sent",
      decline_reason: "Valuation gap",
    });
  });
  it("falls back to the stage number, then Teaser sent, and to a default reason", () => {
    expect(planStage("5 - Pass", "")).toMatchObject({ stage: "declined", declined_from_stage: "cim_sent", decline_reason: "Passed (imported)" });
    expect(planStage("Declined", "")).toMatchObject({ declined_from_stage: "teaser_sent", decline_reason: "Passed (imported)" });
  });
});

describe("dates, names, places", () => {
  it("reads the common date shapes", () => {
    expect(parseDate("Sep 24, 2026")).toBe("2026-09-24");
    expect(parseDate("Sep 24 2026")).toBe("2026-09-24");
    expect(parseDate("September 3, 2026")).toBe("2026-09-03");
    expect(parseDate("9/20/2026")).toBe("2026-09-20");
    expect(parseDate("2026-08-02")).toBe("2026-08-02");
    expect(parseDate("Feb 30, 2026")).toBeNull();
    expect(parseDate("soon")).toBeNull();
  });
  it("splits names", () => {
    expect(splitName("Alex Morgan")).toEqual({ first: "Alex", last: "Morgan" });
    expect(splitName("Rivera, Sam")).toEqual({ first: "Sam", last: "Rivera" });
    expect(splitName("Jo")).toEqual({ first: "Jo", last: null });
    expect(splitName("Ann Lee; Bo Kim")).toEqual({ first: "Ann", last: "Lee" });
  });
  it("splits locations", () => {
    expect(parseLocation("Nashville, Tn")).toEqual({ city: "Nashville", state: "TN" });
    expect(parseLocation("Denver")).toEqual({ city: "Denver", state: null });
  });
});

let app: App;
let route: typeof import("../app/api/deals/[id]/import-buyers/route");
let contactsImport: typeof import("../app/api/contacts/import/route");

beforeEach(async () => {
  vi.resetModules();
  app = await freshApp();
  route = await import("../app/api/deals/[id]/import-buyers/route");
  contactsImport = await import("../app/api/contacts/import/route");
});
afterEach(cleanup);

const mappingFor = (csv: string) => detectMapping(parseCsvWithHeader(csv).headers);
const run = (dealId: number, csv: string, extra: Record<string, unknown> = {}) =>
  route.POST(jsonReq(`/api/deals/${dealId}/import-buyers`, "POST", { csv, mapping: mappingFor(csv), ...extra }), params(dealId));

type BuyerRow = Record<string, string | number | null>;
const buyerByName = (dealId: number, name: string) =>
  app.db
    .prepare("SELECT b.* FROM deal_buyers b JOIN companies c ON c.id = b.buyer_company_id WHERE b.deal_id = ? AND c.name = ?")
    .get(dealId, name) as BuyerRow | undefined;

describe("import route", () => {
  it("401 when signed out", async () => {
    harness.token = undefined;
    expect((await run(1, FIXTURE)).status).toBe(401);
  });

  it("dry run returns the per-row result and writes nothing", async () => {
    await app.signIn();
    const dealId = app.deal(app.company("Seller Co"));
    const before = (app.db.prepare("SELECT COUNT(*) n FROM companies").get() as { n: number }).n;
    const res = await run(dealId, FIXTURE, { dry_run: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dry_run).toBe(true);
    expect(body.created).toBe(9);
    expect((app.db.prepare("SELECT COUNT(*) n FROM companies").get() as { n: number }).n).toBe(before);
    expect(app.db.prepare("SELECT COUNT(*) n FROM deal_buyers").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM audit_log").get()).toEqual({ n: 0 });
  });

  it("imports the fixture: stages, pass reasons, milestones, notes, contacts, locations", async () => {
    const userId = await app.signIn();
    const dealId = app.deal(app.company("Seller Co"));
    const res = await run(dealId, FIXTURE);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ created: 9, updated: 0, skipped: 1, companies_created: 9 });

    const harbor = buyerByName(dealId, "Harbor Ridge Partners")!;
    expect(harbor.stage).toBe("nda_sent");
    expect(harbor.teaser_sent_at).toBe("2026-09-24 12:00:00");
    expect(harbor.nda_sent_at).toBe("2026-09-24 12:00:00");
    expect(harbor.nda_signed_at).toBeNull();

    const pine = buyerByName(dealId, "Pinecrest Capital")!;
    expect(pine.stage).toBe("cim_sent");
    expect(pine.cim_sent_at).toBe("2026-09-20 12:00:00");

    const north = buyerByName(dealId, "Northgate Holdings")!;
    expect(north).toMatchObject({ stage: "declined", declined_from_stage: "teaser_sent", decline_reason: "To much exposure to change in reimbursement, prefer cash pay" });
    expect(north.declined_at).toBe("2026-09-10 12:00:00");
    expect(buyerByName(dealId, "Summit Lane Group")!.decline_reason).toBe("Outside of mandate");
    expect(buyerByName(dealId, "Bluewater Equity")).toMatchObject({ stage: "declined", declined_from_stage: "cim_sent", decline_reason: "Valuation gap" });
    expect(buyerByName(dealId, "Oakmont Strategic")).toMatchObject({ stage: "declined", decline_reason: "Passed (imported)", lead_contact_id: null });

    // Future Last Interaction is never used: stamps fall back to now.
    const future = buyerByName(dealId, "Future Date Co")!;
    expect(future.stage).toBe("nda_signed");
    expect(String(future.nda_signed_at) < "2099").toBe(true);
    expect(body.rows.find((r: { company: string }) => r.company === "Future Date Co").messages.join(" ")).toMatch(/future/);
    expect(body.rows.find((r: { company: string }) => r.company === "Mystery Stage LLC").messages.join(" ")).toMatch(/not recognised/);

    // One history row for the add and one for the move, never more.
    const hist = app.db.prepare("SELECT from_stage, to_stage FROM deal_buyer_stage_history WHERE deal_buyer_id = ? ORDER BY id").all(north.id);
    expect(hist).toEqual([
      { from_stage: null, to_stage: "teaser_sent" },
      { from_stage: "teaser_sent", to_stage: "declined" },
    ]);

    // Contacts: split, attached to the company, no email invented.
    const sam = app.db.prepare("SELECT * FROM contacts WHERE first_name = 'Sam' AND last_name = 'Rivera'").get() as BuyerRow;
    expect(sam.email).toBeNull();
    expect(sam.company_id).toBe(pine.buyer_company_id);
    expect(sam.source).toBe("4degrees-import");
    expect(pine.lead_contact_id).toBe(sam.id);

    // Company: domain normalised, location split, source marked.
    const pineCo = app.db.prepare("SELECT * FROM companies WHERE id = ?").get(pine.buyer_company_id) as BuyerRow;
    expect(pineCo).toMatchObject({ domain: "pinecrest.example", city: "Austin", state: "TX", source: "4degrees-import" });
    expect(app.db.prepare("SELECT city, state FROM companies WHERE name = 'Harbor Ridge Partners'").get()).toEqual({ city: "Nashville", state: "TN" });

    // Notes: multiline, commas and quotes intact, prefixed and dated.
    const note = app.db.prepare("SELECT * FROM activities WHERE deal_id = ? AND body LIKE 'Pinecrest%'").get(dealId) as BuyerRow;
    expect(note.kind).toBe("note");
    expect(note.body).toBe('Pinecrest Capital: Call went well.\nWants Q3 numbers, "adjusted" EBITDA');
    expect(note.created_at).toBe("2026-09-20 12:00:00");
    expect(note.user_id).toBe(userId);
    expect(body.notes_added).toBe(3);

    const audits = app.db.prepare("SELECT action, detail_json FROM audit_log WHERE action = 'deal.import_4degrees'").all() as { detail_json: string }[];
    expect(audits.length).toBe(1);
    expect(JSON.parse(audits[0].detail_json)).toMatchObject({ created: 9, skipped: 1 });
  });

  it("re-importing the same file skips every row and adds nothing", async () => {
    await app.signIn();
    const dealId = app.deal(app.company("Seller Co"));
    await run(dealId, FIXTURE);
    const counts = () =>
      app.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM companies) c, (SELECT COUNT(*) FROM contacts) p, (SELECT COUNT(*) FROM deal_buyers) b, (SELECT COUNT(*) FROM activities) a, (SELECT COUNT(*) FROM deal_buyer_stage_history) h"
        )
        .get();
    const before = counts();
    const body = await (await run(dealId, FIXTURE)).json();
    expect(body).toMatchObject({ created: 0, updated: 0, skipped: 10, companies_created: 0, contacts_created: 0, notes_added: 0 });
    expect(body.rows[0].messages).toContain("Already on the buyer log, skipped");
    expect(counts()).toEqual(before);
  });

  it("matches existing companies by domain first, then exact name ignoring case", async () => {
    await app.signIn();
    const dealId = app.deal(app.company("Seller Co"));
    const byDomain = app.company("Pinecrest Cap LLC", { domain: "pinecrest.example", city: "Houston" });
    const byName = app.company("harbor ridge partners");
    const res = await (await run(dealId, FIXTURE)).json();
    expect(res.companies_created).toBe(7);
    const pine = app.db.prepare("SELECT buyer_company_id FROM deal_buyers WHERE deal_id = ? AND buyer_company_id = ?").get(dealId, byDomain);
    expect(pine).toBeTruthy();
    // Existing city is never overwritten; the matched name gets the file's website.
    expect(app.db.prepare("SELECT city, state FROM companies WHERE id = ?").get(byDomain)).toEqual({ city: "Houston", state: "TX" });
    expect(app.db.prepare("SELECT domain FROM companies WHERE id = ?").get(byName)).toEqual({ domain: "harborridge.example" });
    expect(app.db.prepare("SELECT COUNT(*) n FROM companies WHERE name LIKE 'harbor ridge%' COLLATE NOCASE").get()).toEqual({ n: 1 });
  });

  it("reuses an existing contact at the company instead of creating a second", async () => {
    await app.signIn();
    const dealId = app.deal(app.company("Seller Co"));
    const co = app.company("Harbor Ridge Partners");
    const alex = app.contact({ first_name: "alex", last_name: "morgan", company_id: co });
    await run(dealId, FIXTURE);
    expect(app.db.prepare("SELECT COUNT(*) n FROM contacts WHERE first_name = 'Alex' COLLATE NOCASE").get()).toEqual({ n: 1 });
    expect(buyerByName(dealId, "Harbor Ridge Partners")!.lead_contact_id).toBe(alex);
  });

  it("restores a buyer removed earlier and counts it as updated; skips duplicates and the seller", async () => {
    const userId = await app.signIn();
    const seller = app.company("Seller Co");
    const dealId = app.deal(seller);
    const summit = app.company("Summit Lane Group");
    const { addBuyers, removeBuyer } = await import("../app/lib/buyers");
    const added = addBuyers(dealId, [{ buyer_company_id: summit }], userId);
    removeBuyer(added.created[0], userId);
    const csv = "Company,Stage\nSummit Lane Group,5 - CIM Sent\nSeller Co,3 - NDA Sent\nNew Buyer,1\nnew buyer,2\n";
    const body = await (await run(dealId, csv)).json();
    expect(body).toMatchObject({ created: 1, updated: 1, skipped: 2 });
    expect(buyerByName(dealId, "Summit Lane Group")).toMatchObject({ stage: "cim_sent", removed_at: null });
    expect(body.rows[1].messages.join(" ")).toMatch(/being sold/);
    expect(body.rows[3].messages.join(" ")).toMatch(/Same company as row 3/);
  });

  it("the whole import is one transaction: a failure leaves nothing behind", async () => {
    await app.signIn();
    const dealId = app.deal(app.company("Seller Co"));
    app.db.exec("CREATE TRIGGER boom BEFORE INSERT ON activities WHEN NEW.body LIKE 'Pinecrest%' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    await expect(run(dealId, FIXTURE)).rejects.toThrow(/boom/);
    expect(app.db.prepare("SELECT COUNT(*) n FROM deal_buyers").get()).toEqual({ n: 0 });
    expect(app.db.prepare("SELECT COUNT(*) n FROM companies WHERE source = '4degrees-import'").get()).toEqual({ n: 0 });
  });

  it("rejects a mapping without a company column or naming a missing column", async () => {
    await app.signIn();
    const dealId = app.deal(app.company("Seller Co"));
    const noCompany = await route.POST(jsonReq(`/api/deals/${dealId}/import-buyers`, "POST", { csv: FIXTURE, mapping: { stage: "Stage" } }), params(dealId));
    expect(noCompany.status).toBe(400);
    const missing = await route.POST(jsonReq(`/api/deals/${dealId}/import-buyers`, "POST", { csv: FIXTURE, mapping: { company: "Nope" } }), params(dealId));
    expect((await missing.json()).error).toMatch(/not in the file/);
    expect((await run(99999, FIXTURE)).status).toBe(404);
  });

  it("the demo sample file imports cleanly", async () => {
    await app.signIn();
    const dealId = app.deal(app.company("Seller Co"));
    const body = await (await run(dealId, SAMPLE)).json();
    expect(body).toMatchObject({ created: 8, skipped: 0 });
    expect(SAMPLE).not.toMatch(/—/);
  });
});

// ---- contacts: Outlook and Google exports ----

const OUTLOOK_HEADERS = [
  "First Name", "Middle Name", "Last Name", "Title", "Suffix", "Nickname", "Given Yomi", "Surname Yomi",
  "E-mail Address", "E-mail 2 Address", "E-mail 3 Address", "Home Phone", "Home Phone 2", "Business Phone",
  "Business Phone 2", "Mobile Phone", "Car Phone", "Other Phone", "Primary Phone", "Pager", "Business Fax",
  "Home Fax", "Other Fax", "Company Main Telephone", "Callback", "Radio Phone", "Telex", "TTY/TDD Phone", "IMAddress",
  "Job Title", "Department", "Company", "Office Location", "Manager's Name", "Assistant's Name",
  "Assistant's Phone", "Company Yomi", "Business Street", "Business City", "Business State", "Web Page", "Notes",
];
const GOOGLE_OLD = ["Name", "Given Name", "Additional Name", "Family Name", "E-mail 1 - Type", "E-mail 1 - Value", "Phone 1 - Type", "Phone 1 - Value", "Phone 2 - Type", "Phone 2 - Value", "Organization 1 - Type", "Organization 1 - Name", "Organization 1 - Title"];
const GOOGLE_NEW = ["First Name", "Middle Name", "Last Name", "Organization Name", "Organization Title", "E-mail 1 - Label", "E-mail 1 - Value", "Phone 1 - Label", "Phone 1 - Value"];

describe("contacts CSV: Outlook and Google headers", () => {
  it("detects and maps an Outlook export, preferring Job Title over the honorific", () => {
    expect(detectContactSource(OUTLOOK_HEADERS)).toBe("outlook");
    expect(guessContactMapping(OUTLOOK_HEADERS)).toEqual({
      first_name: "First Name",
      last_name: "Last Name",
      title: "Job Title",
      email: "E-mail Address",
      phone: "Business Phone",
      mobile_phone: "Mobile Phone",
      company_name: "Company",
    });
  });
  it("detects and maps both Google Contacts formats", () => {
    expect(detectContactSource(GOOGLE_OLD)).toBe("google");
    expect(guessContactMapping(GOOGLE_OLD)).toEqual({
      first_name: "Given Name",
      last_name: "Family Name",
      title: "Organization 1 - Title",
      email: "E-mail 1 - Value",
      phone: "Phone 1 - Value",
      mobile_phone: "Phone 2 - Value",
      company_name: "Organization 1 - Name",
    });
    expect(detectContactSource(GOOGLE_NEW)).toBe("google");
    expect(guessContactMapping(GOOGLE_NEW)).toMatchObject({
      first_name: "First Name",
      last_name: "Last Name",
      title: "Organization Title",
      email: "E-mail 1 - Value",
      phone: "Phone 1 - Value",
      company_name: "Organization Name",
    });
  });
  it("a plain list is not mistaken for either", () => {
    expect(detectContactSource(["first name", "last name", "email", "company"])).toBeNull();
  });

  it("imports Outlook rows: finds or creates the company by name, sets the phone, mobile as fallback", async () => {
    await app.signIn();
    const existing = app.company("Lakeshore Strategic");
    const row = (o: Record<string, string>) => Object.fromEntries(OUTLOOK_HEADERS.map((h) => [h, o[h] ?? ""]));
    const rows = [
      row({ "First Name": "Riley", "Last Name": "Chen", "E-mail Address": "riley@lakeshore.example", Company: "lakeshore strategic", "Job Title": "Partner", "Business Phone": "(312) 555-0101", "Mobile Phone": "(312) 555-0199", Title: "Mr." }),
      row({ "First Name": "Morgan", "Last Name": "Ellis", Company: "Ironwood Family Office", "Mobile Phone": "214-555-0142" }),
    ];
    const res = await contactsImport.POST(jsonReq("/api/contacts/import", "POST", { rows, mapping: guessContactMapping(OUTLOOK_HEADERS) }));
    expect(await res.json()).toMatchObject({ created: 2, skipped_invalid: 0 });
    const riley = app.db.prepare("SELECT * FROM contacts WHERE email = 'riley@lakeshore.example'").get() as BuyerRow;
    expect(riley).toMatchObject({ company_id: existing, title: "Partner", phone: "(312) 555-0101" });
    const morgan = app.db.prepare("SELECT c.phone, co.name FROM contacts c JOIN companies co ON co.id = c.company_id WHERE c.first_name = 'Morgan'").get();
    expect(morgan).toEqual({ phone: "214-555-0142", name: "Ironwood Family Office" });
    expect(app.db.prepare("SELECT COUNT(*) n FROM companies WHERE name = 'Lakeshore Strategic' COLLATE NOCASE").get()).toEqual({ n: 1 });
  });
});
