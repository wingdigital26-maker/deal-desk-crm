// Shared route-test harness: a fresh temp database per test, a signed-in user
// of any role, and small insert helpers. Route handlers call requireUser(),
// which reads the session cookie via next/headers; each test file mocks that
// with `vi.mock("next/headers", () => cookieMock())`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SECRET = "h".repeat(32);
export const harness: { token: string | undefined } = { token: undefined };

export function cookieMock() {
  return {
    cookies: async () => ({
      get: (name: string) => (name === "harness_session" ? { value: harness.token } : undefined),
    }),
  };
}

type Val = string | number | null;

export async function freshApp() {
  const dir = mkdtempSync(path.join(tmpdir(), "harness-test-"));
  process.env.HARNESS_DB_PATH = path.join(dir, "test.db");
  process.env.HARNESS_FILES_DIR = path.join(dir, "files");
  process.env.SESSION_SECRET = SECRET;
  harness.token = undefined;
  const dbModule = await import("../app/lib/db");
  const session = await import("../app/lib/session");
  const d = dbModule.db();

  async function signIn(role: "owner" | "principal" | "member" = "owner", name = `Test ${role}`) {
    const email = `${role}-${Math.random()}@example.com`;
    const id = Number(
      d.prepare("INSERT INTO users (email, name, role, password_hash) VALUES (?,?,?,?)").run(email, name, role, "scrypt$aa$bb").lastInsertRowid
    );
    harness.token = (await session.signSession({ id, email, name, role })) ?? undefined;
    return id;
  }
  const signOut = () => {
    harness.token = undefined;
  };
  const insert = (table: string, row: Record<string, unknown>) => {
    const cols = Object.keys(row);
    return Number(
      d
        .prepare(`INSERT INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
        .run(...(Object.values(row) as Val[])).lastInsertRowid
    );
  };
  const company = (name = `Co ${Math.random()}`, extra: Record<string, unknown> = {}) => insert("companies", { name, ...extra });
  const deal = (companyId: number, stage = "Engaged", title = "Sell-side") => insert("deals", { company_id: companyId, title, stage });
  const contact = (extra: Record<string, unknown> = {}) => insert("contacts", { first_name: "Pat", last_name: `Lee${Math.random()}`, ...extra });
  return { db: d, dbModule, signIn, signOut, insert, company, deal, contact };
}

export type App = Awaited<ReturnType<typeof freshApp>>;

export const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });

export function jsonReq(url: string, method: string, body?: unknown) {
  return new Request(`http://test${url}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function cleanup() {
  delete process.env.SESSION_SECRET;
  delete process.env.HARNESS_DB_PATH;
  delete process.env.HARNESS_FILES_DIR;
}
