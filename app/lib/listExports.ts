// One sheet per list (P3). Each builder reads the same filters as its list
// page, so an export holds exactly what the banker is looking at, and every
// cell goes through app/lib/export.ts (formula-safe CSV, hand-built XLSX).
import { db } from "./db";
import type { Column, Sheet } from "./export";
import { companyFiltersFrom, companyWhere, contactFiltersFrom, contactWhere } from "./listFilters";
import { effectiveProbability, expectedFee, weightedFee } from "./dealMath";
import { referralSources, type ReferralSource } from "./referrals";
import { referralKindLabel } from "./referralKinds";
import { firm } from "../../firm.config";

export const EXPORT_ENTITIES = ["companies", "contacts", "deals", "tasks", "referrals"] as const;
export type ExportEntityName = (typeof EXPORT_ENTITIES)[number];
export const isExportEntity = (s: string): s is ExportEntityName => (EXPORT_ENTITIES as readonly string[]).includes(s);

type Get = (k: string) => string | null;
const segmentLabel = (id: string | null) => firm.segments.find((s) => s.id === id)?.label ?? id;
const personName = (r: { first_name: string | null; last_name: string | null }) => [r.first_name, r.last_name].filter(Boolean).join(" ");
const cfg = { stageProbability: firm.stageProbability, closedStages: firm.closedStages };

type CompanyRow = {
  id: number; name: string; domain: string | null; segment_id: string; industry: string | null; city: string | null; state: string | null;
  employees: number | null; revenue_band: string | null; source: string; signal_score: number; created_at: string; updated_at: string;
};
function companies(get: Get): Sheet<CompanyRow> {
  const w = companyWhere(companyFiltersFrom(get));
  const rows = db().prepare(`SELECT * FROM companies ${w.sql} ORDER BY name COLLATE NOCASE, id`).all(...w.params) as CompanyRow[];
  const columns: Column<CompanyRow>[] = [
    { key: "id", label: "ID", value: (r) => r.id },
    { key: "name", label: "Company", value: (r) => r.name },
    { key: "domain", label: "Website", value: (r) => r.domain },
    { key: "segment", label: "Segment", value: (r) => segmentLabel(r.segment_id) },
    { key: "industry", label: "Industry", value: (r) => r.industry },
    { key: "city", label: "City", value: (r) => r.city },
    { key: "state", label: "State", value: (r) => r.state },
    { key: "employees", label: "Employees", value: (r) => r.employees, numFmt: "integer" },
    { key: "revenue_band", label: "Revenue band", value: (r) => r.revenue_band },
    { key: "source", label: "Source", value: (r) => r.source },
    { key: "signal_score", label: "Signal score", value: (r) => r.signal_score },
    { key: "updated_at", label: "Updated", value: (r) => r.updated_at },
  ];
  return { name: "Companies", columns, rows };
}

type ContactRow = {
  id: number; first_name: string | null; last_name: string | null; title: string | null; email: string | null; email_status: string | null;
  phone: string | null; linkedin_url: string | null; do_not_contact: number; referral_kind: string | null; touch_every_days: number | null;
  company_name: string | null; company_segment_id: string | null; last_touch: string | null;
};
function contacts(get: Get): Sheet<ContactRow> {
  const w = contactWhere(contactFiltersFrom(get));
  const rows = db()
    .prepare(
      `SELECT contacts.*, companies.name AS company_name, companies.segment_id AS company_segment_id,
              (SELECT MAX(a.created_at) FROM activities a WHERE a.contact_id = contacts.id) AS last_touch
       FROM contacts LEFT JOIN companies ON companies.id = contacts.company_id
       ${w.sql} ORDER BY contacts.last_name COLLATE NOCASE, contacts.first_name COLLATE NOCASE, contacts.id`
    )
    .all(...w.params) as ContactRow[];
  const columns: Column<ContactRow>[] = [
    { key: "id", label: "ID", value: (r) => r.id },
    { key: "first_name", label: "First name", value: (r) => r.first_name },
    { key: "last_name", label: "Last name", value: (r) => r.last_name },
    { key: "title", label: "Title", value: (r) => r.title },
    { key: "company", label: "Company", value: (r) => r.company_name },
    { key: "segment", label: "Segment", value: (r) => (r.company_segment_id ? segmentLabel(r.company_segment_id) : null) },
    { key: "email", label: "Email", value: (r) => r.email },
    { key: "email_status", label: "Email status", value: (r) => r.email_status },
    { key: "phone", label: "Phone", value: (r) => r.phone },
    { key: "linkedin_url", label: "LinkedIn", value: (r) => r.linkedin_url },
    { key: "do_not_contact", label: "Do not contact", value: (r) => (r.do_not_contact ? "Yes" : "No") },
    { key: "referral_kind", label: "Referral kind", value: (r) => (r.referral_kind ? referralKindLabel(r.referral_kind) : null) },
    { key: "touch_every_days", label: "Touch every (days)", value: (r) => r.touch_every_days },
    { key: "last_touch", label: "Last touch", value: (r) => r.last_touch },
  ];
  return { name: "Contacts", columns, rows };
}

type DealRow = {
  id: number; title: string; stage: string; situation: string | null; company_name: string; next_step: string | null; next_step_due: string | null;
  retainer: number | null; success_fee_pct: number | null; ebitda: number | null; enterprise_value: number | null; probability: number | null;
  expected_close: string | null; fee_terms: string | null; owner_name: string | null; referral_first: string | null; referral_last: string | null;
  created_at: string; updated_at: string;
};
function deals(): Sheet<DealRow> {
  const rows = (
    db()
      .prepare(
        `SELECT d.*, co.name AS company_name, u.name AS owner_name, r.first_name AS referral_first, r.last_name AS referral_last
         FROM deals d JOIN companies co ON co.id = d.company_id
         LEFT JOIN users u ON u.id = d.owner_user_id
         LEFT JOIN contacts r ON r.id = d.referral_contact_id
         ORDER BY d.id`
      )
      .all() as DealRow[]
    // Pipeline order: stage as configured, then oldest deal first.
  ).sort((a, b) => firm.dealStages.indexOf(a.stage as never) - firm.dealStages.indexOf(b.stage as never) || a.id - b.id);
  const columns: Column<DealRow>[] = [
    { key: "id", label: "ID", value: (r) => r.id },
    { key: "title", label: "Deal", value: (r) => r.title },
    { key: "company", label: "Company", value: (r) => r.company_name },
    { key: "stage", label: "Stage", value: (r) => r.stage },
    { key: "situation", label: "Situation", value: (r) => r.situation },
    { key: "ebitda", label: "EBITDA", value: (r) => r.ebitda, numFmt: "integer" },
    { key: "enterprise_value", label: "Enterprise value", value: (r) => r.enterprise_value, numFmt: "integer" },
    { key: "retainer", label: "Retainer", value: (r) => r.retainer, numFmt: "integer" },
    { key: "success_fee_pct", label: "Success fee %", value: (r) => r.success_fee_pct },
    { key: "expected_fee", label: "Expected fee", value: (r) => expectedFee(r), numFmt: "integer" },
    { key: "probability", label: "Probability %", value: (r) => effectiveProbability(r, cfg).value },
    { key: "probability_source", label: "Probability from", value: (r) => (effectiveProbability(r, cfg).source === "deal" ? "Deal" : "Stage default") },
    { key: "weighted_fee", label: "Weighted fee", value: (r) => weightedFee(r, cfg), numFmt: "integer" },
    { key: "expected_close", label: "Expected close", value: (r) => r.expected_close },
    { key: "fee_terms", label: "Fee terms", value: (r) => r.fee_terms },
    { key: "sourced_by", label: "Sourced by", value: (r) => personName({ first_name: r.referral_first, last_name: r.referral_last }) || null },
    { key: "owner", label: "Owner", value: (r) => r.owner_name },
    { key: "next_step", label: "Next step", value: (r) => r.next_step },
    { key: "next_step_due", label: "Next step due", value: (r) => r.next_step_due },
    { key: "updated_at", label: "Updated", value: (r) => r.updated_at },
  ];
  return { name: "Deals", columns, rows };
}

type TaskRow = {
  id: number; title: string; due: string | null; done: number; deal_title: string | null; contact_first: string | null; contact_last: string | null; created_at: string;
};
function tasks(): Sheet<TaskRow> {
  const rows = db()
    .prepare(
      `SELECT t.id, t.title, t.due, t.done, t.created_at, d.title AS deal_title, c.first_name AS contact_first, c.last_name AS contact_last
       FROM tasks t LEFT JOIN deals d ON d.id = t.deal_id LEFT JOIN contacts c ON c.id = t.contact_id
       ORDER BY t.done, (t.due IS NULL), t.due, t.id`
    )
    .all() as TaskRow[];
  const columns: Column<TaskRow>[] = [
    { key: "id", label: "ID", value: (r) => r.id },
    { key: "title", label: "Task", value: (r) => r.title },
    { key: "due", label: "Due", value: (r) => r.due },
    { key: "done", label: "Done", value: (r) => (r.done ? "Yes" : "No") },
    { key: "deal", label: "Deal", value: (r) => r.deal_title },
    { key: "contact", label: "Contact", value: (r) => personName({ first_name: r.contact_first, last_name: r.contact_last }) || null },
    { key: "created_at", label: "Created", value: (r) => r.created_at },
  ];
  return { name: "Tasks", columns, rows };
}

function referrals(): Sheet<ReferralSource> {
  const columns: Column<ReferralSource>[] = [
    { key: "id", label: "Contact ID", value: (r) => r.contact_id },
    { key: "name", label: "Name", value: (r) => personName(r) },
    { key: "firm", label: "Firm", value: (r) => r.firm_name },
    { key: "kind", label: "Kind", value: (r) => (r.referral_kind ? referralKindLabel(r.referral_kind) : null) },
    { key: "deals_sourced", label: "Deals sourced", value: (r) => r.deals_sourced },
    { key: "open", label: "Open", value: (r) => r.open },
    { key: "won", label: "Closed", value: (r) => r.won },
    { key: "lost", label: "Passed", value: (r) => r.lost },
    { key: "won_fees", label: "Closed-deal fees", value: (r) => (r.won ? r.won_fees : null), numFmt: "integer" },
    { key: "last_touch", label: "Last touch", value: (r) => r.last_touch },
    { key: "touch_every_days", label: "Touch every (days)", value: (r) => r.touch_every_days },
  ];
  return { name: "Referral sources", columns, rows: referralSources() };
}

export function buildExport(entity: ExportEntityName, get: Get): { filename: string; sheet: Sheet<unknown> } {
  const date = new Date().toISOString().slice(0, 10);
  const sheet =
    entity === "companies"
      ? companies(get)
      : entity === "contacts"
        ? contacts(get)
        : entity === "deals"
          ? deals()
          : entity === "tasks"
            ? tasks()
            : referrals();
  const stem = entity === "referrals" ? "referral-sources" : entity;
  return { filename: `${stem}-${date}`, sheet: sheet as Sheet<unknown> };
}
