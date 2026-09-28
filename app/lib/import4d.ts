// 4Degrees Deal List import: the server half. One CSV from a 4Degrees list
// view becomes buyers on one deal's buyer log, in ONE transaction:
//   - buyer company: found by domain, else exact name (case-insensitive), else
//     created with source '4degrees-import' (the banker is explicitly importing)
//   - primary contact: found or created at that company, never an invented email
//   - buyer row: added through addBuyers(), then moved to the imported stage
//     with one stage-history row, milestones stamped with the Last Interaction date
//   - Notes: one timeline note on the deal, dated the Last Interaction
// Re-importing the same file skips rows already on the log and says so.
// dryRun runs the exact same work and rolls it back: that is the preview.
import { db, audit } from "./db";
import { addBuyers, BuyerError } from "./buyers";
import { syncFromContact } from "./contactCompanies";
import { isValidEmail, parseCsvWithHeader } from "./csv";
import { FORWARD_STAGES, stageRank, type BuyerStage } from "./buyerStages";
import {
  IMPORT_FIELDS,
  normDomain,
  parseDate,
  parseLocation,
  planStage,
  splitName,
  type ImportField,
  type ImportMapping,
} from "./import4dMap";

export const IMPORT_SOURCE = "4degrees-import";
export const MAX_IMPORT_ROWS = 2000;

export type RowResult = {
  row: number; // 1-based data row (the header is row 0)
  company: string;
  contact: string | null;
  stage: BuyerStage | null;
  declined_from_stage: string | null;
  decline_reason: string | null;
  date: string | null;
  action: "created" | "updated" | "skipped";
  messages: string[];
};

export type ImportResult = {
  dry_run: boolean;
  total: number;
  created: number;
  updated: number;
  skipped: number;
  companies_created: number;
  contacts_created: number;
  notes_added: number;
  rows: RowResult[];
};

type Co = { id: number; name: string; domain: string | null; city: string | null; state: string | null };

const nowTs = () => new Date().toISOString().slice(0, 19).replace("T", " ");

export function checkMapping(headers: string[], mapping: ImportMapping): ImportMapping {
  const out: ImportMapping = {};
  for (const f of IMPORT_FIELDS) {
    const h = mapping[f.key as ImportField];
    if (h == null || h === "") continue;
    if (typeof h !== "string" || !headers.includes(h)) throw new BuyerError(`Column "${String(h)}" for ${f.label} is not in the file`);
    out[f.key as ImportField] = h;
  }
  if (!out.company) throw new BuyerError("Pick the column that holds the company name");
  return out;
}

export function importBuyers(dealId: number, csv: string, mappingIn: ImportMapping, userId: number, opts: { dryRun?: boolean } = {}): ImportResult {
  const d = db();
  const deal = d.prepare("SELECT id, company_id FROM deals WHERE id = ?").get(dealId) as { id: number; company_id: number } | undefined;
  if (!deal) throw new BuyerError("Unknown deal", 404);
  const { headers, rows } = parseCsvWithHeader((csv ?? "").replace(/^\uFEFF/, ""));
  if (!headers.length || !rows.length) throw new BuyerError("The file has no rows under its header");
  if (rows.length > MAX_IMPORT_ROWS) throw new BuyerError(`Import is capped at ${MAX_IMPORT_ROWS} rows at a time`);
  const mapping = checkMapping(headers, mappingIn);
  const dryRun = !!opts.dryRun;

  const byDomain = d.prepare("SELECT id, name, domain, city, state FROM companies WHERE domain = ?");
  const byName = d.prepare("SELECT id, name, domain, city, state FROM companies WHERE name = ? COLLATE NOCASE ORDER BY id");
  const insCompany = d.prepare(`INSERT INTO companies (name, domain, city, state, source) VALUES (?, ?, ?, ?, '${IMPORT_SOURCE}')`);
  const setDomain = d.prepare("UPDATE companies SET domain = ?, updated_at = datetime('now') WHERE id = ? AND domain IS NULL");
  const setPlace = d.prepare(
    "UPDATE companies SET city = COALESCE(NULLIF(city, ''), ?), state = COALESCE(NULLIF(state, ''), ?), updated_at = datetime('now') WHERE id = ?"
  );
  const contactByEmail = d.prepare("SELECT id, company_id FROM contacts WHERE email = ?");
  const contactByName = d.prepare(
    `SELECT id FROM contacts WHERE first_name = ? COLLATE NOCASE AND COALESCE(last_name, '') = ? COLLATE NOCASE
       AND (company_id = ? OR id IN (SELECT contact_id FROM contact_companies WHERE company_id = ?)) ORDER BY id LIMIT 1`
  );
  const insContact = d.prepare(
    `INSERT INTO contacts (company_id, first_name, last_name, title, email, source) VALUES (?, ?, ?, ?, ?, '${IMPORT_SOURCE}')`
  );
  const onLog = d.prepare("SELECT id, removed_at FROM deal_buyers WHERE deal_id = ? AND buyer_company_id = ?");

  const result: ImportResult = {
    dry_run: dryRun,
    total: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    companies_created: 0,
    contacts_created: 0,
    notes_added: 0,
    rows: [],
  };
  const now = nowTs();
  const today = now.slice(0, 10);

  type Pending = { res: RowResult; companyId: number; contactId: number | null; when: string; notes: string; outcome: string };
  const pending: Pending[] = [];

  d.exec("BEGIN");
  try {
    const seen = new Map<number, number>();
    rows.forEach((raw, i) => {
      const get = (f: ImportField) => (mapping[f] ? (raw[mapping[f]!] ?? "").trim() : "");
      const name = get("company").replace(/\s+/g, " ");
      const domain = get("domain") ? normDomain(get("domain")) : "";
      const plan = planStage(get("stage"), get("outcome"));
      const res: RowResult = {
        row: i + 1,
        company: name || domain,
        contact: get("contact") || null,
        stage: plan.stage,
        declined_from_stage: plan.declined_from_stage,
        decline_reason: plan.decline_reason,
        date: null,
        action: "skipped",
        messages: [],
      };
      result.rows.push(res);
      if (!name && !domain) {
        if (Object.values(raw).some((x) => x)) res.messages.push("No company name, row skipped");
        else res.messages.push("Blank row");
        return;
      }
      if (plan.warning) res.messages.push(plan.warning);

      // Date: Last Interaction, never in the future.
      let when = now;
      const rawDate = get("last_interaction");
      if (rawDate) {
        const iso = parseDate(rawDate);
        if (!iso) res.messages.push(`Could not read the date "${rawDate}", used today`);
        else if (iso > today) res.messages.push(`Date ${iso} is in the future, used today`);
        else {
          when = `${iso} 12:00:00` < now ? `${iso} 12:00:00` : now;
          res.date = iso;
        }
      }

      // Company.
      let co: Co | undefined = domain ? (byDomain.get(domain) as Co | undefined) : undefined;
      if (!co && name) {
        const hits = byName.all(name) as Co[];
        co = hits[0];
        if (hits.length > 1) res.messages.push(`${hits.length} companies are named "${name}", matched the oldest`);
        if (co && domain && !co.domain) {
          setDomain.run(domain, co.id);
          res.messages.push(`Added website ${domain}`);
        }
      }
      const place = parseLocation(get("location"));
      if (!co) {
        const id = Number(insCompany.run(name || domain, domain || null, place.city, place.state).lastInsertRowid);
        co = { id, name: name || domain, domain: domain || null, city: place.city, state: place.state };
        result.companies_created += 1;
        res.messages.push("New company");
      } else {
        res.company = co.name;
        if ((place.city && !co.city) || (place.state && !co.state)) setPlace.run(place.city, place.state, co.id);
      }
      if (co.id === deal.company_id) {
        res.messages.push("This is the company being sold, row skipped");
        return;
      }
      const dupOf = seen.get(co.id);
      if (dupOf) {
        res.messages.push(`Same company as row ${dupOf}, row skipped`);
        return;
      }
      seen.set(co.id, res.row);

      // Primary contact at that company.
      let contactId: number | null = null;
      const email = get("contact_email").toLowerCase();
      const nm = splitName(get("contact"));
      if (email && isValidEmail(email)) {
        const hit = contactByEmail.get(email) as { id: number; company_id: number | null } | undefined;
        if (hit) contactId = hit.id;
      } else if (email) res.messages.push(`Ignored email "${email}", it does not look valid`);
      if (!contactId && nm.first) {
        const hit = contactByName.get(nm.first, nm.last ?? "", co.id, co.id) as { id: number } | undefined;
        if (hit) contactId = hit.id;
      }
      if (!contactId && nm.first) {
        contactId = Number(
          insContact.run(co.id, nm.first, nm.last, get("contact_title") || null, email && isValidEmail(email) ? email : null).lastInsertRowid
        );
        syncFromContact(contactId);
        result.contacts_created += 1;
        res.messages.push(`New contact ${[nm.first, nm.last].filter(Boolean).join(" ")}`);
      }

      const existing = onLog.get(dealId, co.id) as { id: number; removed_at: string | null } | undefined;
      if (existing && !existing.removed_at) {
        res.messages.push("Already on the buyer log, skipped");
        return;
      }
      pending.push({ res, companyId: co.id, contactId, when, notes: get("notes"), outcome: get("outcome") });
    });

    const restored = new Set<number>();
    if (pending.length) {
      const added = addBuyers(
        dealId,
        pending.map((p) => ({ buyer_company_id: p.companyId, lead_contact_id: p.contactId })),
        userId
      );
      for (const id of added.restored) restored.add(id);
    }

    const insHistory = d.prepare(
      "INSERT INTO deal_buyer_stage_history (deal_buyer_id, from_stage, to_stage, note, changed_by) VALUES (?, ?, ?, ?, ?)"
    );
    const insRevision = d.prepare(
      "INSERT INTO deal_buyer_revisions (deal_buyer_id, field, old_value, new_value, changed_by) VALUES (?, 'decline_reason', ?, ?, ?)"
    );
    const insNote = d.prepare("INSERT INTO activities (kind, body, deal_id, user_id, created_at) VALUES ('note', ?, ?, ?, ?)");

    for (const p of pending) {
      const row = d.prepare("SELECT * FROM deal_buyers WHERE deal_id = ? AND buyer_company_id = ?").get(dealId, p.companyId) as Record<string, unknown>;
      const buyerId = Number(row.id);
      const wasRestored = restored.has(buyerId);
      p.res.action = wasRestored ? "updated" : "created";
      if (wasRestored) p.res.messages.push("Was removed from this log earlier, restored");
      // A row created a moment ago in this same transaction: its teaser stamp
      // takes the date from the file instead of today. History rows are never
      // rewritten; they keep the time the import was recorded.
      else d.prepare("UPDATE deal_buyers SET teaser_sent_at = ? WHERE id = ?").run(p.when, buyerId);
      const plan = { stage: p.res.stage as BuyerStage, from: p.res.declined_from_stage as BuyerStage | null, reason: p.res.decline_reason };
      const reachedStage = plan.stage === "declined" ? plan.from ?? "teaser_sent" : plan.stage;
      const sets: string[] = [];
      const vals: (string | number | null)[] = [];
      for (const s of FORWARD_STAGES.slice(0, stageRank(reachedStage) + 1)) {
        sets.push(`${s}_at = COALESCE(${s}_at, ?)`);
        vals.push(p.when);
      }
      const current = row.stage as BuyerStage;
      if (plan.stage !== current) {
        sets.push("stage = ?", "updated_at = datetime('now')");
        vals.push(plan.stage);
        if (plan.stage === "declined") {
          sets.push("declined_at = COALESCE(declined_at, ?)", "declined_from_stage = ?", "decline_reason = ?");
          vals.push(p.when, plan.from ?? "teaser_sent", plan.reason);
          insRevision.run(buyerId, (row.decline_reason as string | null) ?? null, plan.reason, userId);
        } else if (current === "declined") {
          sets.push("declined_from_stage = NULL");
        }
        insHistory.run(
          buyerId,
          current,
          plan.stage,
          `Imported from 4Degrees${p.res.date ? ` (last interaction ${p.res.date})` : ""}${plan.stage === "declined" ? `: ${plan.reason}` : ""}`,
          userId
        );
      }
      if (sets.length) d.prepare(`UPDATE deal_buyers SET ${sets.join(", ")} WHERE id = ?`).run(...vals, buyerId);

      const outcomeLine = plan.stage !== "declined" && p.outcome ? `Outcome: ${p.outcome}` : "";
      // Windows exports carry CRLF inside quoted cells; store plain newlines.
      const body = [p.notes, outcomeLine].filter(Boolean).join("\n").replace(/\r\n?/g, "\n");
      if (body) {
        insNote.run(`${p.res.company}: ${body}`.slice(0, 5000), dealId, userId, p.when);
        result.notes_added += 1;
      }
    }

    for (const r of result.rows) {
      if (r.action === "created") result.created += 1;
      else if (r.action === "updated") result.updated += 1;
      else result.skipped += 1;
    }
    if (!dryRun) {
      audit({
        actorUserId: userId,
        action: "deal.import_4degrees",
        entity: "deal",
        entityId: dealId,
        detail: {
          rows: result.total,
          created: result.created,
          updated: result.updated,
          skipped: result.skipped,
          companies_created: result.companies_created,
          contacts_created: result.contacts_created,
          notes_added: result.notes_added,
        },
      });
    }
    d.exec(dryRun ? "ROLLBACK" : "COMMIT");
  } catch (err) {
    if (d.isTransaction) d.exec("ROLLBACK");
    throw err;
  }
  return result;
}

