export const runtime = "nodejs";
// Logout: clear the session cookie, redirect to /login.
import { SESSION_COOKIE } from "../../../lib/session";

export async function POST() {
  const res = new Response(null, {
    status: 303,
    headers: { Location: "/login" },
  });
  res.headers.append(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
  );
  return res;
}
