export const runtime = "nodejs";
// Spends Apollo credits, so this route is heavily guarded: owner only,
// requires an explicit confirmSpend, capped at 50 ids per call, refuses
// outright when Apollo is not configured, and is checked against the daily
// credit cap before a single Apollo call is made.
import { db, audit } from "../../../lib/db";
import { requireUser } from "../../../lib/session";
import { spendGuard } from "../../../lib/apollo/spend";
import {
  isConfigured,
  enrichPerson,
  ApolloAuthError,
  ApolloRateLimited,
  ApolloRequestError,
  ApolloNotConfigured,
} from "../../../lib/apollo/client";

const MAX_IDS_PER_CALL = 50;

type ContactRow = {
  id: number;
  apollo_id: string | null;
  email: string | null;
  last_name: string | null;
  title: string | null;
  linkedin_url: string | null;
  company_id: number | null;
  do_not_contact: number;
};

type EnrichOutcome = { contactId: number; ok: boolean; email?: string; error?: string };

function apolloErrorMessage(err: unknown): string {
  if (err instanceof ApolloNotConfigured) return "Apollo is not configured.";
  if (err instanceof ApolloAuthError) return "Apollo rejected the configured API key.";
  if (err instanceof ApolloRateLimited) return "Apollo is rate limiting this account right now.";
  if (err instanceof ApolloRequestError) return "Apollo request failed.";
  return "Unexpected error contacting Apollo.";
}

function isSuppressed(email: string): boolean {
  const row = db().prepare(`SELECT email FROM suppression WHERE email = ?`).get(email.toLowerCase());
  return !!row;
}

export async function POST(req: Request) {
  const user = await requireUser(["owner"]);
  if (user instanceof Response) return user;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.confirmSpend !== true) {
    return Response.json(
      { error: "Set confirmSpend: true to enrich contacts and spend Apollo credits." },
      { status: 400 }
    );
  }

  const contactIdsIn = Array.isArray(body.contactIds) ? body.contactIds : [];
  const contactIds = contactIdsIn.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  if (contactIds.length === 0) {
    return Response.json({ error: "contactIds must be a non-empty array of contact ids." }, { status: 400 });
  }
  if (contactIds.length > MAX_IDS_PER_CALL) {
    return Response.json({ error: `At most ${MAX_IDS_PER_CALL} contact ids are allowed per call.` }, { status: 400 });
  }

  if (!isConfigured()) {
    return Response.json(
      { error: "Apollo enrichment is not configured for this workspace. Set APOLLO_API_KEY to enable it." },
      { status: 503 }
    );
  }

  const uniqueIds = Array.from(new Set(contactIds));
  const results: EnrichOutcome[] = [];
  const eligible: ContactRow[] = [];

  for (const id of uniqueIds) {
    const contact = db()
      .prepare(
        `SELECT id, apollo_id, email, last_name, title, linkedin_url, company_id, do_not_contact FROM contacts WHERE id = ?`
      )
      .get(id) as ContactRow | undefined;
    if (!contact) {
      results.push({ contactId: id, ok: false, error: "Contact not found." });
      continue;
    }
    if (!contact.apollo_id) {
      results.push({ contactId: id, ok: false, error: "No Apollo id on file for this contact." });
      continue;
    }
    if (contact.email) {
      results.push({ contactId: id, ok: false, error: "Contact already has an email on file." });
      continue;
    }
    eligible.push(contact);
  }

  const guard = spendGuard(db(), eligible.length);
  if (!guard.ok) {
    return Response.json({ error: guard.reason }, { status: 429 });
  }

  let creditsUsed = 0;

  for (const contact of eligible) {
    try {
      const person = await enrichPerson({ confirmSpend: true, id: contact.apollo_id as string });
      creditsUsed += 1;

      if (!person || !person.email) {
        results.push({ contactId: contact.id, ok: false, error: "Apollo did not return an email for this contact." });
        continue;
      }

      const email = person.email.toLowerCase().trim();
      const conflict = db().prepare(`SELECT id FROM contacts WHERE email = ? AND id != ?`).get(email, contact.id) as
        | { id: number }
        | undefined;
      if (conflict) {
        results.push({
          contactId: contact.id,
          ok: false,
          error: `That email already belongs to contact #${conflict.id}; not overwritten.`,
        });
        continue;
      }

      const fields: string[] = ["email = ?", "email_status = 'unknown'", "enriched_at = datetime('now')", "updated_at = datetime('now')"];
      const values: (string | number)[] = [email];

      if (person.lastName && contact.last_name?.includes("*")) {
        fields.push("last_name = ?");
        values.push(person.lastName);
      }
      if (person.title && !contact.title) {
        fields.push("title = ?");
        values.push(person.title);
      }
      if (person.linkedinUrl && !contact.linkedin_url) {
        fields.push("linkedin_url = ?");
        values.push(person.linkedinUrl);
      }
      const suppressed = isSuppressed(email);
      if (suppressed && !contact.do_not_contact) {
        fields.push("do_not_contact = 1");
      }

      values.push(contact.id);
      db().prepare(`UPDATE contacts SET ${fields.join(", ")} WHERE id = ?`).run(...values);

      if (contact.company_id && person.organizationDomain) {
        const company = db().prepare(`SELECT domain FROM companies WHERE id = ?`).get(contact.company_id) as
          | { domain: string | null }
          | undefined;
        if (company && !company.domain) {
          db()
            .prepare(`UPDATE companies SET domain = ?, updated_at = datetime('now') WHERE id = ?`)
            .run(person.organizationDomain.toLowerCase(), contact.company_id);
        }
      }

      results.push({ contactId: contact.id, ok: true, email });
    } catch (err) {
      creditsUsed += 1;
      results.push({ contactId: contact.id, ok: false, error: apolloErrorMessage(err) });
    }
  }

  audit({
    actorUserId: user.id,
    action: "apollo.enrich",
    entity: "contact",
    detail: {
      requested: uniqueIds.length,
      attempted: eligible.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      creditsUsed,
    },
  });

  return Response.json({ results, creditsUsed });
}
