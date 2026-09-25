// Auth gate. Everything requires a valid session except the login page,
// the login/logout API and static assets. Fails closed.
import { NextResponse, type NextRequest } from "next/server";
import { jwtVerify } from "jose";

// /u/<token> is the opt-out page a recipient reaches from an email: it must work signed out.
const PUBLIC = ["/login", "/api/auth/login", "/api/auth/logout", "/u", "/api/unsubscribe"];

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  // Local dev switch, see noLoginMode() in app/lib/session.ts. Hard-off in production.
  if (process.env.HARNESS_NO_LOGIN === "1" && process.env.NODE_ENV !== "production") {
    if (pathname === "/login") return NextResponse.redirect(new URL("/", req.url));
    return NextResponse.next();
  }
  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p + "/"))) return NextResponse.next();

  const secret = process.env.SESSION_SECRET;
  const token = req.cookies.get("harness_session")?.value;
  let ok = false;
  if (secret && secret.length >= 32 && token) {
    try {
      await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"] });
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (ok) return NextResponse.next();
  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)"],
};
