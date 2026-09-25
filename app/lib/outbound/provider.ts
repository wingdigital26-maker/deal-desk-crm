// Send providers. Nothing in this lane may perform a real send in tests or in
// this environment: DryRunProvider is the default everywhere and the only
// provider exercised by the test suite (every provider test stubs global
// fetch to throw, so a real network call would fail the test loudly).
// ApolloProvider is fully implemented below against the send path Apollo's
// public REST API actually supports for arbitrary, already-approved content.
// See app/lib/outbound/README.md for the doc citations and the honest
// account of what a recipient actually receives.
import { getAllowedDomains } from "../instantly/client";

export type SendRequest = {
  messageId: number;
  mailboxAddress: string;
  toEmail: string;
  subject: string;
  body: string;
  /** Recipient fields a campaign-based provider (Instantly) needs for the lead. */
  lead?: { firstName: string | null; lastName: string | null; companyName: string | null };
};

export type SendResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string };

export interface SendProvider {
  readonly name: string;
  send(req: SendRequest): Promise<SendResult>;
}

/** Default provider everywhere. Records what would have been sent, sends nothing. */
export class DryRunProvider implements SendProvider {
  readonly name = "dry-run";

  async send(req: SendRequest): Promise<SendResult> {
    return {
      ok: true,
      providerId: `dryrun_${req.messageId}_${Date.now()}`,
    };
  }
}

/**
 * Real Apollo integration, gated behind every one of: OUTBOUND_SEND_ENABLED
 * === "1", OUTBOUND_PROVIDER === "apollo", and the three APOLLO_* env vars.
 * The constructor throws if any switch is missing, and getProvider() below
 * falls back to DryRunProvider on that throw, so a partially configured
 * environment can never accidentally send.
 *
 * Research finding (read, never called, per this lane's rules): Apollo's
 * public REST API DOES let arbitrary, per-recipient content be sent as a
 * single message, independent of any sequence:
 *   1. POST /api/v1/emailer_messages ("Create an Email Draft") accepts
 *      contact_id, subject and body_html chosen by the caller, and drafts it
 *      from the email account that owns the API key.
 *      https://docs.apollo.io/reference/create-an-email-draft
 *   2. POST /api/v1/emailer_messages/send_now/{id} ("Send Email Now") sends
 *      that exact drafted message immediately, taking no content, only the
 *      message id.
 *      https://docs.apollo.io/reference/send-email-now
 * This means the alternative path (enrolling a contact into a pre-built
 * Apollo sequence whose copy lives in Apollo, described in
 * /reference/add-contacts-to-sequence and /reference/create-sequence) is NOT
 * required here: the message sent is exactly the approved template rendered
 * in this app, not a separate copy stored in Apollo. There is nothing for a
 * sequence step's text to drift from, so verifySequenceCopy() below is a
 * defensive no-op kept only for a future integration that enrolls into a
 * sequence instead.
 */
export class ApolloProvider implements SendProvider {
  readonly name = "apollo";
  private readonly apiKey: string;
  private readonly emailAccountId: string;

  constructor() {
    if (process.env.OUTBOUND_PROVIDER !== "apollo") {
      throw new Error('not configured: OUTBOUND_PROVIDER is not "apollo"');
    }
    if (process.env.OUTBOUND_SEND_ENABLED !== "1") {
      throw new Error('not configured: OUTBOUND_SEND_ENABLED is not "1"');
    }
    const missing = ["APOLLO_API_KEY", "APOLLO_SEQUENCE_ID", "APOLLO_EMAIL_ACCOUNT_ID"].filter(
      (k) => !process.env[k]
    );
    if (missing.length > 0) {
      throw new Error(`not configured: missing ${missing.join(", ")}`);
    }
    // APOLLO_SEQUENCE_ID is required as a fourth explicit switch (matching the
    // "three APOLLO_* vars" the send gate expects) but is not used by the
    // draft-and-send-now call below: this provider never enrolls a contact
    // into a sequence, so no sequence id is needed for the actual send.
    this.apiKey = process.env.APOLLO_API_KEY as string;
    this.emailAccountId = process.env.APOLLO_EMAIL_ACCOUNT_ID as string;
  }

  async send(req: SendRequest): Promise<SendResult> {
    try {
      const draftRes = await fetch("https://api.apollo.io/api/v1/emailer_messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Api-Key": this.apiKey },
        body: JSON.stringify({
          email_account_id: this.emailAccountId,
          to_email: req.toEmail,
          subject: req.subject,
          body_html: req.body,
        }),
      });
      if (!draftRes.ok) {
        return { ok: false, error: `Apollo draft request failed: HTTP ${draftRes.status}` };
      }
      const draft = (await draftRes.json().catch(() => ({}))) as { id?: string };
      if (!draft.id) {
        return { ok: false, error: "Apollo draft response did not include a message id." };
      }

      const sendRes = await fetch(`https://api.apollo.io/api/v1/emailer_messages/send_now/${draft.id}`, {
        method: "POST",
        headers: { "X-Api-Key": this.apiKey },
      });
      if (!sendRes.ok) {
        return { ok: false, error: `Apollo send_now request failed: HTTP ${sendRes.status}` };
      }

      return { ok: true, providerId: draft.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Apollo request failed." };
    }
  }
}

/**
 * Defensive no-op for the draft-and-send-now path implemented above (see the
 * class comment): there is no separate sequence-step copy for this provider
 * to drift from, since the exact approved subject/body is sent per message.
 * Kept only so a future switch to sequence-enrollment mode (a template with
 * an apollo_sequence_id mapping, copy authored inside Apollo) has a place to
 * plug in a real check before it can ever be trusted to send. Not called
 * anywhere in this lane.
 */
export async function verifySequenceCopy(): Promise<{ ok: boolean; reason?: string }> {
  return { ok: false, reason: "verifySequenceCopy is not implemented: this provider does not use Apollo sequences." };
}

/**
 * Stub only, for a bank running its own mail system instead of Apollo. No
 * transport is implemented; wiring one up (or not) is a decision for whoever
 * deploys this harness for that bank, never made here.
 */
export class SmtpProvider implements SendProvider {
  readonly name = "smtp";

  async send(_req: SendRequest): Promise<SendResult> {
    throw new Error("SmtpProvider is not configured: no SMTP transport is implemented in this harness");
  }
}

/**
 * Instantly lane: Deal Desk approves, Instantly sends. This provider never
 * sends email itself. For each message that already passed checkSend (content
 * hash + principal approval, suppression, do-not-contact, replier rule,
 * mailbox cap, OUTBOUND_SEND_ENABLED) it adds the recipient as a lead to ONE
 * Instantly campaign, carrying the approved, rendered subject and body
 * (footer included) as the custom variables `subject` and `body`. The
 * campaign's single step is `{{subject}}` / `{{body}}`, so what Instantly
 * sends is exactly the approved text.
 *
 * Endpoint: POST https://api.instantly.ai/api/v2/leads ("Create lead"),
 * https://developer.instantly.ai/api-reference/lead/create-lead
 *
 * Gated by ALL of: OUTBOUND_SEND_ENABLED === "1", OUTBOUND_PROVIDER ===
 * "instantly", INSTANTLY_API_KEY, INSTANTLY_CAMPAIGN_ID, and
 * INSTANTLY_ALLOWED_DOMAINS (non-empty). The constructor throws on any miss
 * and getProvider() falls back to DryRunProvider. INSTANTLY_ALLOWED_DOMAINS
 * is required here too because this Instantly workspace may be SHARED with another
 * tenant's campaigns: without a configured allowlist there is no
 * proof this push targets one of the firm's own sending domains rather than
 * riding along on another tenant's.
 */
export class InstantlyProvider implements SendProvider {
  readonly name = "instantly";
  readonly campaignId: string;

  constructor() {
    if (process.env.OUTBOUND_SEND_ENABLED !== "1") {
      throw new Error('not configured: OUTBOUND_SEND_ENABLED is not "1"');
    }
    if (process.env.OUTBOUND_PROVIDER !== "instantly") {
      throw new Error('not configured: OUTBOUND_PROVIDER is not "instantly"');
    }
    const missing = ["INSTANTLY_API_KEY", "INSTANTLY_CAMPAIGN_ID"].filter((k) => !process.env[k]);
    if (missing.length > 0) {
      throw new Error(`not configured: missing ${missing.join(", ")}`);
    }
    if (getAllowedDomains().length === 0) {
      throw new Error("not configured: INSTANTLY_ALLOWED_DOMAINS is not set (the workspace may be shared with another tenant)");
    }
    this.campaignId = process.env.INSTANTLY_CAMPAIGN_ID as string;
  }

  /** The exact JSON pushed to Instantly. Only approved, rendered content plus the recipient's identity. */
  static leadBody(campaignId: string, req: SendRequest) {
    return {
      campaignId,
      email: req.toEmail,
      firstName: req.lead?.firstName ?? null,
      lastName: req.lead?.lastName ?? null,
      companyName: req.lead?.companyName ?? null,
      customVariables: { subject: req.subject, body: req.body },
    };
  }

  async send(req: SendRequest): Promise<SendResult> {
    try {
      const { createLead } = await import("../instantly/client");
      const lead = await createLead(InstantlyProvider.leadBody(this.campaignId, req));
      if (!lead.id) {
        return { ok: false, error: "Instantly did not return a lead id (the lead may already be in this campaign)." };
      }
      return { ok: true, providerId: `instantly_lead_${lead.id}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Instantly request failed." };
    }
  }
}

/** Picks the configured provider. Defaults to DryRunProvider on any doubt. */
export function getProvider(): SendProvider {
  // The public demo never sends, whatever the environment says.
  if (process.env.DEAL_DESK_DEMO === "1") return new DryRunProvider();
  if (process.env.OUTBOUND_PROVIDER === "apollo") {
    try {
      return new ApolloProvider();
    } catch {
      return new DryRunProvider();
    }
  }
  if (process.env.OUTBOUND_PROVIDER === "instantly") {
    try {
      return new InstantlyProvider();
    } catch {
      return new DryRunProvider();
    }
  }
  return new DryRunProvider();
}
