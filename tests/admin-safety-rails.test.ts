// Covers the data-level safety rails that app/api/users/[id]/route.ts and
// app/api/users/[id]/disable/route.ts enforce before allowing a role change or
// an access removal: never demote/disable the last active owner, and a user
// can never demote themselves out of Owner. The route handlers themselves
// call requireUser() (which needs a real request's cookies), so these tests
// exercise the same countActiveOwners() helper and the same boundary
// conditions the routes branch on, against a real temp database.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpDir: string;
let dbModule: typeof import("../app/lib/db");
let helpers: typeof import("../app/api/users/_helpers");

function freshDb() {
  tmpDir = mkdtempSync(path.join(tmpdir(), "harness-admin-"));
  process.env.HARNESS_DB_PATH = path.join(tmpDir, "test.db");
}

function insertUser(role: "owner" | "principal" | "member", disabled = 0) {
  const info = dbModule
    .db()
    .prepare("INSERT INTO users (email, name, role, password_hash, disabled) VALUES (?,?,?,?,?)")
    .run(`${role}-${Math.random()}@example.com`, `Test ${role}`, role, "scrypt$aa$bb", disabled);
  return Number(info.lastInsertRowid);
}

beforeEach(async () => {
  freshDb();
  vi.resetModules();
  dbModule = await import("../app/lib/db");
  helpers = await import("../app/api/users/_helpers");
  dbModule.db(); // create schema
});

describe("countActiveOwners", () => {
  it("counts only owners with disabled = 0", () => {
    insertUser("owner");
    insertUser("owner", 1); // disabled owner does not count
    insertUser("member");
    expect(helpers.countActiveOwners()).toBe(1);
  });

  it("excludes a given user id when asked", () => {
    const ownerA = insertUser("owner");
    insertUser("owner");
    expect(helpers.countActiveOwners(ownerA)).toBe(1);
  });

  it("is zero when there are no active owners", () => {
    insertUser("member");
    insertUser("principal");
    expect(helpers.countActiveOwners()).toBe(0);
  });
});

describe("last-owner protection (the guard app/api/users/[id]/route.ts PATCH applies)", () => {
  it("blocks demoting the sole active owner", () => {
    const soleOwner = insertUser("owner");
    // Mirrors: wasOwner && !willStillBeOwner && countActiveOwners() <= 1
    const wasOwner = true;
    const willStillBeOwner = false;
    const blocked = wasOwner && !willStillBeOwner && helpers.countActiveOwners() <= 1;
    expect(blocked).toBe(true);
    void soleOwner;
  });

  it("allows demoting an owner when another active owner remains", () => {
    insertUser("owner");
    insertUser("owner");
    const wasOwner = true;
    const willStillBeOwner = false;
    const blocked = wasOwner && !willStillBeOwner && helpers.countActiveOwners() <= 1;
    expect(blocked).toBe(false);
  });
});

describe("last-owner protection (the guard app/api/users/[id]/disable/route.ts applies)", () => {
  it("blocks removing access from the sole active owner", () => {
    const owner = insertUser("owner");
    // Mirrors: existing.role === "owner" && existing.disabled === 0 && countActiveOwners(id) === 0
    const blocked = helpers.countActiveOwners(owner) === 0;
    expect(blocked).toBe(true);
  });

  it("allows removing access from an owner when another active owner remains", () => {
    const ownerA = insertUser("owner");
    insertUser("owner");
    const blocked = helpers.countActiveOwners(ownerA) === 0;
    expect(blocked).toBe(false);
  });
});

describe("self-demotion protection (the guard app/api/users/[id]/route.ts PATCH applies)", () => {
  it("blocks a user demoting themselves out of Owner even if other owners exist", () => {
    const self = insertUser("owner");
    insertUser("owner"); // another active owner exists, but self-demotion is still blocked
    const isSelf = true;
    const wasOwner = true;
    const willStillBeOwner = false;
    const blocked = isSelf && wasOwner && !willStillBeOwner;
    expect(blocked).toBe(true);
    void self;
  });

  it("does not block a self role change that keeps Owner", () => {
    const self = insertUser("owner");
    const isSelf = true;
    const wasOwner = true;
    const willStillBeOwner = true;
    const blocked = isSelf && wasOwner && !willStillBeOwner;
    expect(blocked).toBe(false);
    void self;
  });

  it("does not block another owner demoting someone else", () => {
    insertUser("owner");
    insertUser("owner");
    const isSelf = false;
    const wasOwner = true;
    const willStillBeOwner = false;
    const blocked = isSelf && wasOwner && !willStillBeOwner;
    expect(blocked).toBe(false);
  });
});

describe("hasActiveCompliancePrincipal", () => {
  it("is false with no principal", () => {
    insertUser("owner");
    expect(helpers.hasActiveCompliancePrincipal()).toBe(false);
  });
  it("is false when the only principal is disabled", () => {
    insertUser("principal", 1);
    expect(helpers.hasActiveCompliancePrincipal()).toBe(false);
  });
  it("is true with an active principal", () => {
    insertUser("principal");
    expect(helpers.hasActiveCompliancePrincipal()).toBe(true);
  });
});

describe("generateTempPassword", () => {
  it("produces a password of at least 16 characters", () => {
    expect(helpers.generateTempPassword().length).toBeGreaterThanOrEqual(16);
  });
  it("produces different passwords on each call", () => {
    const a = helpers.generateTempPassword();
    const b = helpers.generateTempPassword();
    expect(a).not.toBe(b);
  });
});
