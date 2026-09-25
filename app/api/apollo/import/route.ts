export const runtime = "nodejs";
// Imports selected Apollo search results into companies + contacts. Search
// results are not persisted server-side between calls, so the client posts
// back the exact result objects it received from /api/apollo/search (never
// re-fetched or re-keyed against Apollo here) plus the target segment.
import { requireUser } from "../../../lib/session";
import { firm } from "../../../../firm.config";
import { importApolloSelection } from "../../../lib/apollo/import";
import type { ApolloOrganization, ApolloPerson } from "../../../lib/apollo/client";

const VALID_SEGMENTS = new Set(firm.segments.map((s) => s.id));

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function coercePerson(v: unknown): ApolloPerson | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (!str(p.id)) return null;
  return {
    id: String(p.id),
    firstName: str(p.firstName),
    lastName: str(p.lastName),
    name: str(p.name),
    title: str(p.title),
    email: str(p.email),
    emailStatus: str(p.emailStatus),
    linkedinUrl: str(p.linkedinUrl),
    organizationName: str(p.organizationName),
    organizationDomain: str(p.organizationDomain),
    city: str(p.city),
    state: str(p.state),
    raw: null,
  };
}

function coerceOrg(v: unknown): ApolloOrganization | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (!str(o.id) && !str(o.name)) return null;
  return {
    id: String(o.id ?? ""),
    name: str(o.name),
    domain: str(o.domain),
    industry: str(o.industry),
    city: str(o.city),
    state: str(o.state),
    estimatedEmployees: num(o.estimatedEmployees),
    raw: null,
  };
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (user instanceof Response) return user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const segmentId = typeof body.segmentId === "string" ? body.segmentId : "";
  if (!segmentId || !VALID_SEGMENTS.has(segmentId)) {
    return Response.json({ error: "A valid segmentId is required" }, { status: 400 });
  }

  const peopleIn = Array.isArray(body.people) ? body.people : [];
  const companiesIn = Array.isArray(body.companies) ? body.companies : [];
  const people = peopleIn.map(coercePerson).filter((p): p is ApolloPerson => p !== null);
  const companies = companiesIn.map(coerceOrg).filter((c): c is ApolloOrganization => c !== null);

  if (people.length === 0 && companies.length === 0) {
    return Response.json({ error: "No valid people or companies to import" }, { status: 400 });
  }

  const result = importApolloSelection({ people, companies, segmentId, userId: user.id });

  return Response.json({ result });
}
