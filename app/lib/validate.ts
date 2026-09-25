// Small composable validators for API route input. Each validator either
// returns the clean value or throws a ValidationError naming the bad field.
// Never silently coerce an out-of-range or malformed value to null.

export class ValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
    this.name = "ValidationError";
  }
}

/** Turns a ValidationError into the { error } shape every route already returns. */
export function validationErrorResponse(err: unknown): Response | null {
  if (err instanceof ValidationError) {
    return Response.json({ error: err.message, field: err.field }, { status: 400 });
  }
  return null;
}

// ---- strings ----

/**
 * Bounded, trimmed string. Returns null for empty/undefined/null input unless
 * `required` is set, in which case empty throws.
 */
export function boundedString(
  field: string,
  value: unknown,
  maxLength: number,
  opts: { required?: boolean } = {}
): string | null {
  if (value === undefined || value === null || value === "") {
    if (opts.required) throw new ValidationError(field, `${field} is required`);
    return null;
  }
  if (typeof value !== "string") {
    throw new ValidationError(field, `${field} must be text`);
  }
  const trimmed = value.trim();
  if (opts.required && !trimmed) {
    throw new ValidationError(field, `${field} is required`);
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(field, `${field} must be ${maxLength} characters or fewer`);
  }
  return trimmed || null;
}

export const name = (field: string, value: unknown, opts?: { required?: boolean }) =>
  boundedString(field, value, 200, opts);

export const title = (field: string, value: unknown, opts?: { required?: boolean }) =>
  boundedString(field, value, 200, opts);

export const notes = (field: string, value: unknown, opts?: { required?: boolean }) =>
  boundedString(field, value, 5000, opts);

export function url(field: string, value: unknown, opts: { required?: boolean } = {}): string | null {
  const bounded = boundedString(field, value, 500, opts);
  if (bounded === null) return null;
  try {
    // eslint-disable-next-line no-new
    new URL(bounded);
  } catch {
    throw new ValidationError(field, `${field} must be a valid URL`);
  }
  return bounded;
}

// ---- numbers ----

/**
 * Integer within [min, max]. Rejects non-numeric input outright instead of
 * coercing it to null. Returns null only when the input itself is empty/null/undefined.
 */
export function integerRange(
  field: string,
  value: unknown,
  min: number,
  max: number,
  opts: { required?: boolean } = {}
): number | null {
  if (value === undefined || value === null || value === "") {
    if (opts.required) throw new ValidationError(field, `${field} is required`);
    return null;
  }
  const n = typeof value === "number" ? value : Number(value);
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidationError(field, `${field} must be a number`);
  }
  if (!Number.isFinite(n) || Number.isNaN(n) || !Number.isInteger(n)) {
    throw new ValidationError(field, `${field} must be a whole number`);
  }
  if (n < min || n > max) {
    throw new ValidationError(field, `${field} must be between ${min} and ${max}`);
  }
  return n;
}

/** Any finite number (decimals allowed) within [min, max]. */
export function numberRange(
  field: string,
  value: unknown,
  min: number,
  max: number,
  opts: { required?: boolean } = {}
): number | null {
  if (value === undefined || value === null || value === "") {
    if (opts.required) throw new ValidationError(field, `${field} is required`);
    return null;
  }
  if (typeof value !== "number" && typeof value !== "string") {
    throw new ValidationError(field, `${field} must be a number`);
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) throw new ValidationError(field, `${field} must be a number`);
  if (n < min || n > max) throw new ValidationError(field, `${field} must be between ${min} and ${max}`);
  return n;
}

/** Whole dollars, zero up to ten trillion. */
export const money = (field: string, value: unknown) => integerRange(field, value, 0, 10_000_000_000_000);

/** 0-100, decimals allowed (a 2.5% success fee). */
export const percent = (field: string, value: unknown) => numberRange(field, value, 0, 100);

export const employees = (field: string, value: unknown, opts?: { required?: boolean }) =>
  integerRange(field, value, 0, 5_000_000, opts);

// ---- dates ----

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** YYYY-MM-DD calendar date (matches how this app stores `due` / `next_step_due`). */
export function isoDate(field: string, value: unknown, opts: { required?: boolean } = {}): string | null {
  if (value === undefined || value === null || value === "") {
    if (opts.required) throw new ValidationError(field, `${field} is required`);
    return null;
  }
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    throw new ValidationError(field, `${field} must be a date in YYYY-MM-DD format`);
  }
  const d = new Date(value + "T00:00:00Z");
  // Date rolls invalid days over (e.g. Feb 30 -> Mar 2) instead of throwing,
  // so round-trip the parts to catch a calendar date that doesn't exist.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(field, `${field} is not a real date`);
  }
  return value;
}

// ---- enums ----

/** Value must be one of `allowed` (e.g. firm.dealStages, firm.segments.map(s => s.id)). */
export function enumFromList<T extends string>(
  field: string,
  value: unknown,
  allowed: readonly T[],
  opts: { required?: boolean; fallback?: T } = {}
): T | null {
  if (value === undefined || value === null || value === "") {
    if (opts.required && opts.fallback === undefined) {
      throw new ValidationError(field, `${field} is required`);
    }
    return opts.fallback ?? null;
  }
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ValidationError(field, `${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}
