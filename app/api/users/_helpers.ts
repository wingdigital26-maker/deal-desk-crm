// Shared helpers for the People and Access API routes. Owner-only surface.
import { randomBytes } from "node:crypto";
import { db } from "../../lib/db";
import type { Role } from "../../lib/session";

// firm.config.ts names "principal" as the compliance-approval role; this is
// the app's plain-English word for it everywhere in the UI and API errors.
export const COMPLIANCE_PRINCIPAL_ROLE: Role = "principal";

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  principal: "Compliance principal",
  member: "Team member",
};

const TEMP_PASSWORD_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";

/** Cryptographically random 20-character one-time password. Never stored or logged in plaintext. */
export function generateTempPassword(length = 20): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += TEMP_PASSWORD_ALPHABET[bytes[i] % TEMP_PASSWORD_ALPHABET.length];
  }
  return out;
}

export type UserRow = {
  id: number;
  email: string;
  name: string;
  role: Role;
  disabled: number;
};

export function countActiveOwners(excludingUserId?: number): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM users WHERE role = 'owner' AND disabled = 0 ${
        excludingUserId ? "AND id != ?" : ""
      }`
    )
    .get(...(excludingUserId ? [excludingUserId] : [])) as { n: number };
  return row.n;
}

export function hasActiveCompliancePrincipal(): boolean {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM users WHERE role = ? AND disabled = 0")
    .get(COMPLIANCE_PRINCIPAL_ROLE) as { n: number };
  return row.n > 0;
}
