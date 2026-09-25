export const runtime = "nodejs";
// Proxies an Apollo people/company search server-side. Results are returned
// without any key material -- the response is the mapped, defensive shape
// from app/lib/apollo/client.ts, never the raw fetch body headers/etc.
import { requireUser } from "../../../lib/session";
import {
  isConfigured,
  searchPeople,
  searchCompanies,
  ApolloNotConfigured,
  ApolloAuthError,
  ApolloRateLimited,
  ApolloRequestError,
} from "../../../lib/apollo/client";

type SearchBody = {
  mode?: unknown;
  personTitles?: unknown;
  personLocations?: unknown;
  organizationLocations?: unknown;
  organizationNumEmployeesRanges?: unknown;
  qKeywords?: unknown;
  page?: unknown;
  perPage?: unknown;
};

function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return arr.length ? arr : undefined;
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  if (!isConfigured()) {
    return Response.json(
      { error: "Apollo is not configured. Set APOLLO_API_KEY on the server." },
      { status: 503 }
    );
  }

  let body: SearchBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const mode = body.mode === "companies" ? "companies" : "people";
  const page = typeof body.page === "number" && body.page > 0 ? Math.floor(body.page) : 1;
  const perPage =
    typeof body.perPage === "number" && body.perPage > 0 ? Math.min(Math.floor(body.perPage), 100) : 25;
  const qKeywords = typeof body.qKeywords === "string" ? body.qKeywords.trim() || undefined : undefined;
  const organizationLocations = strArray(body.organizationLocations);
  const organizationNumEmployeesRanges = strArray(body.organizationNumEmployeesRanges);

  try {
    if (mode === "companies") {
      const result = await searchCompanies({
        organizationLocations,
        organizationNumEmployeesRanges,
        qKeywords,
        page,
        perPage,
      });
      return Response.json({ mode, ...result });
    }

    const personTitles = strArray(body.personTitles);
    const personLocations = strArray(body.personLocations);
    const result = await searchPeople({
      personTitles,
      personLocations,
      organizationLocations,
      organizationNumEmployeesRanges,
      qKeywords,
      page,
      perPage,
    });
    return Response.json({ mode, ...result });
  } catch (err) {
    if (err instanceof ApolloNotConfigured) {
      return Response.json({ error: "Apollo is not configured." }, { status: 503 });
    }
    if (err instanceof ApolloAuthError) {
      return Response.json({ error: "Apollo rejected the configured API key." }, { status: 502 });
    }
    if (err instanceof ApolloRateLimited) {
      return Response.json({ error: "Apollo is rate limiting this account. Try again shortly." }, { status: 429 });
    }
    if (err instanceof ApolloRequestError) {
      return Response.json({ error: "Apollo search request failed." }, { status: 502 });
    }
    return Response.json({ error: "Unexpected error contacting Apollo." }, { status: 500 });
  }
}
