// CSV and XLSX export for any table of rows. No dependencies beyond node built-ins.
import { zip } from "./zip";

export type CellValue = string | number | null | undefined;

export type Column<T> = {
  key: string;
  label: string;
  value: (row: T) => CellValue;
  // Optional display format for numeric cells in XLSX. "integer" shows 12,345.
  numFmt?: "integer";
};

export type Sheet<T = unknown> = { name: string; columns: Column<T>[]; rows: T[] };

export type ExportFormat = "csv" | "xlsx";

// ---------- CSV ----------

// One RFC4180 cell. Strings that a spreadsheet would read as a formula get a
// leading apostrophe. Numbers are written raw.
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv<T>(columns: Column<T>[], rows: T[]): string {
  const lines = [columns.map((c) => csvCell(c.label)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => csvCell(c.value(r))).join(","));
  return "﻿" + lines.join("\r\n") + "\r\n";
}

// ---------- XLSX ----------

const ILLEGAL_XML = /[^\t\n\r -퟿-�\u{10000}-\u{10FFFF}]/gu;
const MAX_CELL_CHARS = 32767;

export function xmlEscape(s: string): string {
  return s
    .replace(ILLEGAL_XML, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function colLetter(index: number): string {
  let n = index + 1;
  let out = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    out = String.fromCharCode(65 + m) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function safeSheetName(name: string, index: number, used: Set<string>): string {
  let base = String(name ?? "")
    .replace(ILLEGAL_XML, "")
    .replace(/[\[\]:*?/\\]/g, " ")
    .trim()
    .replace(/^'+|'+$/g, "")
    .slice(0, 31)
    .trim();
  if (!base || base.toLowerCase() === "history") base = `Sheet${index + 1}`;
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n++})`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

// Style ids in cellXfs below.
const STYLE_HEADER = 1;
const STYLE_INTEGER = 2;

function strCell(ref: string, text: string, style?: number): string {
  const clean = text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) : text;
  const s = style ? ` s="${style}"` : "";
  const space = /^\s|\s$/.test(clean) ? ' xml:space="preserve"' : "";
  return `<c r="${ref}" t="inlineStr"${s}><is><t${space}>${xmlEscape(clean)}</t></is></c>`;
}

function sheetXml<T>(sheet: Sheet<T>): string {
  const cols = sheet.columns;
  const rows: string[] = [];
  rows.push(`<row r="1">${cols.map((c, i) => strCell(`${colLetter(i)}1`, c.label, STYLE_HEADER)).join("")}</row>`);
  sheet.rows.forEach((row, ri) => {
    const r = ri + 2;
    const cells: string[] = [];
    cols.forEach((c, ci) => {
      const v = c.value(row);
      const ref = `${colLetter(ci)}${r}`;
      if (v === null || v === undefined) return;
      if (typeof v === "number") {
        if (!Number.isFinite(v)) return;
        const s = c.numFmt === "integer" ? ` s="${STYLE_INTEGER}"` : "";
        cells.push(`<c r="${ref}"${s}><v>${v}</v></c>`);
      } else {
        cells.push(strCell(ref, String(v)));
      }
    });
    rows.push(`<row r="${r}">${cells.join("")}</row>`);
  });

  const lastRef = cols.length ? `${colLetter(cols.length - 1)}${sheet.rows.length + 1}` : "A1";
  const range = `A1:${lastRef}`;
  const widths = cols.length
    ? `<cols>${cols
        .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(10, c.label.length + 4))}" customWidth="1"/>`)
        .join("")}</cols>`
    : "";

  return (
    XML_HEAD +
    `<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<dimension ref="${range}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    widths +
    `<sheetData>${rows.join("")}</sheetData>` +
    (cols.length ? `<autoFilter ref="${range}"/>` : "") +
    `</worksheet>`
  );
}

const STYLES_XML =
  XML_HEAD +
  `<styleSheet xmlns="${NS_MAIN}">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="3">` +
  `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
  `</cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

// Accepts sheets with differing row types; each sheet's columns match its rows.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toXlsx(sheets: Sheet<any>[]): Buffer {
  const list = sheets.length ? sheets : [{ name: "Sheet1", columns: [], rows: [] }];
  const used = new Set<string>();
  const names = list.map((s, i) => safeSheetName(s.name, i, used));

  const contentTypes =
    XML_HEAD +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    list
      .map(
        (_, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
      )
      .join("") +
    `</Types>`;

  const rootRels =
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;

  const definedNames = list
    .map((s, i) => {
      if (!s.columns.length) return "";
      const quoted = `'${names[i].replace(/'/g, "''")}'`;
      const ref = `${quoted}!$A$1:$${colLetter(s.columns.length - 1)}$${s.rows.length + 1}`;
      return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">${xmlEscape(ref)}</definedName>`;
    })
    .join("");

  const workbook =
    XML_HEAD +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">` +
    `<sheets>${names.map((n, i) => `<sheet name="${xmlEscape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets>` +
    (definedNames ? `<definedNames>${definedNames}</definedNames>` : "") +
    `</workbook>`;

  const workbookRels =
    XML_HEAD +
    `<Relationships xmlns="${NS_PKG_REL}">` +
    list.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("") +
    `<Relationship Id="rId${list.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  return zip([
    { name: "[Content_Types].xml", data: contentTypes },
    { name: "_rels/.rels", data: rootRels },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: workbookRels },
    { name: "xl/styles.xml", data: STYLES_XML },
    ...list.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]);
}

// ---------- HTTP ----------

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  csv: "text/csv; charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function safeFilename(name: string, format: ExportFormat): string {
  const stem = String(name ?? "")
    .replace(/\.(csv|xlsx)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 100);
  return `${stem || "export"}.${format}`;
}

export function parseFormat(url: URL): ExportFormat | null {
  const f = url.searchParams.get("format")?.trim().toLowerCase();
  return f === "csv" || f === "xlsx" ? f : null;
}

// For csv with several sheets only the first is written.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function exportResponse(format: ExportFormat, filename: string, sheets: Sheet<any>[]): Response {
  const headers = {
    "Content-Type": CONTENT_TYPES[format],
    "Content-Disposition": `attachment; filename="${safeFilename(filename, format)}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (format === "csv") {
    const first = sheets[0];
    return new Response(first ? toCsv(first.columns, first.rows) : "﻿", { headers });
  }
  return new Response(new Uint8Array(toXlsx(sheets)), { headers });
}
