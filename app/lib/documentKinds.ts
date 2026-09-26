// Pure document constants shared by the server (validation) and the client
// (labels, the file picker's accept list). No db, no node:* imports here.

export const DOC_KINDS = ["engagement_letter", "nda", "teaser", "cim", "loi", "financials", "other"] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** Singular label, for a select option or one document. */
export const DOC_KIND_LABELS: Record<DocKind, string> = {
  engagement_letter: "Engagement letter",
  nda: "NDA",
  teaser: "Teaser",
  cim: "CIM",
  loi: "LOI",
  financials: "Financials",
  other: "Other",
};

/** Group heading on the deal page. */
export const DOC_KIND_GROUPS: Record<DocKind, string> = {
  engagement_letter: "Engagement letter",
  nda: "NDAs",
  teaser: "Teaser",
  cim: "CIM",
  loi: "LOIs",
  financials: "Financials",
  other: "Other",
};

export const isDocKind = (v: unknown): v is DocKind => typeof v === "string" && (DOC_KINDS as readonly string[]).includes(v);

/** Kinds that are tied to one buyer on the buyer log. */
export const BUYER_KINDS: readonly DocKind[] = ["nda", "loi"];

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * Allowed file types: extension -> the canonical mime we store and serve, plus
 * the mimes a browser may legitimately send for it. The stored mime is always
 * the canonical one, never whatever the client claimed.
 */
export const ALLOWED_TYPES: Record<string, { mime: string; accept: string[] }> = {
  pdf: { mime: "application/pdf", accept: ["application/pdf", "application/x-pdf"] },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", accept: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "application/zip"] },
  doc: { mime: "application/msword", accept: ["application/msword"] },
  xlsx: { mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", accept: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/zip"] },
  xls: { mime: "application/vnd.ms-excel", accept: ["application/vnd.ms-excel"] },
  pptx: { mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation", accept: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", "application/zip"] },
  ppt: { mime: "application/vnd.ms-powerpoint", accept: ["application/vnd.ms-powerpoint"] },
  csv: { mime: "text/csv", accept: ["text/csv", "application/csv", "text/plain", "application/vnd.ms-excel"] },
  txt: { mime: "text/plain", accept: ["text/plain"] },
  png: { mime: "image/png", accept: ["image/png"] },
  jpg: { mime: "image/jpeg", accept: ["image/jpeg", "image/pjpeg"] },
  jpeg: { mime: "image/jpeg", accept: ["image/jpeg", "image/pjpeg"] },
  msg: { mime: "application/vnd.ms-outlook", accept: ["application/vnd.ms-outlook"] },
  eml: { mime: "message/rfc822", accept: ["message/rfc822"] },
  zip: { mime: "application/zip", accept: ["application/zip", "application/x-zip-compressed", "application/x-zip"] },
};

/** For <input type="file" accept>. */
export const ACCEPT_ATTR = Object.keys(ALLOWED_TYPES)
  .map((e) => `.${e}`)
  .join(",");

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
