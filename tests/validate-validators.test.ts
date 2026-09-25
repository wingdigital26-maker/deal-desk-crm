import { describe, it, expect } from "vitest";
import {
  ValidationError,
  boundedString,
  name,
  title,
  notes,
  url,
  integerRange,
  employees,
  isoDate,
  enumFromList,
  validationErrorResponse,
} from "../app/lib/validate";

describe("boundedString", () => {
  it("trims and accepts a valid string", () => {
    expect(boundedString("field", "  hello  ", 10)).toBe("hello");
  });
  it("returns null for empty/undefined/null when not required", () => {
    expect(boundedString("field", "", 10)).toBeNull();
    expect(boundedString("field", undefined, 10)).toBeNull();
    expect(boundedString("field", null, 10)).toBeNull();
  });
  it("throws when required and empty", () => {
    expect(() => boundedString("field", "", 10, { required: true })).toThrow(ValidationError);
  });
  it("throws when over the max length", () => {
    expect(() => boundedString("field", "x".repeat(11), 10)).toThrow(ValidationError);
  });
  it("throws when given a non-string", () => {
    expect(() => boundedString("field", 42, 10)).toThrow(ValidationError);
  });
  it("names the bad field in the error", () => {
    try {
      boundedString("company_name", "x".repeat(300), 10);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as InstanceType<typeof ValidationError>).field).toBe("company_name");
    }
  });
});

describe("name / title / notes bound lengths correctly", () => {
  it("name allows up to 200 chars", () => {
    expect(name("name", "x".repeat(200))).toHaveLength(200);
    expect(() => name("name", "x".repeat(201))).toThrow(ValidationError);
  });
  it("title allows up to 200 chars", () => {
    expect(title("title", "x".repeat(200))).toHaveLength(200);
    expect(() => title("title", "x".repeat(201))).toThrow(ValidationError);
  });
  it("notes allows up to 5000 chars", () => {
    expect(notes("notes", "x".repeat(5000))).toHaveLength(5000);
    expect(() => notes("notes", "x".repeat(5001))).toThrow(ValidationError);
  });
});

describe("url", () => {
  it("accepts a well-formed URL", () => {
    expect(url("url", "https://example.com/path")).toBe("https://example.com/path");
  });
  it("rejects a malformed URL", () => {
    expect(() => url("url", "not a url")).toThrow(ValidationError);
  });
  it("rejects a URL longer than 500 chars", () => {
    const long = "https://example.com/" + "a".repeat(500);
    expect(() => url("url", long)).toThrow(ValidationError);
  });
  it("allows null when not required", () => {
    expect(url("url", null)).toBeNull();
  });
});

describe("integerRange / employees", () => {
  it("accepts an in-range integer", () => {
    expect(integerRange("n", 5, 0, 10)).toBe(5);
  });
  it("accepts a numeric string", () => {
    expect(integerRange("n", "5", 0, 10)).toBe(5);
  });
  it("rejects a non-numeric value instead of coercing to null", () => {
    expect(() => integerRange("n", "not-a-number", 0, 10)).toThrow(ValidationError);
  });
  it("rejects a non-integer number", () => {
    expect(() => integerRange("n", 5.5, 0, 10)).toThrow(ValidationError);
  });
  it("rejects out-of-range values", () => {
    expect(() => integerRange("n", -1, 0, 10)).toThrow(ValidationError);
    expect(() => integerRange("n", 11, 0, 10)).toThrow(ValidationError);
  });
  it("employees rejects a value over 5,000,000", () => {
    expect(() => employees("employees", 5_000_001)).toThrow(ValidationError);
    expect(employees("employees", 5_000_000)).toBe(5_000_000);
    expect(employees("employees", 0)).toBe(0);
  });
  it("returns null for empty input when not required", () => {
    expect(integerRange("n", "", 0, 10)).toBeNull();
    expect(integerRange("n", undefined, 0, 10)).toBeNull();
  });
});

describe("isoDate", () => {
  it("accepts a valid YYYY-MM-DD date", () => {
    expect(isoDate("due", "2026-09-20")).toBe("2026-09-20");
  });
  it("rejects a malformed date string", () => {
    expect(() => isoDate("due", "09/20/2026")).toThrow(ValidationError);
    expect(() => isoDate("due", "2026-9-20")).toThrow(ValidationError);
  });
  it("rejects a non-existent calendar date", () => {
    expect(() => isoDate("due", "2026-02-30")).toThrow(ValidationError);
  });
  it("returns null for empty input when not required", () => {
    expect(isoDate("due", "")).toBeNull();
  });
});

describe("enumFromList", () => {
  const stages = ["Sourced", "Contacted", "Closed"] as const;
  it("accepts a value in the list", () => {
    expect(enumFromList("stage", "Contacted", stages)).toBe("Contacted");
  });
  it("rejects a value not in the list", () => {
    expect(() => enumFromList("stage", "Bogus", stages)).toThrow(ValidationError);
  });
  it("falls back when empty and a fallback is given", () => {
    expect(enumFromList("stage", undefined, stages, { fallback: "Sourced" })).toBe("Sourced");
  });
  it("throws when required with no fallback and empty", () => {
    expect(() => enumFromList("stage", undefined, stages, { required: true })).toThrow(ValidationError);
  });
});

describe("validationErrorResponse", () => {
  it("converts a ValidationError into a 400 Response", async () => {
    const err = new ValidationError("employees", "employees must be between 0 and 5000000");
    const res = validationErrorResponse(err);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.field).toBe("employees");
  });
  it("returns null for a non-ValidationError", () => {
    expect(validationErrorResponse(new Error("boom"))).toBeNull();
  });
});
