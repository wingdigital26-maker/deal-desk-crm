// Global search results: companies, people and deals for one query, grouped by
// kind. A blank query shows a prompt, never the whole database.
import Link from "next/link";
import { firm } from "../../firm.config";
import PageHeader from "../components/crm/PageHeader";
import EmptyState from "../components/crm/EmptyState";
import Panel from "../components/ui/Panel";
import { Button } from "../components/ui/Button";
import { displayName, titleCaseCompanyName } from "../components/crm/format";

// Registry rows arrive in ALL CAPS; leave names a person typed ("CPA") alone.
const coName = (n: string) => (n === n.toUpperCase() ? titleCaseCompanyName(n) : n);
import { globalSearch, SEARCH_LIMIT } from "../lib/search";

export const dynamic = "force-dynamic";
export const metadata = { title: `Search | ${firm.productName}` };

export default async function SearchPage({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const sp = await searchParams;
  const raw = Array.isArray(sp.q) ? sp.q[0] : sp.q;
  const results = globalSearch(raw);
  const q = results.q;
  const total = results.companies.length + results.contacts.length + results.deals.length;
  const enc = encodeURIComponent(q);

  const more = (n: number, href: string, noun: string) =>
    n >= SEARCH_LIMIT ? (
      <Link href={href} className="mt-3 inline-flex min-h-[44px] items-center text-sm text-[var(--ink-soft)] underline-offset-2 hover:text-[var(--ink)] hover:underline">
        See every matching {noun}
      </Link>
    ) : null;

  return (
    <div className="max-w-3xl">
      <PageHeader
        title="Search"
        subtitle={q ? (total ? `Results for "${q}"` : undefined) : "Find a company, a person or a deal by name."}
      />

      <form method="get" action="/search" role="search" className="mb-6 flex gap-2">
        <label htmlFor="search-page-q" className="sr-only">
          Search companies, people and deals
        </label>
        <input
          id="search-page-q"
          type="search"
          name="q"
          defaultValue={q}
          autoFocus={!q}
          placeholder="Search companies, people and deals"
          className="h-[44px] min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] px-3 text-[16px] text-[var(--ink)] outline-none focus-visible:border-[var(--accent)]"
        />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      {!q ? null : total === 0 ? (
        <EmptyState title={`Nothing matches "${q}"`} detail="Try part of a name, an email address or a web domain." />
      ) : (
        <div className="space-y-6">
          <Panel title={`Companies (${results.companies.length})`}>
            {results.companies.length === 0 ? (
              <p className="text-sm text-[var(--ink-faint)]">No companies match.</p>
            ) : (
              <ul className="divide-y divide-[var(--rule)]">
                {results.companies.map((c) => (
                  <li key={c.id}>
                    <Link href={`/companies/${c.id}`} className="flex min-h-[44px] flex-wrap items-center justify-between gap-x-3 py-2 hover:text-[var(--accent)]">
                      <span className="font-medium text-[var(--ink)]">{coName(c.name)}</span>
                      <span className="text-sm text-[var(--ink-soft)]">{[c.domain, [c.city, c.state].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {more(results.companies.length, `/companies?q=${enc}`, "company")}
          </Panel>

          <Panel title={`People (${results.contacts.length})`}>
            {results.contacts.length === 0 ? (
              <p className="text-sm text-[var(--ink-faint)]">No people match.</p>
            ) : (
              <ul className="divide-y divide-[var(--rule)]">
                {results.contacts.map((c) => (
                  <li key={c.id}>
                    <Link href={`/contacts/${c.id}`} className="flex min-h-[44px] flex-wrap items-center justify-between gap-x-3 py-2">
                      <span className="font-medium text-[var(--ink)]">{displayName(c)}</span>
                      <span className="text-sm text-[var(--ink-soft)]">
                        {[c.title, c.company_name ? coName(c.company_name) : null, c.email].filter(Boolean).join(" · ")}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            {more(results.contacts.length, `/contacts?q=${enc}`, "person")}
          </Panel>

          <Panel title={`Deals (${results.deals.length})`}>
            {results.deals.length === 0 ? (
              <p className="text-sm text-[var(--ink-faint)]">No deals match.</p>
            ) : (
              <ul className="divide-y divide-[var(--rule)]">
                {results.deals.map((d) => (
                  <li key={d.id}>
                    <Link href={`/pipeline/${d.id}`} className="flex min-h-[44px] flex-wrap items-center justify-between gap-x-3 py-2">
                      <span className="font-medium text-[var(--ink)]">{d.title}</span>
                      <span className="text-sm text-[var(--ink-soft)]">
                        {coName(d.company_name)} · {d.stage}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </div>
  );
}
