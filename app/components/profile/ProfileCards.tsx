// Banker profile cards: Owner, Business, Why now, Fit, Sell-readiness hints.
// Every value shows where it came from. A blank says so plainly. Name-only
// matches carry an "Unconfirmed" pill and never read as fact.
import type { CompanyProfile, Sourced, WhyNowItem, ContactOwnerView, FitFlag } from "../../lib/profile";
import Panel from "../ui/Panel";
import StatusLabel from "../ui/StatusLabel";
import { ArrowUpRightIcon, UsersIcon, BuildingIcon, ActivityIcon } from "../ui/icons";

export function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso.replace(" ", "T") + (/[zZ]$/.test(iso) ? "" : "Z"));
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

const BLANK = "Not in public sources";

function UnconfirmedPill() {
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--status-warn-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--warn)]">
      Unconfirmed
    </span>
  );
}

/** "company site · Sep 25, 2026" as a small link, or the CRM label when there is no URL. */
export function SourceTag({ s, className = "" }: { s: Sourced; className?: string }) {
  const date = fmtDate(s.fetchedAt);
  const label = s.sourceLabel === "Company website" ? "company site" : s.sourceLabel;
  return (
    <span className={`inline-flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-[var(--ink-faint)] ${className}`}>
      {s.sourceUrl ? (
        <a
          href={s.sourceUrl}
          target="_blank"
          rel="noreferrer"
          title={s.note ?? undefined}
          className="inline-flex items-center gap-0.5 underline decoration-[var(--rule-strong)] underline-offset-2 hover:text-[var(--ink)] hover:decoration-[var(--ink)]"
        >
          {label}
          <ArrowUpRightIcon className="h-3 w-3" />
        </a>
      ) : (
        <span>{label}</span>
      )}
      {date && <span>· {date}</span>}
      {s.confidence === "unconfirmed" && <UnconfirmedPill />}
    </span>
  );
}

function Row({ label, s, render, wide = false }: { label: string; s: Sourced | null; render?: (v: string) => React.ReactNode; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-[12px] font-semibold text-[var(--ink-soft)]">{label}</dt>
      {s ? (
        <dd className="mt-0.5">
          <div className="break-words text-[14px] font-semibold text-[var(--ink)]">{render ? render(s.value) : s.value}</div>
          <SourceTag s={s} className="mt-0.5" />
        </dd>
      ) : (
        <dd className="mt-0.5 text-[14px] text-[var(--ink-faint)]">{BLANK}</dd>
      )}
    </div>
  );
}

function Pills({ label, items, wide = true }: { label: string; items: Sourced[]; wide?: boolean }) {
  return (
    <div className={`min-w-0 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-[12px] font-semibold text-[var(--ink-soft)]">{label}</dt>
      {items.length === 0 ? (
        <dd className="mt-0.5 text-[14px] text-[var(--ink-faint)]">{BLANK}</dd>
      ) : (
        <dd className="mt-1.5 flex flex-wrap gap-1.5">
          {items.map((s) => (
            <a
              key={s.value}
              href={s.sourceUrl ?? undefined}
              target="_blank"
              rel="noreferrer"
              title={`${s.sourceLabel}${s.note ? `: ${s.note}` : ""}`}
              className={`inline-flex min-h-[32px] items-center rounded-full px-3 text-[13px] font-medium ${
                s.confidence === "confirmed" ? "bg-[var(--paper)] text-[var(--ink)] hover:bg-[var(--tint-1)]" : "bg-[var(--status-warn-bg)] text-[var(--warn)]"
              }`}
            >
              {s.value}
            </a>
          ))}
        </dd>
      )}
    </div>
  );
}

const linkish = (v: string) => (
  <a href={v} target="_blank" rel="noreferrer" className="underline decoration-[var(--rule-strong)] underline-offset-2 hover:decoration-[var(--ink)]">
    {v.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
  </a>
);

const TITLE_CASE = (v: string) => v.replace(/\b(ceo|cfo|coo)\b/gi, (m) => m.toUpperCase()).replace(/^\w/, (c) => c.toUpperCase());

const OWNERSHIP_LABEL: Record<string, string> = {
  family: "Family owned",
  "founder-led": "Founder led",
  "pe-backed": "PE-backed",
  public: "Public company or public parent",
  subsidiary: "Subsidiary or division",
  "employee-owned": "Employee-owned (ESOP)",
};

function CardTitle({ icon, children, tint }: { icon: React.ReactNode; children: React.ReactNode; tint: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className={`flex h-8 w-8 items-center justify-center rounded-full ${tint} text-[var(--ink-soft)]`} aria-hidden>
        {icon}
      </span>
      <span className="[font-family:var(--font-display)] text-[17px] font-bold tracking-[-0.01em]">{children}</span>
    </span>
  );
}

export function OwnerCard({
  profile,
  contact,
  view,
  actions,
}: {
  profile: CompanyProfile;
  contact?: { name: string; title: string | null; linkedin_url: string | null; source: string } | null;
  view?: ContactOwnerView | null;
  actions?: React.ReactNode;
}) {
  const o = profile.owner;
  const crm = (v: string | null): Sourced | null =>
    v ? { value: v, sourceUrl: null, sourceLabel: contact?.source === "apollo" ? "CRM record (Apollo import)" : "CRM record", fetchedAt: null, confidence: "confirmed", note: null, observedAt: null } : null;
  // On a contact page the card is about THIS person. Site facts about the
  // principal only attach when the site's principal is this contact.
  const sitePerson = !contact || view?.isPrincipal;
  const name = contact ? crm(contact.name) : o.name;
  const siteTitle = contact ? (view?.siteMatch ? { ...view.siteMatch.source, value: view.siteMatch.title } : null) : o.title;
  const linkedin = (sitePerson ? o.linkedin : null) ?? (contact ? crm(contact.linkedin_url) : null);
  const founderYear = /found/i.test((sitePerson ? o.title?.value : siteTitle?.value) || "") ? profile.business.foundedYear : null;

  return (
    <Panel title={<CardTitle icon={<UsersIcon />} tint="bg-[var(--tint-1)]">Owner</CardTitle>} actions={actions}>
      {view?.principal && (
        <p className="mb-4 rounded-[12px] bg-[var(--paper)] px-3.5 py-2.5 text-[13px] text-[var(--ink-soft)]">
          The company site names <span className="font-semibold text-[var(--ink)]">{view.principal.name.value}</span>
          {view.principal.title ? ` (${TITLE_CASE(view.principal.title.value)})` : ""} as its principal. <SourceTag s={view.principal.name} />
        </p>
      )}
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <Row label="Full name" s={name} />
        <Row label={contact ? "Title (CRM)" : "Title"} s={contact ? crm(contact.title) : o.title} render={TITLE_CASE} />
        {contact && <Row label="Title on company site" s={siteTitle} render={TITLE_CASE} />}
        <Row
          label="In the seat since"
          s={(sitePerson ? o.since : null) ?? (founderYear ? { ...founderYear, value: `${founderYear.value} (founded it)` } : null)}
        />
        <Row label="Age or career stage" s={null} />
        <Row label="LinkedIn" s={linkedin} render={linkish} />
        <Row label="About the owner" s={sitePerson ? o.bio : null} wide render={(v) => <span className="font-normal leading-relaxed">{v}</span>} />
        <Pills label="Other roles and boards" items={sitePerson ? o.otherRoles : []} />
        <div className="min-w-0 sm:col-span-2">
          <dt className="text-[12px] font-semibold text-[var(--ink-soft)]">Press</dt>
          {sitePerson && o.press.length > 0 ? (
            <dd className="mt-1 space-y-2">
              {o.press.map((p) => (
                <div key={p.value}>
                  <div className="text-[14px] text-[var(--ink)]">{p.value}</div>
                  <SourceTag s={p} />
                </div>
              ))}
            </dd>
          ) : (
            <dd className="mt-0.5 text-[14px] text-[var(--ink-faint)]">{BLANK}</dd>
          )}
        </div>
      </dl>
      {profile.leaders.length > 0 && (
        <div className="mt-5 border-t border-[var(--rule)] pt-4">
          <div className="text-[12px] font-semibold text-[var(--ink-soft)]">Leaders named on the company site</div>
          <ul className="mt-1.5 flex flex-wrap gap-1.5">
            {profile.leaders.map((l, i) => (
              <li key={`${i}-${l.name}`}>
                <a
                  href={l.source.sourceUrl ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-[32px] items-center gap-1 rounded-full bg-[var(--paper)] px-3 text-[13px] text-[var(--ink)] hover:bg-[var(--tint-1)]"
                >
                  <span className="font-semibold">{l.name}</span>
                  <span className="text-[var(--ink-soft)]">{TITLE_CASE(l.title)}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}

export function BusinessCard({ profile }: { profile: CompanyProfile }) {
  const b = profile.business;
  return (
    <Panel title={<CardTitle icon={<BuildingIcon />} tint="bg-[var(--tint-2)]">Business</CardTitle>}>
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <Row label="What they do" s={b.summary} wide render={(v) => <span className="font-normal leading-relaxed">{v}</span>} />
        <Row label="Legal name" s={b.legalName} />
        <Row label="Also known as" s={b.dba} />
        <Row label="Website" s={b.website} render={linkish} />
        <Row label="Company LinkedIn" s={b.linkedin} render={linkish} />
        <Row label="Industry" s={b.industry} />
        <Row label="NAICS" s={b.naics} />
        <Row label="Founded (company's own words)" s={b.foundedYear} />
        <Row label="Formed in Texas (SOS charter)" s={b.formationDate} render={(v) => fmtDate(v) ?? v} />
        <Row label="Entity type" s={b.entityType} />
        <Row label="SOS file number" s={b.sosFileNumber} />
        <Row label="Headquarters" s={b.hqAddress} wide />
        <Row label="Employees" s={b.employees} />
        <Row label="Revenue" s={b.revenueBand} />
        <Row label="Ownership" s={b.ownershipType} render={(v) => OWNERSHIP_LABEL[v] ?? v} />
        <Row label="Family owned since" s={b.familyOwnedSince} />
        <Pills label="Locations" items={b.locations} />
        <Pills label="Customers and end markets" items={b.endMarkets} />
        <Pills label="Certifications" items={b.certifications} />
      </dl>
    </Panel>
  );
}

const KIND_LABEL: Record<WhyNowItem["kind"], string> = {
  hiring: "Hiring",
  expansion: "Expansion",
  facility: "Facility",
  award: "Award",
  ownership: "Ownership",
  news: "News",
  contract: "Federal contract",
};
const KIND_TINT: Record<WhyNowItem["kind"], string> = {
  hiring: "bg-[var(--tint-1)]",
  expansion: "bg-[var(--tint-2)]",
  facility: "bg-[var(--tint-2)]",
  award: "bg-[var(--tint-3)]",
  ownership: "bg-[var(--tint-4)]",
  news: "bg-[var(--paper)]",
  contract: "bg-[var(--paper)]",
};

function SignalItem({ w }: { w: WhyNowItem }) {
  const date = fmtDate(w.date);
  return (
    <li className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
      <span className={`mt-0.5 inline-flex shrink-0 items-center rounded-full px-2.5 py-1 text-[11px] font-semibold text-[var(--ink-soft)] ${KIND_TINT[w.kind]}`}>
        {KIND_LABEL[w.kind]}
      </span>
      <div className="min-w-0">
        <div className="break-words text-[14px] text-[var(--ink)]">
          {w.url ? (
            <a href={w.url} target="_blank" rel="noreferrer" className="hover:text-[var(--accent)]">
              {w.title}
            </a>
          ) : (
            w.title
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-[var(--ink-faint)]">
          <span>{w.sourceLabel}</span>
          <span>· {date ?? "date not given"}</span>
          {w.confidence === "unconfirmed" && <UnconfirmedPill />}
        </div>
      </div>
    </li>
  );
}

export function WhyNowCard({ profile }: { profile: CompanyProfile }) {
  const all = profile.whyNow.filter((w) => w.confidence === "confirmed");
  // the typed signals (hiring, expansion, facility, award, ownership) lead; general news follows
  const confirmed = [...all.filter((w) => w.kind !== "news"), ...all.filter((w) => w.kind === "news")];
  const shown = confirmed.slice(0, 6);
  const rest = confirmed.slice(6);
  const unconfirmed = profile.whyNow.filter((w) => w.confidence === "unconfirmed");
  return (
    <Panel title={<CardTitle icon={<ActivityIcon />} tint="bg-[var(--tint-3)]">Why now</CardTitle>}>
      {confirmed.length === 0 ? (
        <p className="text-[14px] text-[var(--ink-faint)]">No hiring, expansion, award, facility or ownership news tied to this company yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--rule)]">
          {shown.map((w) => (
            <SignalItem key={`${w.kind}-${w.title}`} w={w} />
          ))}
        </ul>
      )}
      {rest.length > 0 && (
        <details className="mt-3 border-t border-[var(--rule)] pt-3">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-[13px] font-semibold text-[var(--ink-soft)]">
            {rest.length} more news items
          </summary>
          <ul className="mt-2 divide-y divide-[var(--rule)]">
            {rest.map((w) => (
              <SignalItem key={`${w.kind}-${w.title}`} w={w} />
            ))}
          </ul>
        </details>
      )}
      {unconfirmed.length > 0 && (
        <details className="mt-4 border-t border-[var(--rule)] pt-3">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-[13px] font-semibold text-[var(--ink-soft)]">
            {unconfirmed.length} more that match the name only. Check before citing.
          </summary>
          <ul className="mt-2 divide-y divide-[var(--rule)]">
            {unconfirmed.map((w) => (
              <SignalItem key={`${w.kind}-${w.title}`} w={w} />
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}

const FIT_KIND: Record<FitFlag["level"], "stop" | "warn" | "info"> = { poor: "stop", possible: "warn", note: "info" };

export function FitLine({ profile }: { profile: CompanyProfile }) {
  return (
    <section className="card flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:gap-4">
      <h2 className="shrink-0 pt-1 [font-family:var(--font-display)] text-[16px] font-bold">Fit</h2>
      {profile.fit.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <StatusLabel kind="none">No poor-fit flags in public sources</StatusLabel>
          <span className="text-[12px] text-[var(--ink-faint)]">Checked: ownership language on the site, ownership news, registry entity type.</span>
        </div>
      ) : (
        <ul className="flex min-w-0 flex-col gap-2">
          {profile.fit.map((f) => (
            <li key={f.text} className="flex flex-wrap items-center gap-2">
              <StatusLabel kind={FIT_KIND[f.level]}>{f.level === "poor" ? "Poor fit" : f.level === "possible" ? "Possible poor fit" : "Note"}</StatusLabel>
              <span className="min-w-0 break-words text-[14px] text-[var(--ink)]">{f.text}</span>
              {f.source && <SourceTag s={f.source} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HintsCard({ profile }: { profile: CompanyProfile }) {
  return (
    <Panel
      title={<span className="[font-family:var(--font-display)] text-[17px] font-bold tracking-[-0.01em]">Sell-readiness hints</span>}
      actions={<span className="rounded-full bg-[var(--status-warn-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--warn)]">Inference</span>}
    >
      <p className="-mt-2 mb-3 text-[12px] text-[var(--ink-faint)]">Read from the sourced facts. None of this is a published statement by the owner.</p>
      {profile.hints.length === 0 ? (
        <p className="text-[14px] text-[var(--ink-faint)]">Not enough public detail to infer anything yet.</p>
      ) : (
        <ul className="space-y-3">
          {profile.hints.map((h) => (
            <li key={h.text}>
              <div className="text-[14px] text-[var(--ink)]">{h.text}</div>
              <div className="mt-0.5 flex flex-wrap gap-x-3">
                {h.basis.map((s, i) => (
                  <SourceTag key={i} s={s} />
                ))}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
