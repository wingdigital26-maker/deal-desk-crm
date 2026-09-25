// scrapers/profile_enrich.py, exercised through its no-network subcommands:
//   parse        the page parsers on fixture HTML
//   news-match   the match discipline for news headlines
//   apply-facts  the sourced upsert (never a blank, never a downgrade, idempotent)
// Nothing here touches the network: every input is a local file or stdin.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const PY = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : "python3");
const SCRIPT = path.join(process.cwd(), "scrapers", "profile_enrich.py");
const FIX = path.join(process.cwd(), "tests", "fixtures", "profile");

function py(args: string[], input?: string) {
  const r = spawnSync(PY, [SCRIPT, ...args], { input, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`python failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

type Fact = { field: string; value: string; note: string | null; observed_at: string | null };

function parse(file: string, url: string, company = "Acme Precision"): { facts: Fact[]; links: string[] } {
  return py(["parse", "--html", path.join(FIX, file), "--url", url, "--company", company, "--city", "Haltom City", "--state", "TX"]);
}
const val = (facts: Fact[], field: string) => facts.filter((f) => f.field === field).map((f) => f.value);

describe("page parsers (fixture HTML, no network)", () => {
  it("homepage: summary, schema.org Organization, certifications, company LinkedIn, nav links", () => {
    const { facts, links } = parse("home.html", "https://acmeprecision.com/");
    expect(val(facts, "summary")[0]).toMatch(/^Acme Precision is a family-owned CNC machining/);
    expect(val(facts, "legal_name_site")).toEqual(["Acme Precision Machining, Inc."]);
    expect(val(facts, "founded_year")).toEqual(["1979"]);
    expect(val(facts, "hq_address")).toEqual(["100 Industrial Pkwy, Haltom City, TX 76117"]);
    expect(val(facts, "employee_estimate")).toEqual(["85"]);
    expect(val(facts, "certifications")).toEqual(["ISO 9001", "AS9100", "ITAR registered"]);
    expect(val(facts, "company_linkedin")).toEqual(["https://www.linkedin.com/company/acme-precision"]);
    // on-site About/Leadership/Careers/News pages only: no off-site partner link, no PDF
    expect(links).toContain("https://acmeprecision.com/about-us/");
    expect(links).toContain("https://acmeprecision.com/leadership");
    expect(links.some((l) => l.includes("other.com") || l.endsWith(".pdf"))).toBe(false);
    expect(links[0]).toBe("https://acmeprecision.com/about-us/"); // About ranks first
    // the site name equals the company name, so no DBA is invented
    expect(val(facts, "dba")).toEqual([]);
  });

  it("about page: owner, title, bio, other roles, LinkedIn, family since, next generation, markets, locations", () => {
    const { facts } = parse("about.html", "https://acmeprecision.com/about-us/");
    expect(val(facts, "owner_name")).toEqual(["Walter Brandt"]);
    expect(val(facts, "owner_title")[0]).toMatch(/President/);
    expect(val(facts, "owner_title")[0]).toMatch(/founder/);
    expect(val(facts, "owner_bio")[0]).toMatch(/^Walter Brandt is the founder and President/);
    expect(val(facts, "owner_linkedin")).toEqual(["https://www.linkedin.com/in/walter-brandt-12345"]);
    expect(val(facts, "owner_other_roles").join(" ")).toMatch(/board of directors of the Fort Worth Metalworking Association/);
    expect(val(facts, "family_owned_since")).toEqual(["1979"]);
    expect(val(facts, "second_generation")).toHaveLength(1);
    expect(val(facts, "end_markets")).toEqual(expect.arrayContaining(["Aerospace", "Defense", "Oil and gas", "Medical"]));
    expect(val(facts, "locations")).toEqual(expect.arrayContaining(["Haltom City, TX", "Tulsa, OK"]));
    expect(val(facts, "leaders")).toEqual(expect.arrayContaining(["Karen Brandt | CFO"]));
  });

  it("a relative's start date is never read as the owner's (full-name match)", () => {
    const { facts } = parse("about.html", "https://acmeprecision.com/about-us/");
    // "Karen Brandt joined the company in 2012" must not become Walter Brandt's "since 2012"
    expect(val(facts, "owner_since")).not.toContain("2012");
  });

  it("prose never becomes a person", () => {
    const { facts } = parse("about.html", "https://acmeprecision.com/about-us/");
    expect(val(facts, "leaders").join(" ")).not.toMatch(/His daughter/);
  });

  it("news page: headlines classified with dates; buying equipment is expansion, not a sale", () => {
    const { facts } = parse("news.html", "https://acmeprecision.com/news");
    expect(facts.find((f) => f.field === "signal_expansion")).toMatchObject({ value: "Acme Precision Acquires New Five Axis Machining Center", observed_at: "2026-03-04" });
    expect(facts.find((f) => f.field === "signal_award")?.observed_at).toBe("2025-01-12");
    expect(facts.find((f) => f.field === "signal_facility")?.value).toMatch(/relocates headquarters/);
    expect(val(facts, "signal_ownership")).toEqual([]);
  });

  it("a vice president is a leader but never the principal; a flattened menu is never the summary", () => {
    const { facts } = parse("team.html", "https://cedarridgemfg.example.com/about-us/", "Cedar Ridge Manufacturing");
    expect(val(facts, "leaders")).toEqual(["Riley Ashford | Vice President of Sales and Marketing", "Chris Mallory | Vice President of Operations"]);
    expect(val(facts, "owner_name")).toEqual([]);
    expect(val(facts, "summary")).toEqual([]);
    expect(val(facts, "company_linkedin")).toEqual(["https://www.linkedin.com/company/cedar-ridge-manufacturing"]);
  });

  it("PE ownership language is caught", () => {
    const { facts } = parse("pe.html", "https://widgetworks.com/", "Widget Works");
    expect(val(facts, "ownership_type")).toEqual(["pe-backed"]);
  });

  it("careers page with a plant manager opening is a hiring signal", () => {
    const { facts } = parse("careers.html", "https://acmeprecision.com/careers");
    expect(val(facts, "signal_hiring")[0]).toMatch(/Plant Manager/);
  });
});

describe("news match discipline (the 46 false SEC attributions lesson)", () => {
  const company = { name: "Bluebonnet Manufacturing", domain: "bluebonnetmfg.example.com", city: "McAllen", state: "TX" };
  const run = (items: object[]) => py(["news-match"], JSON.stringify(items));

  it("drops a headline that does not name the company", () => {
    const [r] = run([{ company, title: "Initech announces expansion in Indiana", url: "https://x.com/a" }]);
    expect(r.match).toBeNull();
  });

  it("confirms only with the city, the state, or the company's own domain", () => {
    const out = run([
      { company, title: "Bluebonnet Manufacturing to expand Mission operations, McAllen plant adds jobs", url: "https://news.example/a" },
      { company, title: "Bluebonnet Manufacturing adds 50 jobs in Texas", url: "https://news.example/b" },
      { company, title: "Bluebonnet Manufacturing adds a press line", url: "https://bluebonnetmfg.example.com/news/press" },
      { company, title: "Bluebonnet Manufacturing adds a press line", url: "https://news.example/c" },
    ]);
    expect(out.map((r: { match: string }) => r.match)).toEqual(["confirmed", "confirmed", "confirmed", "unconfirmed"]);
  });

  it("reads a sale only when the company is the one being bought", () => {
    const aspen = { name: "Cedar Ridge Manufacturing", domain: "cedarridgemfg.example.com", city: "Humble", state: "TX" };
    const out = run([
      { company: aspen, title: "Globex Industrials completes acquisition of Cedar Ridge Manufacturing for $313.5M", url: "https://x.com/1" },
      { company: aspen, title: "Cedar Ridge Manufacturing acquires rival coil maker", url: "https://x.com/2" },
      { company: aspen, title: "Harlow Manufacturing Company Acquired By Private Equity Firm", url: "https://x.com/3" },
      { company: { ...aspen, name: "Harlow Manufacturing" }, title: "Harlow Manufacturing Company Acquired By Private Equity Firm", url: "https://x.com/3" },
    ]);
    expect(out[0]).toMatchObject({ match: "unconfirmed", ownership: "sold", kind: "signal_ownership" });
    expect(out[1]).toMatchObject({ ownership: null, kind: "signal_expansion" });
    expect(out[2].match).toBeNull();
    expect(out[3]).toMatchObject({ match: "unconfirmed", ownership: "pe-backed" });
  });
});

describe("apply-facts: sourced upsert", () => {
  let dir: string;
  let dbFile: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "profile-facts-"));
    dbFile = path.join(dir, "t.db");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const apply = (facts: object[]) => py(["apply-facts", "--db", dbFile], JSON.stringify(facts));
  const read = (field: string) => {
    const d = new DatabaseSync(dbFile);
    const rows = d.prepare("SELECT value, confidence, source_url FROM profile_facts WHERE entity_id = 1 AND field = ?").all(field);
    d.close();
    return rows as { value: string; confidence: string; source_url: string }[];
  };
  const base = { entity: "company", entity_id: 1, source_url: "https://acme.com/about", confidence: "confirmed" };

  it("writes a sourced value and refuses one without a source", () => {
    expect(apply([{ ...base, field: "founded_year", value: "1979" }])).toEqual(["insert"]);
    expect(apply([{ ...base, field: "summary", value: "x", source_url: "" }])).toEqual(["skip:no-source"]);
    expect(apply([{ ...base, field: "summary", value: "x", source_url: "not a url" }])).toEqual(["skip:no-source"]);
    expect(read("summary")).toEqual([]);
  });

  it("never overwrites a sourced value with a blank", () => {
    expect(apply([{ ...base, field: "founded_year", value: "" }])).toEqual(["skip:blank"]);
    expect(apply([{ ...base, field: "founded_year", value: "   " }])).toEqual(["skip:blank"]);
    expect(apply([{ ...base, field: "founded_year", value: null }])).toEqual(["skip:blank"]);
    expect(read("founded_year")).toEqual([{ value: "1979", confidence: "confirmed", source_url: "https://acme.com/about" }]);
  });

  it("never lets an unconfirmed value replace a confirmed one", () => {
    expect(apply([{ ...base, field: "founded_year", value: "1981", confidence: "unconfirmed", source_url: "https://news.example/x" }])).toEqual([
      "skip:lower-confidence",
    ]);
    expect(read("founded_year")[0].value).toBe("1979");
  });

  it("is idempotent, and list fields keep one row per value", () => {
    expect(apply([{ ...base, field: "founded_year", value: "1979" }])).toEqual(["same"]);
    expect(apply([{ ...base, field: "certifications", value: "ISO 9001" }, { ...base, field: "certifications", value: "AS9100" }])).toEqual(["insert", "insert"]);
    expect(apply([{ ...base, field: "certifications", value: "ISO 9001" }])).toEqual(["same"]);
    expect(read("certifications").map((r) => r.value).sort()).toEqual(["AS9100", "ISO 9001"]);
  });

  it("a confirmed value from a better source does replace an unconfirmed one", () => {
    apply([{ ...base, field: "legal_name", value: "ACME PRECISION LLC", confidence: "unconfirmed" }]);
    expect(apply([{ ...base, field: "legal_name", value: "ACME PRECISION MACHINING, INC." }])).toEqual(["update"]);
    expect(read("legal_name")).toEqual([{ value: "ACME PRECISION MACHINING, INC.", confidence: "confirmed", source_url: "https://acme.com/about" }]);
  });
});
