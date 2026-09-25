import { describe, it, expect } from "vitest";
import { parseCsv, parseCsvWithHeader, isValidEmail } from "../app/lib/csv";

describe("parseCsv", () => {
  it("handles quoted fields containing commas", () => {
    const rows = parseCsv('a,"b,c",d\n1,2,3');
    expect(rows).toEqual([
      ["a", "b,c", "d"],
      ["1", "2", "3"],
    ]);
  });

  it("handles escaped quotes inside quoted fields", () => {
    const rows = parseCsv('name,quote\n"Dana","She said ""hi"" today"');
    expect(rows[1]).toEqual(["Dana", 'She said "hi" today']);
  });

  it("handles CRLF line endings", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n3,4");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("strips a UTF-8 BOM only if the caller already stripped it (documents current behavior)", () => {
    // parseCsv does not strip a BOM itself; the BOM char ends up glued to the first field.
    const bom = "﻿";
    const rows = parseCsv(`${bom}a,b\n1,2`);
    expect(rows[0][0]).toBe(`${bom}a`);
    expect(rows[0][0]).not.toBe("a");
  });

  it("handles a trailing newline without producing a phantom empty row", () => {
    const rows = parseCsv("a,b\n1,2\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("drops fully empty lines", () => {
    const rows = parseCsv("a,b\n\n1,2\n\n");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("handles a quoted field containing an embedded newline", () => {
    const rows = parseCsv('a,"line1\nline2"\n1,2');
    expect(rows[0]).toEqual(["a", "line1\nline2"]);
  });
});

describe("parseCsvWithHeader", () => {
  it("maps rows to header keys and trims whitespace", () => {
    const { headers, rows } = parseCsvWithHeader("First Name, Email \n Dana , dana@acme.com ");
    expect(headers).toEqual(["First Name", "Email"]);
    expect(rows).toEqual([{ "First Name": "Dana", Email: "dana@acme.com" }]);
  });

  it("returns empty headers and rows for empty input", () => {
    expect(parseCsvWithHeader("")).toEqual({ headers: [], rows: [] });
  });
});

describe("isValidEmail", () => {
  it("accepts an ordinary address", () => {
    expect(isValidEmail("dana@acme.com")).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(isValidEmail("")).toBe(false);
  });

  it("rejects a string with no @", () => {
    expect(isValidEmail("dana.acme.com")).toBe(false);
  });

  it("rejects a string with no domain dot", () => {
    expect(isValidEmail("dana@acme")).toBe(false);
  });

  it("rejects an address containing whitespace", () => {
    expect(isValidEmail("dana @acme.com")).toBe(false);
  });
});
