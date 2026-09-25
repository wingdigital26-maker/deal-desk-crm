export const runtime = "nodejs";
// Login: constant generic error, database-backed rate limit (survives restarts
// and works across instances), audit on every attempt, httpOnly session cookie.
// Fails closed if SESSION_SECRET is missing.
import { db, audit } from "../../../lib/db";
import { verifyPassword, hashPassword, signSession, SESSION_COOKIE } from "../../../lib/session";

// Verified against when the email is unknown, so an unknown email costs the same
// scrypt work as a wrong password and response time does not reveal which accounts exist.
const DUMMY_HASH = hashPassword("not-a-real-account-" + Math.random());

const GENERIC_ERROR = "Email or password is incorrect";
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8; // per account, regardless of where the request claims to come from
const MAX_ATTEMPTS_PER_IP = 40; // secondary, looser bucket
const PRUNE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // opportunistic cleanup, not a separate cron

// Records this attempt against `bucket`, opportunistically prunes rows older
// than a day, and returns whether the bucket has exceeded `max` attempts in
// the rolling WINDOW_MS window. Backed by login_attempts so limits survive a
// restart and are shared across instances (unlike the old in-memory Map).
function rateLimited(bucket: string, max: number): boolean {
  const database = db();
  database.prepare("INSERT INTO login_attempts (bucket) VALUES (?)").run(bucket);

  const cutoff = new Date(Date.now() - PRUNE_MAX_AGE_MS).toISOString().replace("T", " ").slice(0, 19);
  database.prepare("DELETE FROM login_attempts WHERE created_at < ?").run(cutoff);

  const windowCutoff = new Date(Date.now() - WINDOW_MS).toISOString().replace("T", " ").slice(0, 19);
  const row = database
    .prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE bucket = ? AND created_at >= ?")
    .get(bucket, windowCutoff) as { n: number };
  return row.n > max;
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

type UserRow = {
  id: number;
  email: string;
  name: string;
  role: "owner" | "principal" | "member";
  password_hash: string;
};

export async function POST(req: Request) {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    return Response.json(
      { error: "Sign-in is not configured. SESSION_SECRET is missing." },
      { status: 503 }
    );
  }

  let body: { email?: unknown; password?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const emailRaw = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  const email = emailRaw.trim().toLowerCase();
  const ip = clientIp(req);

  if (!email || !password) {
    return Response.json({ error: GENERIC_ERROR }, { status: 400 });
  }

  // The account bucket is keyed on the email alone: x-forwarded-for is client-controlled,
  // so rotating it must not reset the limit for an account under attack.
  const accountLimited = rateLimited(`acct:${email}`, MAX_ATTEMPTS);
  const ipLimited = rateLimited(`ip:${ip}`, MAX_ATTEMPTS_PER_IP);
  if (accountLimited || ipLimited) {
    audit({ actorLabel: email, action: "login.rate_limited", detail: { ip } });
    return Response.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  }

  const row = db()
    .prepare("SELECT id, email, name, role, password_hash FROM users WHERE email = ?")
    .get(email) as UserRow | undefined;

  const ok = verifyPassword(password, row ? row.password_hash : DUMMY_HASH) && Boolean(row);

  if (!row || !ok) {
    audit({ actorLabel: email, action: "login.failure", detail: { ip } });
    return Response.json({ error: GENERIC_ERROR }, { status: 401 });
  }

  const sessionUser = { id: row.id, email: row.email, name: row.name, role: row.role };
  const token = await signSession(sessionUser);
  if (!token) {
    return Response.json(
      { error: "Sign-in is not configured. SESSION_SECRET is missing." },
      { status: 503 }
    );
  }

  audit({ actorUserId: row.id, actorLabel: row.email, action: "login.success", detail: { ip } });

  const res = Response.json({ ok: true });
  res.headers.append(
    "Set-Cookie",
    [
      `${SESSION_COOKIE}=${token}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${12 * 60 * 60}`,
      process.env.NODE_ENV === "production" ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; ")
  );
  return res;
}
