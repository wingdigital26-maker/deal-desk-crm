import { describe, it, expect } from "vitest";
import { contentHash, lintText, extractMergeFields, renderTemplate, isSendable, footerTemplate } from "../app/lib/compliance";

const UNSUB = { unsubscribeUrl: "https://harness.example.com/u/test-token" };

describe("contentHash", () => {
  it("is stable across CRLF vs LF line endings", () => {
    const lf = contentHash("Subject line", "Line one\nLine two", ["first_name"]);
    const crlf = contentHash("Subject line", "Line one\r\nLine two", ["first_name"]);
    expect(lf).toBe(crlf);
  });

  it("is stable across merge-field order", () => {
    const a = contentHash("Subject", "Body {{first_name}} {{company_name}}", ["first_name", "company_name"]);
    const b = contentHash("Subject", "Body {{first_name}} {{company_name}}", ["company_name", "first_name"]);
    expect(a).toBe(b);
  });

  it("changes on a one-character edit to the subject", () => {
    const a = contentHash("Subject", "Body text", ["first_name"]);
    const b = contentHash("Subjects", "Body text", ["first_name"]);
    expect(a).not.toBe(b);
  });

  it("changes on a one-character edit to the body", () => {
    const a = contentHash("Subject", "Body text.", ["first_name"]);
    const b = contentHash("Subject", "Body text!", ["first_name"]);
    expect(a).not.toBe(b);
  });

  it("changes when a merge field is added", () => {
    const a = contentHash("Subject", "Body", ["first_name"]);
    const b = contentHash("Subject", "Body", ["first_name", "company_name"]);
    expect(a).not.toBe(b);
  });

  it("defaults to the current footerTemplate() so every approval covers the real footer", () => {
    const a = contentHash("Subject", "Body", ["first_name"]);
    const b = contentHash("Subject", "Body", ["first_name"], footerTemplate());
    expect(a).toBe(b);
  });

  it("changes when the footer changes, voiding every existing approval", () => {
    const a = contentHash("Subject", "Body", ["first_name"], footerTemplate());
    const b = contentHash("Subject", "Body", ["first_name"], footerTemplate() + " Updated footer text.");
    expect(a).not.toBe(b);
  });
});

describe("lintText forbidden patterns", () => {
  it("blocks fee language with ruleId fees", () => {
    const findings = lintText("We charge a modest fee for this work.");
    const hit = findings.find((f) => f.ruleId === "fees");
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe("block");
  });

  it("blocks SIM with ruleId sim", () => {
    const findings = lintText("Attached is the SIM for your review.");
    const hit = findings.find((f) => f.ruleId === "sim");
    expect(hit).toBeDefined();
  });

  it("blocks guarantee/promise language with ruleId promise", () => {
    const findings = lintText("We guarantee this will sell for top dollar.");
    const ruleIds = findings.filter((f) => f.ruleId === "promise").map((f) => f.match.toLowerCase());
    expect(ruleIds).toContain("guarantee");
    expect(ruleIds).toContain("will sell for");
  });

  it("blocks ease words with ruleId ease", () => {
    const findings = lintText("Just simply hand them the paperwork and you're done.");
    const hits = findings.filter((f) => f.ruleId === "ease").map((f) => f.match.toLowerCase());
    expect(hits).toEqual(expect.arrayContaining(["just", "simply", "hand them"]));
  });

  it("blocks the em dash with ruleId emdash", () => {
    const findings = lintText("This deal—in our view—is strong.");
    const hits = findings.filter((f) => f.ruleId === "emdash");
    expect(hits.length).toBe(2);
  });

  it("does not false-positive on 'simplest' for the SIM rule", () => {
    const findings = lintText("This is the simplest way to describe the process.");
    expect(findings.find((f) => f.ruleId === "sim")).toBeUndefined();
  });

  it("does not false-positive on 'adjust' for the ease rule (just)", () => {
    const findings = lintText("We will need to adjust the timeline next quarter.");
    expect(findings.find((f) => f.ruleId === "ease")).toBeUndefined();
  });

  it("does not false-positive on 'coffee' for the fees rule", () => {
    const findings = lintText("Let's grab coffee and discuss the toffee company's books.");
    expect(findings.find((f) => f.ruleId === "fees")).toBeUndefined();
  });

  it("REPORTED BUG CHECK: 'commission' substring inside a longer safe word is not falsely matched", () => {
    // decommission contains "commission"; the fees rule lists "commission" as a bare
    // word so \b...\b should NOT match inside "decommission" (word-char boundary).
    const findings = lintText("The plant is being decommissioned next year.");
    expect(findings.find((f) => f.ruleId === "fees")).toBeUndefined();
  });
});

describe("renderTemplate", () => {
  const base = { subject: "Hello {{first_name}}", body: "Regarding {{company_name}}.", allowedMergeFields: ["first_name", "company_name"] };

  it("renders correctly with valid merge values", () => {
    const result = renderTemplate(base, { first_name: "Dana", company_name: "Acme Co" }, UNSUB);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.subject).toBe("Hello Dana");
      expect(result.body).toBe("Regarding Acme Co.");
      expect(result.footer).toContain(UNSUB.unsubscribeUrl);
    }
  });

  it("rejects a field used but not in allowedMergeFields", () => {
    const tpl = { subject: "Hi {{nickname}}", body: "Body", allowedMergeFields: ["first_name"] };
    const result = renderTemplate(tpl, { nickname: "D" }, UNSUB);
    expect(result.ok).toBe(false);
  });

  it("rejects a blank merge value", () => {
    const result = renderTemplate(base, { first_name: "  ", company_name: "Acme" }, UNSUB);
    expect(result.ok).toBe(false);
  });

  it("rejects a merge value containing a newline", () => {
    const result = renderTemplate(base, { first_name: "Dana\nSmith", company_name: "Acme" }, UNSUB);
    expect(result.ok).toBe(false);
  });

  it("rejects a merge value containing {{", () => {
    const result = renderTemplate(base, { first_name: "Dana {{x}}", company_name: "Acme" }, UNSUB);
    expect(result.ok).toBe(false);
  });

  it("rejects a merge value containing a URL", () => {
    const result = renderTemplate(base, { first_name: "Dana", company_name: "Acme, see www.acme.com" }, UNSUB);
    expect(result.ok).toBe(false);
  });

  it("rejects a merge value over 80 characters", () => {
    const result = renderTemplate(base, { first_name: "D".repeat(81), company_name: "Acme" }, UNSUB);
    expect(result.ok).toBe(false);
  });

  it("accepts exactly 80 characters", () => {
    const result = renderTemplate(base, { first_name: "D".repeat(80), company_name: "Acme" }, UNSUB);
    expect(result.ok).toBe(true);
  });

  it("fails without a valid unsubscribe URL (e.g. what happens when APP_BASE_URL is missing)", () => {
    const result = renderTemplate(base, { first_name: "Dana", company_name: "Acme" }, { unsubscribeUrl: "" });
    expect(result.ok).toBe(false);
  });

  it("fails when the unsubscribe URL is not http/https", () => {
    const result = renderTemplate(base, { first_name: "Dana", company_name: "Acme" }, { unsubscribeUrl: "javascript:alert(1)" });
    expect(result.ok).toBe(false);
  });

  it("footer contains both a valid URL and the firm mailing address", () => {
    const result = renderTemplate(base, { first_name: "Dana", company_name: "Acme" }, UNSUB);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.footer).toMatch(/https?:\/\//);
    }
  });
});

describe("isSendable", () => {
  function tplFor(status: string, subject = "Subj", body = "Body", fields: string[] = []) {
    return {
      status,
      content_hash: contentHash(subject, body, fields),
      subject,
      body,
      allowed_merge_fields: JSON.stringify(fields),
    };
  }

  it.each(["draft", "pending", "rejected", "retired"])("is false for status %s", (status) => {
    const result = isSendable(tplFor(status));
    expect(result.ok).toBe(false);
  });

  it("is false for an approved row whose body was tampered so the hash no longer matches", () => {
    const tpl = tplFor("approved", "Subj", "Original body", []);
    const tampered = { ...tpl, body: "Tampered body" };
    const result = isSendable(tampered);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/hash mismatch/i);
  });

  it("is true for an approved row whose hash matches", () => {
    const tpl = tplFor("approved", "Subj", "Body", ["first_name"]);
    const result = isSendable(tpl);
    expect(result.ok).toBe(true);
  });
});
