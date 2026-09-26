"use client";
// P5 BANK / FIG: regulatory approval tracker on a deal. Off by default; a bank
// or credit union deal turns it on. Filings per regulator with the six
// milestone dates, suggested dates shown beside empty fields (never saved until
// the banker clicks Use and then Save), a timeline strip and the shareholder
// votes. Every change goes through /api/deals/[id]/regulatory, which audits it.
import { useState } from "react";
import Panel from "../ui/Panel";
import { Button } from "../ui/Button";
import Select from "../ui/Select";
import DateInput from "../ui/DateInput";
import StatusLabel, { type StatusKind } from "../ui/StatusLabel";
import ConfirmDialog from "../ui/ConfirmDialog";
import { inputClass } from "../crm/Field";
import { todayISO } from "../pipeline/dateUtils";
import RegulatoryTimeline from "./RegulatoryTimeline";
import {
  FILING_DATE_FIELDS,
  FILING_DATE_LABELS,
  FILING_STATUSES,
  FILING_STATUS_LABELS,
  GUIDANCE,
  REGULATORS,
  REGULATOR_LABELS,
  VOTE_DATE_FIELDS,
  VOTE_DATE_LABELS,
  VOTE_PARTIES,
  VOTE_PARTY_LABELS,
  VOTE_RESULTS,
  VOTE_RESULT_LABELS,
  filingLabel,
  orderingError,
  shortDate,
  suggestions,
  type Filing,
  type FilingDateField,
  type FilingStatus,
  type Regulator,
  type ShareholderVote,
  type VoteParty,
  type VoteResult,
} from "../../lib/regulatory";

type Data = { fig_track: number; filings: Filing[]; votes: ShareholderVote[] };
type Send = (method: string, body?: Record<string, unknown>, query?: string) => Promise<{ ok: boolean; error?: string; field?: string }>;

const STATUS_KIND: Record<FilingStatus, StatusKind> = {
  preparing: "none",
  filed: "info",
  accepted: "info",
  approved: "ok",
  withdrawn: "none",
  denied: "stop",
};
const RESULT_KIND: Record<VoteResult, StatusKind> = { pending: "info", approved: "ok", rejected: "stop" };

export default function RegulatoryPanel({ dealId, initial }: { dealId: number; initial: Data }) {
  const [data, setData] = useState<Data>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const today = todayISO();

  const send: Send = async (method, body, query = "") => {
    setError(null);
    const res = await fetch(`/api/deals/${dealId}/regulatory${query}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null);
    if (!res) return { ok: false, error: "Could not reach the server." };
    const d = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: d?.error ?? "That change was not saved.", field: d?.field };
    setData({ fig_track: d.fig_track, filings: d.filings, votes: d.votes });
    return { ok: true };
  };

  async function setTrack(on: boolean) {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/deals/${dealId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fig_track: on ? 1 : 0 }),
    }).catch(() => null);
    setBusy(false);
    if (!res?.ok) {
      setError("Could not change the tracker setting.");
      return;
    }
    setData((d) => ({ ...d, fig_track: on ? 1 : 0 }));
  }

  if (!data.fig_track) {
    return (
      <div className="card flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-[var(--ink-soft)]">Bank or credit union deal? Turn on the regulatory approval tracker.</p>
        <div className="flex items-center gap-3">
          {error && <span className="text-sm text-[var(--bad)]">{error}</span>}
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setTrack(true)}>
            Turn on tracker
          </Button>
        </div>
      </div>
    );
  }

  const missingParties = VOTE_PARTIES.filter((p) => !data.votes.some((v) => v.party === p));

  return (
    <Panel
      title="Regulatory approvals"
      actions={
        <Button variant="quiet" size="sm" disabled={busy} onClick={() => setTrack(false)}>
          Turn off tracker
        </Button>
      }
    >
      <p className="-mt-2 mb-4 text-sm text-[var(--ink-soft)]">
        Applications run in parallel after signing. Each agency&apos;s clock starts when it accepts the application as substantially complete.
        Turning the tracker off hides it and keeps every date.
      </p>
      {error && <div className="mb-3 text-sm text-[var(--bad)]">{error}</div>}

      <RegulatoryTimeline filings={data.filings} votes={data.votes} today={today} />

      <div className="mt-6 flex items-baseline justify-between gap-3">
        <h3 className="text-[15px] font-bold text-[var(--ink)]">Filings</h3>
        <span className="text-xs text-[var(--ink-soft)]">
          {data.filings.length} {data.filings.length === 1 ? "regulator" : "regulators"}
        </span>
      </div>
      {data.filings.length === 0 && (
        <p className="mt-2 text-sm text-[var(--ink-soft)]">No filings tracked yet. Add each regulator the deal needs approval from.</p>
      )}
      <div className="mt-3 grid gap-4 xl:grid-cols-2">
        {data.filings.map((f) => (
          <FilingCard key={`${f.id}-${f.updated_at}`} filing={f} today={today} send={send} />
        ))}
      </div>
      <AddFiling send={send} />

      <h3 className="mt-8 text-[15px] font-bold text-[var(--ink)]">Shareholder votes</h3>
      <p className="mt-1 text-sm text-[var(--ink-soft)]">Runs on its own track: record date, proxy or notice mailed, meeting, result.</p>
      <div className="mt-3 grid gap-4 xl:grid-cols-2">
        {data.votes.map((v) => (
          <VoteCard key={`${v.id}-${v.updated_at}`} vote={v} send={send} />
        ))}
      </div>
      {missingParties.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {missingParties.map((p) => (
            <Button key={p} variant="secondary" size="sm" onClick={async () => {
              const r = await send("POST", { type: "vote", party: p });
              if (!r.ok) setError(r.error ?? null);
            }}>
              Add {VOTE_PARTY_LABELS[p].toLowerCase()} vote
            </Button>
          ))}
        </div>
      )}

      <Guidance />
    </Panel>
  );
}

// ---- one filing ----

type FilingDraft = Record<FilingDateField, string> & { status: FilingStatus; doj_concurrence: boolean; notes: string };

function draftOf(f: Filing): FilingDraft {
  const d = Object.fromEntries(FILING_DATE_FIELDS.map((k) => [k, f[k] ?? ""])) as Record<FilingDateField, string>;
  return { ...d, status: f.status, doj_concurrence: !!f.doj_concurrence, notes: f.notes ?? "" };
}

function FilingCard({ filing, today, send }: { filing: Filing; today: string; send: Send }) {
  const saved = draftOf(filing);
  const [draft, setDraft] = useState<FilingDraft>(saved);
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const year = Number(today.slice(0, 4));

  const s = suggestions({
    regulator: filing.regulator,
    accepted_complete_at: draft.accepted_complete_at || null,
    public_notice_at: draft.public_notice_at || null,
    approval_at: draft.approval_at || null,
    doj_concurrence: draft.doj_concurrence,
  });
  const orderErr = orderingError(Object.fromEntries(FILING_DATE_FIELDS.map((k) => [k, draft[k] || null])));
  const changed = (Object.keys(draft) as (keyof FilingDraft)[]).filter((k) => draft[k] !== saved[k]);
  const set = <K extends keyof FilingDraft>(k: K, val: FilingDraft[K]) => setDraft((d) => ({ ...d, [k]: val }));

  async function save() {
    if (orderErr) return setErr({ message: orderErr.message, field: orderErr.field });
    setSaving(true);
    const body: Record<string, unknown> = { type: "filing", id: filing.id };
    for (const k of changed) body[k] = k === "doj_concurrence" ? (draft.doj_concurrence ? 1 : 0) : draft[k] || null;
    const r = await send("PATCH", body);
    setSaving(false);
    if (!r.ok) setErr({ message: r.error ?? "Not saved", field: r.field });
  }

  const suggestionFor = (k: FilingDateField): { date: string; why: string } | null => {
    if (k === "comment_end_at" && s.comment_end_at) return { date: s.comment_end_at, why: `notice + ${GUIDANCE.commentDays} days` };
    if (k === "consummation_eligible_at" && s.consummation_eligible_at)
      return {
        date: s.consummation_eligible_at,
        why: draft.doj_concurrence ? `approval + ${GUIDANCE.waitingDaysWithDoj} days with DOJ concurrence` : `approval + ${GUIDANCE.waitingDays} days`,
      };
    return null;
  };

  const idBase = `reg-${filing.id}`;
  const shownErr = err ?? (orderErr ? { message: orderErr.message, field: orderErr.field } : null);

  return (
    <article className="rounded-[var(--radius-lg)] border border-[var(--rule)] bg-[var(--surface)] p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate text-[15px] font-bold text-[var(--ink)]">{filingLabel(filing)}</h4>
          {filing.agency_label && <div className="text-xs text-[var(--ink-soft)]">{REGULATOR_LABELS[filing.regulator]}</div>}
        </div>
        <StatusLabel kind={STATUS_KIND[filing.status]}>{FILING_STATUS_LABELS[filing.status]}</StatusLabel>
      </header>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {FILING_DATE_FIELDS.map((k) => {
          const sug = !draft[k] ? suggestionFor(k) : null;
          const bad = shownErr?.field === k;
          return (
            <div key={k}>
              <DateInput
                id={`${idBase}-${k}`}
                label={FILING_DATE_LABELS[k]}
                value={draft[k]}
                aria-invalid={bad || undefined}
                className={bad ? "!border-[var(--bad)]" : ""}
                onChange={(e) => {
                  setErr(null);
                  set(k, e.target.value);
                }}
              />
              {sug && (
                <div className="mt-1 flex items-center gap-2 text-xs text-[var(--ink-soft)]">
                  <span>
                    Suggested: <span className="font-semibold text-[var(--ink)]">{shortDate(sug.date, year)}</span> ({sug.why})
                  </span>
                  <Button variant="quiet" size="sm" className="!px-1" onClick={() => set(k, sug.date)} aria-label={`Use suggested ${FILING_DATE_LABELS[k].toLowerCase()} date`}>
                    Use
                  </Button>
                </div>
              )}
              {k === "approval_at" && !draft.approval_at && (
                <p className="mt-1 text-xs text-[var(--ink-soft)]">
                  {s.expected_approval ? (
                    <>
                      Typical window:{" "}
                      <span className="font-semibold text-[var(--ink)]">
                        {shortDate(s.expected_approval.earliest, year)} to {shortDate(s.expected_approval.latest, year)}
                      </span>{" "}
                      ({s.expected_approval.basis}). A guide only; enter the real date when the approval arrives.
                    </>
                  ) : (
                    s.expected_approval_note
                  )}
                </p>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Select id={`${idBase}-status`} label="Status" value={draft.status} onChange={(e) => set("status", e.target.value as FilingStatus)}>
          {FILING_STATUSES.map((st) => (
            <option key={st} value={st}>
              {FILING_STATUS_LABELS[st]}
            </option>
          ))}
        </Select>
        <label className="flex min-h-[44px] cursor-pointer items-center gap-2 self-end text-sm text-[var(--ink)]">
          <input type="checkbox" className="h-5 w-5" checked={draft.doj_concurrence} onChange={(e) => set("doj_concurrence", e.target.checked)} />
          DOJ concurrence (shortens the post-approval wait to {GUIDANCE.waitingDaysWithDoj} days)
        </label>
      </div>
      <label htmlFor={`${idBase}-notes`} className="label mt-3 mb-1 block">
        Notes
      </label>
      <textarea
        id={`${idBase}-notes`}
        rows={2}
        value={draft.notes}
        onChange={(e) => set("notes", e.target.value)}
        className={`${inputClass} h-auto min-h-[64px] py-2`}
      />

      {shownErr && <p className="mt-2 text-sm text-[var(--bad)]">{shownErr.message}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Button variant="quiet" size="sm" className="!px-0" onClick={() => setConfirming(true)}>
          Remove
        </Button>
        <div className="flex items-center gap-2">
          {changed.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => { setDraft(saved); setErr(null); }}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={changed.length === 0 || saving || !!orderErr} onClick={save}>
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
      {confirming && (
        <ConfirmDialog
          titleId={`${idBase}-confirm`}
          title={`Remove ${filingLabel(filing)}?`}
          detail="This filing and its dates leave the tracker. The removal is kept in the audit log."
          confirmLabel="Remove filing"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            const r = await send("DELETE", undefined, `?type=filing&id=${filing.id}`);
            if (r.ok) setConfirming(false);
            else setErr({ message: r.error ?? "Not removed" });
          }}
        />
      )}
    </article>
  );
}

function AddFiling({ send }: { send: Send }) {
  const [regulator, setRegulator] = useState<Regulator>("FDIC");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-4 rounded-[var(--radius-lg)] bg-[var(--paper)] p-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto] sm:items-end">
        <Select id="reg-add-regulator" label="Regulator" value={regulator} onChange={(e) => setRegulator(e.target.value as Regulator)}>
          {REGULATORS.map((r) => (
            <option key={r} value={r}>
              {REGULATOR_LABELS[r]}
            </option>
          ))}
        </Select>
        <div>
          <label htmlFor="reg-add-label" className="label mb-1 block text-[var(--ink-soft)]">
            Agency name {regulator === "STATE" ? "(the state department)" : "(optional)"}
          </label>
          <input
            id="reg-add-label"
            className={inputClass}
            value={label}
            placeholder={regulator === "STATE" ? "State banking department name" : regulator === "FED" ? "e.g. holding company application" : ""}
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const r = await send("POST", { type: "filing", regulator, agency_label: label.trim() || null });
            setBusy(false);
            if (r.ok) {
              setLabel("");
              setErr(null);
            } else setErr(r.error ?? "Not added");
          }}
        >
          Add regulator
        </Button>
      </div>
      {err && <p className="mt-2 text-sm text-[var(--bad)]">{err}</p>}
    </div>
  );
}

// ---- one shareholder vote ----

type VoteDraft = { record_date: string; notice_mailed_at: string; meeting_at: string; result: VoteResult; votes_for_pct: string; notes: string };

function voteDraft(v: ShareholderVote): VoteDraft {
  return {
    record_date: v.record_date ?? "",
    notice_mailed_at: v.notice_mailed_at ?? "",
    meeting_at: v.meeting_at ?? "",
    result: v.result ?? "pending",
    votes_for_pct: v.votes_for_pct == null ? "" : String(v.votes_for_pct),
    notes: v.notes ?? "",
  };
}

function VoteCard({ vote, send }: { vote: ShareholderVote; send: Send }) {
  const saved = voteDraft(vote);
  const [draft, setDraft] = useState<VoteDraft>(saved);
  const [err, setErr] = useState<{ message: string; field?: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const changed = (Object.keys(draft) as (keyof VoteDraft)[]).filter((k) => draft[k] !== saved[k]);
  const set = <K extends keyof VoteDraft>(k: K, val: VoteDraft[K]) => setDraft((d) => ({ ...d, [k]: val }));
  const idBase = `vote-${vote.id}`;
  const party: VoteParty = vote.party;

  async function save() {
    setSaving(true);
    const body: Record<string, unknown> = { type: "vote", id: vote.id };
    for (const k of changed) body[k] = draft[k] === "" ? null : draft[k];
    const r = await send("PATCH", body);
    setSaving(false);
    if (!r.ok) setErr({ message: r.error ?? "Not saved", field: r.field });
  }

  return (
    <article className="rounded-[var(--radius-lg)] border border-[var(--rule)] bg-[var(--surface)] p-4">
      <header className="flex items-start justify-between gap-2">
        <h4 className="text-[15px] font-bold text-[var(--ink)]">{VOTE_PARTY_LABELS[party]}</h4>
        <StatusLabel kind={RESULT_KIND[vote.result ?? "pending"]}>{VOTE_RESULT_LABELS[vote.result ?? "pending"]}</StatusLabel>
      </header>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        {VOTE_DATE_FIELDS.map((k) => (
          <DateInput
            key={k}
            id={`${idBase}-${k}`}
            label={VOTE_DATE_LABELS[k]}
            value={draft[k]}
            aria-invalid={err?.field === k || undefined}
            onChange={(e) => {
              setErr(null);
              set(k, e.target.value);
            }}
          />
        ))}
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Select id={`${idBase}-result`} label="Result" value={draft.result} onChange={(e) => set("result", e.target.value as VoteResult)}>
          {VOTE_RESULTS.map((r) => (
            <option key={r} value={r}>
              {VOTE_RESULT_LABELS[r]}
            </option>
          ))}
        </Select>
        <div>
          <label htmlFor={`${idBase}-pct`} className="label mb-1 block text-[var(--ink-soft)]">
            Votes for (% of votes cast)
          </label>
          <input
            id={`${idBase}-pct`}
            inputMode="decimal"
            className={inputClass}
            value={draft.votes_for_pct}
            onChange={(e) => {
              setErr(null);
              set("votes_for_pct", e.target.value);
            }}
          />
        </div>
      </div>
      <label htmlFor={`${idBase}-notes`} className="label mt-3 mb-1 block">
        Notes
      </label>
      <textarea
        id={`${idBase}-notes`}
        rows={2}
        value={draft.notes}
        onChange={(e) => set("notes", e.target.value)}
        className={`${inputClass} h-auto min-h-[64px] py-2`}
      />
      {err && <p className="mt-2 text-sm text-[var(--bad)]">{err.message}</p>}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Button variant="quiet" size="sm" className="!px-0" onClick={() => setConfirming(true)}>
          Remove
        </Button>
        <div className="flex items-center gap-2">
          {changed.length > 0 && (
            <Button variant="secondary" size="sm" onClick={() => { setDraft(saved); setErr(null); }}>
              Discard
            </Button>
          )}
          <Button size="sm" disabled={changed.length === 0 || saving} onClick={save}>
            {saving ? "Saving" : "Save"}
          </Button>
        </div>
      </div>
      {confirming && (
        <ConfirmDialog
          titleId={`${idBase}-confirm`}
          title={`Remove the ${VOTE_PARTY_LABELS[party].toLowerCase()} vote?`}
          detail="The vote and its dates leave the tracker. The removal is kept in the audit log."
          confirmLabel="Remove vote"
          onCancel={() => setConfirming(false)}
          onConfirm={async () => {
            const r = await send("DELETE", undefined, `?type=vote&id=${vote.id}`);
            if (r.ok) setConfirming(false);
            else setErr({ message: r.error ?? "Not removed" });
          }}
        />
      )}
    </article>
  );
}

// ---- guidance ----

function Guidance() {
  const g = GUIDANCE;
  return (
    <details className="mt-8 rounded-[var(--radius-lg)] bg-[var(--paper)] px-4 py-3 text-sm text-[var(--ink-soft)]">
      <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold text-[var(--ink)]">
        Typical timelines (guidance, not legal advice)
      </summary>
      <ul className="mt-2 list-disc space-y-1.5 pl-5">
        <li>Applications to the FDIC, OCC, Federal Reserve and the state banking department (NCUA for credit unions) are filed in parallel. Each clock starts when that agency accepts the application as substantially complete.</li>
        <li>Public notice and comment period: typically {g.commentDays} days (FDIC and OCC).</li>
        <li>DOJ competitive-factors report: typically within {g.dojReportDays} days.</li>
        <li>
          Approval: FDIC and OCC roughly {g.approvalDays.FDIC.standard} days standard, about {g.approvalDays.FDIC.expedited} expedited. Federal Reserve M&amp;A: median{" "}
          {g.fedApprovalDays.median} days, average {g.fedApprovalDays.average} (H2 2024). State departments set their own timelines.
        </li>
        <li>
          After approval: a {g.waitingDays} day waiting period before consummation, which can be shortened to {g.waitingDaysWithDoj} days with DOJ concurrence.
        </li>
        <li>Shareholder votes run on their own track: record date, proxy or notice mailed, meeting, result.</li>
        <li>
          Credit union acquirer: NCUA board approval, member notice typically {g.ncuaMemberNoticeDays.min} to {g.ncuaMemberNoticeDays.max} days, then the member vote.
        </li>
      </ul>
      <p className="mt-2 text-xs">These are typical timelines for planning. Actual timing depends on the agency, the application and the deal. Confirm with deal counsel.</p>
    </details>
  );
}
