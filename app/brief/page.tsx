import { redirect } from "next/navigation";
import Link from "next/link";
import { currentUser } from "../lib/session";
import { firm } from "../../firm.config";
import { loadBrief, briefCountsText, type BriefItem } from "../lib/brief";
import { todayISO } from "../components/pipeline/dateUtils";
import { ButtonLink } from "../components/ui/Button";
import PrintButton from "../components/buyers/PrintButton";
import StatusLabel from "../components/ui/StatusLabel";
import { TriangleAlertIcon } from "../components/ui/icons";

export const metadata = { title: `Morning brief | ${firm.productName}` };
export const dynamic = "force-dynamic";

// Morning brief: everything that needs the banker today on one printable page
// (the app frame hides on print, see app/globals.css). Deal Desk never emails
// it. Each section shows only when it has something in it; each item is one line.
export default async function BriefPage() {
  const user = await currentUser();
  if (!user) redirect("/login");
  const today = todayISO();
  const brief = loadBrief(today, user);
  const dateLabel = new Date(today + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const counts = briefCountsText(brief.counts);

  return (
    <div className="mx-auto max-w-[860px]">
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <ButtonLink href="/" variant="quiet" size="sm" className="!px-0">
          Back to Today
        </ButtonLink>
        <span className="flex-1" />
        <PrintButton />
      </div>

      <article className="card p-6 sm:p-8">
        {/* A div, not <header>: the print CSS hides every header inside .app-shell. */}
        <div className="border-b border-[var(--rule)] pb-4">
          <div className="text-[12px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">Morning brief</div>
          <h1 className="display mt-1 text-[26px] font-bold text-[var(--ink)]">{dateLabel}</h1>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">{counts ?? "Nothing overdue, nothing due today and no buyers waiting."}</p>
        </div>

        {brief.sections.length === 0 ? (
          <p className="mt-6 text-sm text-[var(--ink-soft)]">
            A clear desk. Deal steps, tasks, buyer follow-ups, new bids, regulatory dates and people due a touch show up here when they need you.
          </p>
        ) : (
          brief.sections.map((s) => (
            <section key={s.id} className="print-break-avoid mt-6" aria-labelledby={`brief-${s.id}`}>
              <h2 id={`brief-${s.id}`} className="flex items-baseline gap-2 text-[15px] font-bold text-[var(--ink)]">
                {s.title}
                <span className="numeric text-[13px] font-medium text-[var(--ink-soft)]">{s.items.length}</span>
              </h2>
              <ul className="mt-2 divide-y divide-[var(--rule)] border-y border-[var(--rule)]">
                {s.items.map((it) => (
                  <Line key={it.key} it={it} />
                ))}
              </ul>
            </section>
          ))
        )}

        <footer className="mt-8 border-t border-[var(--rule)] pt-3 text-[11px] text-[var(--ink-faint)]">
          Internal. Prepared for {user.name} by {firm.productName}. Not for distribution.
        </footer>
      </article>
    </div>
  );
}

function Line({ it }: { it: BriefItem }) {
  return (
    <li className="print-break-avoid">
      <Link href={it.href} className="flex min-h-[40px] min-w-0 items-center gap-3 py-1.5 text-sm hover:bg-[var(--paper)]">
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold text-[var(--ink)]">{it.text}</span>
          {it.detail && <span className="text-[var(--ink-soft)]"> · {it.detail}</span>}
        </span>
        {it.meta &&
          (it.tone === "stop" ? (
            <StatusLabel kind="stop" icon={TriangleAlertIcon} className="shrink-0 whitespace-nowrap !px-2 !py-0.5">
              {it.meta}
            </StatusLabel>
          ) : it.tone === "warn" ? (
            <StatusLabel kind="warn" className="shrink-0 whitespace-nowrap !px-2 !py-0.5">
              {it.meta}
            </StatusLabel>
          ) : (
            <span className="numeric shrink-0 whitespace-nowrap text-[13px] text-[var(--ink-soft)]">{it.meta}</span>
          ))}
      </Link>
    </li>
  );
}
