"use client";
// "As a buyer" on a company page: the buyer profile (type, check size,
// EBITDA fit, thesis) and cross-deal buyer memory, one plain sentence per
// process this company was shown ("Declined after CIM sent on Alpha: valuation gap").
import { useState } from "react";
import Link from "next/link";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";
import { FieldInput, inputClass } from "../crm/Field";
import { formatMoney, parseMoney } from "../../lib/dealMath";
import { BUYER_TYPES, BUYER_TYPE_LABELS, type BuyerType } from "../../lib/buyerStages";
import type { BuyerHistoryRow } from "../../lib/buyers";
import { ioiText, stageText } from "./format";

export type BuyerProfile = {
  buyer_type: BuyerType;
  check_size_low: number | null;
  check_size_high: number | null;
  ebitda_fit_low: number | null;
  ebitda_fit_high: number | null;
  thesis: string | null;
};

const range = (lo: number | null, hi: number | null) =>
  lo == null && hi == null ? null : lo != null && hi != null ? `${formatMoney(lo)} to ${formatMoney(hi)}` : lo != null ? `${formatMoney(lo)}+` : `up to ${formatMoney(hi)}`;

const moneyText = (n: number | null) => (n == null ? "" : n.toLocaleString("en-US"));

export function historySentence(r: BuyerHistoryRow): string {
  const year = r.updated_at.slice(0, 4);
  const where = `${r.seller_name} (${year})`;
  if (r.stage === "declined") return `${stageText(r)} on ${where}${r.decline_reason ? `: ${r.decline_reason.toLowerCase()}` : ""}`;
  const bid = r.loi_value != null ? `, LOI ${formatMoney(r.loi_value)}` : ioiText(r) ? `, IOI ${ioiText(r)}` : "";
  return `${stageText(r)} on ${where}${bid}`;
}

export default function BuyerPanel({ companyId, profile: initial, history }: { companyId: number; profile: BuyerProfile | null; history: BuyerHistoryRow[] }) {
  const [profile, setProfile] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    buyer_type: initial?.buyer_type ?? "pe",
    check_size_low: moneyText(initial?.check_size_low ?? null),
    check_size_high: moneyText(initial?.check_size_high ?? null),
    ebitda_fit_low: moneyText(initial?.ebitda_fit_low ?? null),
    ebitda_fit_high: moneyText(initial?.ebitda_fit_high ?? null),
    thesis: initial?.thesis ?? "",
  });
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const money = ["check_size_low", "check_size_high", "ebitda_fit_low", "ebitda_fit_high"] as const;
    const body: Record<string, unknown> = { buyer_type: form.buyer_type, thesis: form.thesis };
    for (const k of money) {
      const v = parseMoney(form[k]);
      if (v != null && Number.isNaN(v)) {
        setError("Amounts take 12.5M, 750K or 1,200,000.");
        return;
      }
      body[k] = v;
    }
    const res = await fetch(`/api/companies/${companyId}/buyer-profile`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = await res?.json().catch(() => null);
    if (!res?.ok) {
      setError(d?.error ?? "Could not save the buyer profile.");
      return;
    }
    setProfile(d.profile);
    setEditing(false);
    setError(null);
  }

  if (!profile && !history.length && !editing) {
    return (
      <Panel title="As a buyer">
        <p className="text-sm text-[var(--ink-soft)]">Not profiled as a buyer and never shown a deal.</p>
        <div className="mt-3">
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            Add buyer profile
          </Button>
        </div>
      </Panel>
    );
  }

  return (
    <Panel
      title="As a buyer"
      actions={
        editing ? undefined : (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            {profile ? "Edit" : "Add profile"}
          </Button>
        )
      }
    >
      {editing ? (
        <div className="space-y-3">
          <FieldInput label="Buyer type" htmlFor="bp-type">
            <select id="bp-type" value={form.buyer_type} onChange={(e) => setForm({ ...form, buyer_type: e.target.value as BuyerType })} className={inputClass}>
              {BUYER_TYPES.map((t) => (
                <option key={t} value={t}>
                  {BUYER_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </FieldInput>
          <div className="grid grid-cols-2 gap-2">
            <FieldInput label="Check size from" htmlFor="bp-cl">
              <input id="bp-cl" value={form.check_size_low} onChange={(e) => setForm({ ...form, check_size_low: e.target.value })} className={inputClass} />
            </FieldInput>
            <FieldInput label="to" htmlFor="bp-ch">
              <input id="bp-ch" value={form.check_size_high} onChange={(e) => setForm({ ...form, check_size_high: e.target.value })} className={inputClass} />
            </FieldInput>
            <FieldInput label="EBITDA fit from" htmlFor="bp-el">
              <input id="bp-el" value={form.ebitda_fit_low} onChange={(e) => setForm({ ...form, ebitda_fit_low: e.target.value })} className={inputClass} />
            </FieldInput>
            <FieldInput label="to" htmlFor="bp-eh">
              <input id="bp-eh" value={form.ebitda_fit_high} onChange={(e) => setForm({ ...form, ebitda_fit_high: e.target.value })} className={inputClass} />
            </FieldInput>
          </div>
          <FieldInput label="Thesis" htmlFor="bp-thesis" hint="What they buy and why: platform search, add-on thesis, sectors">
            <textarea id="bp-thesis" rows={3} value={form.thesis} onChange={(e) => setForm({ ...form, thesis: e.target.value })} className={`${inputClass} h-auto py-2`} />
          </FieldInput>
          {error && <div className="text-sm text-[var(--bad)]">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      ) : (
        profile && (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <Item label="Type" value={BUYER_TYPE_LABELS[profile.buyer_type]} />
            <Item label="Check size" value={range(profile.check_size_low, profile.check_size_high)} />
            <Item label="EBITDA fit" value={range(profile.ebitda_fit_low, profile.ebitda_fit_high)} />
            {profile.thesis && (
              <div className="col-span-2 rounded-[12px] bg-[var(--paper)] px-3 py-2">
                <dt className="text-[12px] font-semibold text-[var(--ink-soft)]">Thesis</dt>
                <dd className="mt-0.5 text-[var(--ink)]">{profile.thesis}</dd>
              </div>
            )}
          </dl>
        )
      )}

      {history.length > 0 && (
        <div className={profile || editing ? "mt-4 border-t border-[var(--rule)] pt-4" : ""}>
          <h3 className="mb-2 text-[13px] font-bold text-[var(--ink)]">
            Shown {history.length} {history.length === 1 ? "deal" : "deals"}
          </h3>
          <ul className="space-y-2 text-sm">
            {history.map((r) => (
              <li key={r.id}>
                <Link href={`/pipeline/${r.deal_id}`} className="text-[var(--ink)] hover:underline">
                  {historySentence(r)}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

function Item({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="rounded-[12px] bg-[var(--paper)] px-3 py-2">
      <dt className="text-[12px] font-semibold text-[var(--ink-soft)]">{label}</dt>
      <dd className="mt-0.5 font-bold text-[var(--ink)]">{value ?? <span className="font-normal text-[var(--ink-faint)]">Not set</span>}</dd>
    </div>
  );
}
