import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SignJWT } from "jose";
import { hashPassword, verifyPassword, readSessionToken, type SessionUser } from "../app/lib/session";

const SECRET = "a".repeat(32);

describe("hashPassword / verifyPassword", () => {
  it("round trips a correct password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects an incorrect password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("produces different hashes (different salts) for the same password", () => {
    const a = hashPassword("same password");
    const b = hashPassword("same password");
    expect(a).not.toBe(b);
    expect(verifyPassword("same password", a)).toBe(true);
    expect(verifyPassword("same password", b)).toBe(true);
  });

  it("rejects a malformed stored value", () => {
    expect(verifyPassword("anything", "not-a-valid-hash")).toBe(false);
  });
});

describe("readSessionToken", () => {
  const user: SessionUser = { id: 1, email: "dana@yourfirm.test", name: "Dana", role: "principal" };

  beforeEach(() => {
    process.env.SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.SESSION_SECRET;
    vi.useRealTimers();
  });

  it("accepts a validly signed token", async () => {
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ ...user })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(key);
    const result = await readSessionToken(token);
    expect(result).toEqual(user);
  });

  it("rejects a token signed with another secret", async () => {
    const otherKey = new TextEncoder().encode("b".repeat(32));
    const token = await new SignJWT({ ...user })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(otherKey);
    const result = await readSessionToken(token);
    expect(result).toBeNull();
  });

  it("rejects an expired token", async () => {
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ ...user })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("-1s")
      .sign(key);
    const result = await readSessionToken(token);
    expect(result).toBeNull();
  });

  it('rejects an alg "none" token', async () => {
    // Hand-build an unsigned "none"-alg JWT: header.payload. with an empty signature.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ ...user, iat: Math.floor(Date.now() / 1000) })).toString(
      "base64url"
    );
    const token = `${header}.${payload}.`;
    const result = await readSessionToken(token);
    expect(result).toBeNull();
  });

  it("rejects a token with an invalid role", async () => {
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ ...user, role: "superadmin" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(key);
    const result = await readSessionToken(token);
    expect(result).toBeNull();
  });

  it("returns null when there is no SESSION_SECRET configured (fails closed)", async () => {
    delete process.env.SESSION_SECRET;
    const key = new TextEncoder().encode(SECRET);
    const token = await new SignJWT({ ...user })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("12h")
      .sign(key);
    const result = await readSessionToken(token);
    expect(result).toBeNull();
  });

  it("returns null for an undefined token", async () => {
    expect(await readSessionToken(undefined)).toBeNull();
  });
});
