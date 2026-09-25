"use client";
// Deal economics panel: EBITDA, enterprise value, fee terms and the close
// forecast, with the expected and weighted fee worked out live from the same
// pure math the pipeline header uses (app/lib/dealMath.ts).
import { useState } from "react";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";
import { FieldInput, inputClass } from "../crm/Field";
import {
  effectiveProbability,
  evFromMultiple,
  expectedFee,
  formatMoney,
  multipleOf,
  parseMoney,
  weightedFee,
  type StageDefaults,
} from "../../lib/dealMath";
import type { Deal } from "./types";

// Inputs show the exact stored amount; the rounded "$12.3M" form is for display only.
const moneyText = (n: number | null | undefined) => (n == null ? "" : n.toLocaleString("en-US"));
const numText = (n: number | null | undefined) => (n == null ? "" : String(n));

export default function DealEconomics({ deal, cfg, onSaved }: { deal: Deal; cfg: StageDefaults; onSaved: (d: Partial<Deal>) => void }) {
  const [ebitda, setEbitda] = useState(moneyText(deal.ebitda));
  const [ev, setEv] = useState(moneyText(deal.enterprise_value));
  const [multiple, setMultiple] = useState(numText(multipleOf(deal.enterprise_value ?? null, deal.ebitda ?? null)));
  const [retainer, setRetainer] = useState(moneyText(deal.retainer));
  const [pct, setPct] = useState(numText(deal.success_fee_pct));
  const [probability, setProbability] = useState(numText(deal.probability));
  const [expectedClose, setExpectedClose] = useState(deal.expected_close ?? "");
  const [feeTerms, setFeeTerms] = useState(deal.fee_terms ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = {
    ebitda: parseMoney(ebitda),
    enterprise_value: parseMoney(ev),
    retainer: parseMoney(retainer),
    success_fee_pct: pct.trim() === "" ? null : Number(pct),
    probability: probability.trim() === "" ? null : Number(probability),
  };
  const bad = Object.entries(parsed).find(([, val]) => val != null && Number.isNaN(val));

  const dirty =
    parsed.ebitda !== (deal.ebitda ?? null) ||
    parsed.enterprise_value !== (deal.enterprise_value ?? null) ||
    parsed.retainer !== (deal.retainer ?? null) ||
    parsed.success_fee_pct !== (deal.success_fee_pct ?? null) ||
    parsed.probability !== (deal.probability ?? null) ||
    expectedClose !== (deal.expected_close ?? "") ||
    feeTerms.trim() !== (deal.fee_terms ?? "");

  const live = { stage: deal.stage, ...parsed };
  const fee = bad ? null : expectedFee(live);
  const weighted = bad ? null : weightedFee(live, cfg);
  const prob = effectiveProbability(live, cfg);
  const liveMultiple = multipleOf(parsed.enterprise_value, parsed.ebitda);

  // EBITDA, multiple and EV move together (EV = EBITDA x multiple), so a new
  // EBITDA reprices EV and every fee on it at the same multiple.
  function changeEbitda(text: string) {
    setEbitda(text);
    const next = evFromMultiple(parseMoney(text), multiple.trim() ? Number(multiple) : null);
    if (next != null) setEv(moneyText(next));
  }
  function changeMultiple(text: string) {
    setMultiple(text);
    const next = evFromMultiple(parseMoney(ebitda), text.trim() ? Number(text) : null);
    if (next != null) setEv(moneyText(next));
  }
  function changeEv(text: string) {
    setEv(text);
    const m = multipleOf(parseMoney(text), parseMoney(ebitda));
    if (m != null) setMultiple(String(m));
  }

  async function save() {
    if (bad) {
      setError("Check the highlighted amounts. Use numbers like 12.5M, 750K or 1,200,000.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/deals/${deal.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...parsed, expected_close: expectedClose, fee_terms: feeTerms }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not save.");
        return;
      }
      onSaved(data.item);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  const badKey = bad?.[0];
  const moneyHint = "Type 12.5M, 750K or 1,200,000";

  return (
    <Panel
      title="Economics"
      actions={dirty ? <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save"}</Button> : undefined}
    >
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Expected fee" value={fee == null ? "Not set" : formatMoney(fee)} />
        <Stat
          label="Weighted fee"
          value={weighted == null ? "Not set" : formatMoney(weighted)}
          note={prob.source === "stage" ? `${prob.value}% stage default` : `${prob.value}% your read`}
        />
        <Stat label="EV / EBITDA" value={liveMultiple != null ? `${liveMultiple.toFixed(1)}x` : "Not set"} />
        <Stat
          label="Expected close"
          value={expectedClose ? new Date(expectedClose + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "Not set"}
        />
      </div>
      {error && <div className="mb-3 text-sm text-[var(--bad)]">{error}</div>}
      <div className="grid gap-3 sm:grid-cols-2">
        <FieldInput label="EBITDA (trailing)" htmlFor="econ-ebitda" hint={moneyHint} error={badKey === "ebitda" ? "Not a readable amount" : undefined}>
          <input id="econ-ebitda" inputMode="decimal" value={ebitda} onChange={(e) => changeEbitda(e.target.value)} className={inputClass} />
        </FieldInput>
        <FieldInput label="Multiple (x EBITDA)" htmlFor="econ-multiple" hint="Change EBITDA or the multiple and EV follows">
          <input id="econ-multiple" type="number" min={0} step="0.1" value={multiple} onChange={(e) => changeMultiple(e.target.value)} className={inputClass} />
        </FieldInput>
        <FieldInput label="Enterprise value" htmlFor="econ-ev" hint="Type EV directly and the multiple follows" error={badKey === "enterprise_value" ? "Not a readable amount" : undefined}>
          <input id="econ-ev" inputMode="decimal" value={ev} onChange={(e) => changeEv(e.target.value)} className={inputClass} />
        </FieldInput>
        <FieldInput label="Retainer" htmlFor="econ-retainer" hint="Total retainer for the engagement" error={badKey === "retainer" ? "Not a readable amount" : undefined}>
          <input id="econ-retainer" inputMode="decimal" value={retainer} onChange={(e) => setRetainer(e.target.value)} className={inputClass} />
        </FieldInput>
        <FieldInput label="Success fee %" htmlFor="econ-pct" hint="Percent of enterprise value, e.g. 3.5" error={badKey === "success_fee_pct" ? "Not a number" : undefined}>
          <input id="econ-pct" type="number" min={0} max={100} step="0.1" value={pct} onChange={(e) => setPct(e.target.value)} className={inputClass} />
        </FieldInput>
        <FieldInput label="Probability to close %" htmlFor="econ-prob" hint="Leave blank to use the stage default" error={badKey === "probability" ? "Not a number" : undefined}>
          <input id="econ-prob" type="number" min={0} max={100} step="5" value={probability} onChange={(e) => setProbability(e.target.value)} className={inputClass} />
        </FieldInput>
        <FieldInput label="Expected close" htmlFor="econ-close">
          <input id="econ-close" type="date" value={expectedClose} onChange={(e) => setExpectedClose(e.target.value)} className={inputClass} />
        </FieldInput>
        <div className="sm:col-span-2">
          <FieldInput label="Fee terms" htmlFor="econ-terms" hint="Internal only. Never shown in outbound email.">
            <textarea
              id="econ-terms"
              rows={2}
              value={feeTerms}
              onChange={(e) => setFeeTerms(e.target.value)}
              className={`${inputClass} h-auto py-2`}
              placeholder="Minimum fee, tail period, retainer credit"
            />
          </FieldInput>
        </div>
      </div>
    </Panel>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-[12px] bg-[var(--paper)] px-3.5 py-2.5">
      <div className="text-[12px] font-semibold text-[var(--ink-soft)]">{label}</div>
      <div className="numeric mt-0.5 text-[17px] font-bold text-[var(--ink)]">{value}</div>
      {note && <div className="mt-0.5 text-[11px] text-[var(--ink-faint)]">{note}</div>}
    </div>
  );
}
