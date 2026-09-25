// Compliance core (FINRA Rule 2210 model). See ARCHITECTURE.md "Compliance model".
// Approval binds to a content hash. Any edit to subject/body/allowed fields
// changes the hash and voids approval. Rendering only fills allow-listed
// merge fields into approved content; merge VALUES are data, never content.
import { createHash } from "node:crypto";
import { firm } from "../../../firm.config";

export type LintFinding = {
  ruleId: string;
  severity: "block" | "warn";
  message: string;
  match: string;
  index: number;
};

const ALL_CAPS_WORD = /\b[A-Z]{4,}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s)]+|\bwww\.[^\s)]+/gi;
const SHORTENER_DOMAINS = [
  "bit.ly",
  "tinyurl.com",
  "t.co",
  "goo.gl",
  "ow.ly",
  "is.gd",
  "buff.ly",
  "rebrand.ly",
  "cutt.ly",
  "shorturl.at",
];

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * The legal footer template, built from firm.config: firm name and mailing
 * address filled in, {{unsubscribe_url}} left as the only per-recipient
 * field. This is part of what a principal approves, so it is covered by
 * contentHash below: change the footer (or firm.config's address) and every
 * existing approval is voided.
 */
export function footerTemplate(): string {
  return firm.outbound.footer
    .replace(/{{\s*firm_name\s*}}/g, firm.name)
    .replace(/{{\s*mailing_address\s*}}/g, firm.mailingAddress);
}

/**
 * sha256 hex over a canonical JSON of {subject, body, fields sorted, footer}.
 * CRLF normalized to LF first. The footer defaults to the current
 * footerTemplate(), so changing the approved footer (or the underlying
 * firm.config address) changes the hash of every template and voids every
 * existing approval. This is intended: re-approval is required.
 */
export function contentHash(
  subject: string,
  body: string,
  allowedMergeFields: string[],
  footer: string = footerTemplate()
): string {
  const canonical = JSON.stringify({
    subject: normalizeNewlines(subject),
    body: normalizeNewlines(body),
    fields: [...allowedMergeFields].sort(),
    footer: normalizeNewlines(footer),
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Firm voice rules (hard blocks) plus built-in warns. */
export function lintText(text: string): LintFinding[] {
  const findings: LintFinding[] = [];
  const normalized = normalizeNewlines(text);

  for (const rule of firm.voiceRules.forbiddenPatterns) {
    const re = new RegExp(rule.pattern, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(normalized))) {
      findings.push({
        ruleId: rule.id,
        severity: "block",
        message: rule.why,
        match: m[0],
        index: m.index,
      });
      if (m[0].length === 0) re.lastIndex++; // guard against zero-width matches
    }
  }

  // Built-in warns.
  let m: RegExpExecArray | null;
  const capsRe = new RegExp(ALL_CAPS_WORD);
  while ((m = capsRe.exec(normalized))) {
    findings.push({
      ruleId: "all-caps",
      severity: "warn",
      message: "All-caps word reads as shouting.",
      match: m[0],
      index: m.index,
    });
  }

  const bangMatches = [...normalized.matchAll(/!/g)];
  if (bangMatches.length > 1) {
    const second = bangMatches[1];
    findings.push({
      ruleId: "multi-exclamation",
      severity: "warn",
      message: "More than one exclamation mark in the message.",
      match: "!",
      index: second.index ?? 0,
    });
  }

  const freeRe = /\bfree\b/gi;
  while ((m = freeRe.exec(normalized))) {
    findings.push({
      ruleId: "free",
      severity: "warn",
      message: 'The word "free" reads as promotional.',
      match: m[0],
      index: m.index,
    });
  }

  const urlRe = new RegExp(URL_RE);
  while ((m = urlRe.exec(normalized))) {
    const url = m[0];
    const hasShortener = SHORTENER_DOMAINS.some((d) => url.toLowerCase().includes(d));
    if (hasShortener) {
      findings.push({
        ruleId: "url-shortener",
        severity: "warn",
        message: "URL shortener domain hides the real destination.",
        match: url,
        index: m.index,
      });
    }
  }

  return findings;
}

/** Finds {{field}} tokens. */
export function extractMergeFields(text: string): string[] {
  const re = /{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

export type RenderTemplateInput = { subject: string; body: string; allowedMergeFields: string[] };
export type RenderTemplateOptions = { unsubscribeUrl: string };
export type RenderTemplateResult =
  | { ok: true; subject: string; body: string; footer: string }
  | { ok: false; error: string };

/**
 * Renders a template with merge values, plus the legal footer with this
 * recipient's unsubscribe URL filled in. Merge values are DATA, never
 * content: they cannot contain a newline, "{{", a URL, and cannot exceed 80
 * chars. This is what keeps per-recipient text inside the approved content.
 * The footer must end up containing a real http/https URL and the firm's
 * mailing address, or the render fails outright: CAN-SPAM requires both on
 * every commercial email, so a message that cannot carry them must not be
 * sendable at all.
 */
export function renderTemplate(
  tpl: RenderTemplateInput,
  merge: Record<string, string>,
  options: RenderTemplateOptions
): RenderTemplateResult {
  const usedSubject = extractMergeFields(tpl.subject);
  const usedBody = extractMergeFields(tpl.body);
  const used = [...new Set([...usedSubject, ...usedBody])];

  for (const field of used) {
    if (!tpl.allowedMergeFields.includes(field)) {
      return { ok: false, error: `Field "${field}" is used but not in the allowed merge fields.` };
    }
  }

  for (const field of used) {
    const value = merge[field];
    if (value === undefined || value === null || value.trim() === "") {
      return { ok: false, error: `Required field "${field}" is missing or blank.` };
    }
    if (value.includes("\n") || value.includes("\r")) {
      return { ok: false, error: `Merge value for "${field}" cannot contain a newline.` };
    }
    if (value.includes("{{")) {
      return { ok: false, error: `Merge value for "${field}" cannot contain "{{".` };
    }
    if (/\bhttps?:\/\/|\bwww\./i.test(value)) {
      return { ok: false, error: `Merge value for "${field}" cannot contain a URL.` };
    }
    if (value.length > 80) {
      return { ok: false, error: `Merge value for "${field}" exceeds 80 characters.` };
    }
  }

  function fill(text: string): string {
    return text.replace(/{{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*}}/g, (_full, field: string) => merge[field] ?? "");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.unsubscribeUrl);
  } catch {
    return { ok: false, error: "Unsubscribe URL is missing or not a valid URL." };
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return { ok: false, error: "Unsubscribe URL must be http or https." };
  }

  const footer = footerTemplate().replace(/{{\s*unsubscribe_url\s*}}/g, options.unsubscribeUrl);
  if (!/\bhttps?:\/\/\S+/i.test(footer)) {
    return { ok: false, error: "Rendered footer is missing a valid unsubscribe URL." };
  }
  if (!footer.includes(firm.mailingAddress)) {
    return { ok: false, error: "Rendered footer is missing the firm mailing address." };
  }

  return { ok: true, subject: fill(tpl.subject), body: fill(tpl.body), footer };
}

export type SendableTemplateInput = {
  status: string;
  content_hash: string;
  subject: string;
  body: string;
  allowed_merge_fields: string; // JSON array string
};

/** True only if status is "approved" AND the recomputed hash matches content_hash. */
export function isSendable(template: SendableTemplateInput): { ok: boolean; reason?: string } {
  if (template.status !== "approved") {
    return { ok: false, reason: `Template status is "${template.status}", not "approved".` };
  }
  let fields: string[] = [];
  try {
    const parsed = JSON.parse(template.allowed_merge_fields);
    if (Array.isArray(parsed)) fields = parsed;
  } catch {
    return { ok: false, reason: "Allowed merge fields could not be parsed." };
  }
  const recomputed = contentHash(template.subject, template.body, fields);
  if (recomputed !== template.content_hash) {
    return { ok: false, reason: "Content has changed since approval. Hash mismatch." };
  }
  return { ok: true };
}
