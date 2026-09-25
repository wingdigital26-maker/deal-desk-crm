// Per-user signed sessions (jose JWT in an httpOnly cookie) + scrypt password hashes.
// Fails closed: no SESSION_SECRET means nobody is signed in.
import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "harness_session";
export type Role = "owner" | "principal" | "member";
// Local dev switch (Jack, 2026-09-24: "take away the login, we don't need that right now").
// HARNESS_NO_LOGIN=1 skips sign-in and acts as the first active owner. It is
// hard-off in production builds, so it can never ship open.
export const noLoginMode = () => process.env.HARNESS_NO_LOGIN === "1" && process.env.NODE_ENV !== "production";

export type SessionUser = { id: number; email: string; name: string; role: Role };

function secret(): Uint8Array | null {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) return null;
  return new TextEncoder().encode(s);
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(expected, actual);
}

export async function signSession(user: SessionUser): Promise<string | null> {
  const key = secret();
  if (!key) return null;
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("12h")
    .sign(key);
}

export async function readSessionToken(token: string | undefined): Promise<SessionUser | null> {
  const key = secret();
  if (!key || !token) return null;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    const { id, email, name, role } = payload as Record<string, unknown>;
    if (typeof id !== "number" || typeof email !== "string" || typeof name !== "string") return null;
    if (role !== "owner" && role !== "principal" && role !== "member") return null;
    return { id, email, name, role };
  } catch {
    return null;
  }
}

// The token only proves WHO signed in. Name and role always come from the
// database, so a demoted or deleted user loses access on the next request
// instead of keeping the old role until the token expires.
export async function currentUser(): Promise<SessionUser | null> {
  if (noLoginMode()) {
    const { db } = await import("./db");
    const owner = db().prepare("SELECT id, email, name FROM users WHERE role = 'owner' AND disabled = 0 ORDER BY id LIMIT 1").get() as
      | { id: number; email: string; name: string }
      | undefined;
    if (owner) return { ...owner, role: "owner" };
  }
  const jar = await cookies();
  const claimed = await readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!claimed) return null;
  const { db } = await import("./db");
  const row = db().prepare("SELECT id, email, name, role, disabled FROM users WHERE id = ?").get(claimed.id) as
    | { id: number; email: string; name: string; role: string; disabled: number }
    | undefined;
  if (!row || row.email !== claimed.email || row.disabled) return null;
  if (row.role !== "owner" && row.role !== "principal" && row.role !== "member") return null;
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

// Use at the top of every API route. Returns the user or a 401/403 Response.
export async function requireUser(roles?: Role[]): Promise<SessionUser | Response> {
  const user = await currentUser();
  if (!user) return Response.json({ error: "Not signed in" }, { status: 401 });
  if (roles && !roles.includes(user.role)) {
    return Response.json({ error: "Not allowed for this role" }, { status: 403 });
  }
  return user;
}
