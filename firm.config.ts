// The ONLY file that names a firm. Everything reusable reads from here,
// so the harness can be re-skinned for another bank by swapping this file.
//
// The hosted public demo (DEAL_DESK_DEMO=1) is meant to greet and sign as
// whoever is showing it, without that name ever landing in the public repo's
// code. DEMO_OWNER_NAME / DEMO_OWNER_TITLE env vars (set on the Vercel
// project, never committed) override the sender name/title below, but only
// when DEAL_DESK_DEMO=1 -- a normal production deploy always uses the
// defaults. isDemo() lives in app/lib/demo-policy.ts specifically because it
// has no Node imports, so it is safe to pull in from this config file too.
import { isDemo } from "./app/lib/demo-policy";

function demoOverride(envVar: "DEMO_OWNER_NAME" | "DEMO_OWNER_TITLE", fallback: string): string {
  if (!isDemo()) return fallback;
  const v = process.env[envVar];
  return v && v.trim() ? v.trim() : fallback;
}

export type Segment = {
  id: string;
  label: string;
  kind: "owner" | "institution" | "referral";
  description: string;
};

export const firm = {
  name: "Your Firm Capital",
  shortName: "Your Firm",
  productName: "Deal Desk",
  builtBy: "Wing Digital", // vendor credit on the sign-in screen
  regulated: true, // FINRA member: outbound content needs principal pre-approval
  sender: {
    name: demoOverride("DEMO_OWNER_NAME", "Jordan Hale"),
    title: demoOverride("DEMO_OWNER_TITLE", "Managing Director"),
  },
  // Deal pipeline stages, in order.
  dealStages: [
    "Sourced",
    "Contacted",
    "In Dialogue",
    "NDA",
    "Engaged",
    "In Market",
    "LOI",
    "Closed",
    "Passed",
  ],
  // Default close probability (0-100) per stage, used for the weighted fee
  // forecast only when a deal has no probability of its own. The UI labels it
  // "stage default" so nobody mistakes it for the banker's read.
  stageProbability: {
    Sourced: 5,
    Contacted: 10,
    "In Dialogue": 15,
    NDA: 20,
    Engaged: 40,
    "In Market": 55,
    LOI: 75,
    Closed: 100,
    Passed: 0,
  } as Record<string, number>,
  // Stages that end a deal: excluded from open-pipeline sums and reminders.
  closedStages: ["Closed", "Passed"],
  // Target segments are configurable because the mandate is mixed:
  // founder-owned companies, financial institutions, and referral sources.
  segments: [
    { id: "owners", label: "Founder-owned companies", kind: "owner", description: "Privately held operating companies that fit the corporate M&A screen." },
    { id: "institutions", label: "Banks and credit unions", kind: "institution", description: "Community banks, credit unions and their holding companies." },
    { id: "referrals", label: "Referral sources", kind: "referral", description: "CPAs, succession attorneys, wealth managers and lenders who sit next to owners." },
  ] as Segment[],
  // Required on every commercial email (CAN-SPAM): a real postal address and a working way to opt out.
  mailingAddress: "100 Main Street, Suite 100, Anytown, TX 75000",
  outbound: {
    // Appended to every message. It is part of the approved content: changing it voids approvals.
    // {{unsubscribe_url}} is the only field allowed here and is filled per recipient.
    footer:
      "{{firm_name}}, {{mailing_address}}\nIf you would rather not hear from me again, let me know here and I will not write again: {{unsubscribe_url}}",
    weeklyTarget: 1500,
    // Per-mailbox daily caps by warmup week. Volume comes from adding
    // mailboxes, never from pushing one mailbox past a safe ceiling.
    warmupRampPerMailbox: [5, 10, 15, 20, 30, 40],
    maxPerMailboxPerDay: 40,
    sendDays: [1, 2, 3, 4, 5], // Mon-Fri
  },
  voiceRules: {
    // Hard fails: a draft containing these cannot be submitted for approval.
    forbiddenPatterns: [
      { id: "fees", pattern: "\\b(fee|fees|retainer|success fee|commission|percent of|% of)\\b", why: "Fees are spoken, never written." },
      { id: "sim", pattern: "\\bSIM\\b", why: "It is a CIM, never a SIM." },
      { id: "promise", pattern: "\\b(guarantee|guaranteed|we can get you|will sell for|worth at least)\\b", why: "No performance or valuation promises." },
      { id: "ease", pattern: "\\b(just|simply|easily|hand them)\\b", why: "Never imply something is easy." },
      { id: "emdash", pattern: "\\u2014", why: "No em dashes in any copy." },
    ],
  },
} as const;

export type Firm = typeof firm;
