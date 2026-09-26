import { describe, expect, it } from "vitest";
import { inflateRawSync } from "node:zlib";
import {
  colLetter,
  csvCell,
  exportResponse,
  parseFormat,
  safeFilename,
  safeSheetName,
  toCsv,
  toXlsx,
  type Column,
} from "../app/lib/export";
import { crc32, zip } from "../app/lib/zip";

type Row = { name: string; fee: number | null; note?: string };

const columns: Column<Row>[] = [
  { key: "name", label: "Name", value: (r) => r.name },
  { key: "fee", label: "Fee (USD)", value: (r) => r.fee, numFmt: "integer" },
  { key: "note", label: "Note", value: (r) => r.note },
];

const rows: Row[] = [
  { name: "Smith & Sons", fee: 125000, note: "=SUM(A1)" },
  { name: "Comma, Quote \"x\"", fee: null, note: "line1\nline2" },
];

// Small ZIP reader for tests: walk the central directory and inflate each entry.
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const lnlen = buf.readUInt16LE(local + 26);
    const lxlen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lnlen + lxlen;
    const packed = buf.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(packed) : Buffer.from(packed);
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

describe("crc32", () => {
  it("matches the standard check vector", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("zip", () => {
  it("round-trips entries", () => {
    const z = zip([
      { name: "a.txt", data: "hello" },
      { name: "dir/b.bin", data: Buffer.from([0, 1, 2, 255]) },
    ]);
    const files = unzip(z);
    expect(files.get("a.txt")?.toString()).toBe("hello");
    expect([...(files.get("dir/b.bin") ?? [])]).toEqual([0, 1, 2, 255]);
  });
});

describe("csv", () => {
  it("guards formula injection", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("\tx")).toBe("'\tx");
    expect(csvCell("\rx")).toBe("\"'\rx\"");
    expect(csvCell("a=b")).toBe("a=b");
  });

  it("writes numbers raw, including negatives", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(1.5)).toBe("1.5");
    expect(csvCell(NaN)).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("l1\nl2")).toBe('"l1\nl2"');
    expect(csvCell("l1\r\nl2")).toBe('"l1\r\nl2"');
    expect(csvCell("=a,b")).toBe("\"'=a,b\"");
  });

  it("builds a BOM-prefixed CRLF document", () => {
    const out = toCsv(columns, rows);
    expect(out.startsWith("﻿")).toBe(true);
    const lines = out.slice(1).split("\r\n");
    expect(lines[0]).toBe("Name,Fee (USD),Note");
    expect(lines[1]).toBe("Smith & Sons,125000,'=SUM(A1)");
    expect(lines[2]).toBe('"Comma, Quote ""x""",,"line1\nline2"');
    expect(lines[3]).toBe("");
    expect(lines).toHaveLength(4);
  });
});

describe("xlsx", () => {
  const buf = toXlsx([
    { name: "Deals: Q3/Q4 [draft]", columns, rows },
    { name: "Deals: Q3/Q4 [draft]", columns, rows: [] },
  ]);
  const files = unzip(buf);

  it("is a zip with every required part", () => {
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    for (const name of [
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/workbook.xml",
      "xl/_rels/workbook.xml.rels",
      "xl/styles.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]) {
      expect(files.has(name), name).toBe(true);
    }
  });

  it("writes headers, numbers, escaped strings, frozen header and autofilter", () => {
    const xml = files.get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(xml).toContain("<t>Name</t>");
    expect(xml).toContain("<t>Fee (USD)</t>");
    expect(xml).toContain('<c r="B2" s="2"><v>125000</v></c>');
    expect(xml).toContain("<t>Smith &amp; Sons</t>");
    expect(xml).toContain("<t>=SUM(A1)</t>");
    expect(xml).toContain('t="inlineStr"');
    expect(xml).toContain('state="frozen"');
    expect(xml).toContain('<autoFilter ref="A1:C3"/>');
    expect(xml).not.toContain('r="B3"');
  });

  it("sanitises and dedupes sheet names", () => {
    const wb = files.get("xl/workbook.xml")!.toString("utf8");
    expect(wb).toContain('name="Deals  Q3 Q4  draft"');
    expect(wb).toContain('name="Deals  Q3 Q4  draft (2)"');
    expect(wb).toContain("_xlnm._FilterDatabase");
  });

  it("strips characters illegal in XML 1.0", () => {
    const b = toXlsx([{ name: "S", columns: [{ key: "a", label: "A", value: () => "a\u0001b\u0008c" }], rows: [1] }]);
    const xml = unzip(b).get("xl/worksheets/sheet1.xml")!.toString("utf8");
    expect(xml).toContain("<t>abc</t>");
  });
});

describe("helpers", () => {
  it("column letters", () => {
    expect(colLetter(0)).toBe("A");
    expect(colLetter(25)).toBe("Z");
    expect(colLetter(26)).toBe("AA");
    expect(colLetter(701)).toBe("ZZ");
    expect(colLetter(702)).toBe("AAA");
  });

  it("sheet names are at most 31 chars and never empty", () => {
    const used = new Set<string>();
    expect(safeSheetName("x".repeat(40), 0, used)).toHaveLength(31);
    expect(safeSheetName("[]:*?/\\", 1, used)).toBe("Sheet2");
  });

  it("parseFormat", () => {
    expect(parseFormat(new URL("http://x/a?format=csv"))).toBe("csv");
    expect(parseFormat(new URL("http://x/a?format=XLSX"))).toBe("xlsx");
    expect(parseFormat(new URL("http://x/a?format=pdf"))).toBeNull();
    expect(parseFormat(new URL("http://x/a"))).toBeNull();
  });

  it("safeFilename", () => {
    expect(safeFilename('../evil"; name.csv', "csv")).toBe("evil_name.csv");
    expect(safeFilename("", "xlsx")).toBe("export.xlsx");
    expect(safeFilename("deals-2026-09-25", "xlsx")).toBe("deals-2026-09-25.xlsx");
  });
});

describe("exportResponse", () => {
  it("csv headers and first sheet only", async () => {
    const res = exportResponse("csv", "deals report", [
      { name: "one", columns, rows },
      { name: "two", columns: [{ key: "z", label: "Other", value: () => "z" }], rows: [1] },
    ]);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="deals_report.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(body.startsWith("﻿Name,")).toBe(true);
    expect(body).not.toContain("Other");
  });

  it("xlsx headers and a valid zip body", async () => {
    const res = exportResponse("xlsx", "deals", [{ name: "Deals", columns, rows }]);
    expect(res.headers.get("Content-Type")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="deals.xlsx"');
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = Buffer.from(await res.arrayBuffer());
    expect(unzip(body).get("xl/worksheets/sheet1.xml")!.toString()).toContain("<t>Name</t>");
  });
});
