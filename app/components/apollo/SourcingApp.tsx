"use client";
// Apollo sourcing workspace: search builder + results table + import bar.
// Client-side only; the actual Apollo call happens server-side in
// /api/apollo/search so the key never reaches the browser.
//
// Uses a thin local table instead of the shared DataTable because this view
// needs per-row checkbox selection, which DataTable does not support yet
// (reported in the round 2 journal as a gap for DataTable).
import { useEffect, useMemo, useState } from "react";
import { FieldInput, inputClass } from "../crm/Field";
import EmptyState from "../crm/EmptyState";
import { Button } from "../ui/Button";
import Select from "../ui/Select";
import ApolloSetupNotice from "./SetupNotice";

type Segment = { id: string; label: string };

type PersonResult = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  title: string | null;
  email: string | null;
  emailStatus: string | null;
  linkedinUrl: string | null;
  organizationName: string | null;
  organizationDomain: string | null;
  city: string | null;
  state: string | null;
};

type CompanyResult = {
  id: string;
  name: string | null;
  domain: string | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  estimatedEmployees: number | null;
};

type Mode = "people" | "companies";

const EMPTY_CELL = "-";

const TITLE_PRESET = "Owner, Founder, President, CEO";
const EMPLOYEE_RANGES = [
  { value: "1,10", label: "1-10" },
  { value: "11,50", label: "11-50" },
  { value: "51,200", label: "51-200" },
  { value: "201,500", label: "201-500" },
  { value: "501,1000", label: "501-1,000" },
  { value: "1001,5000", label: "1,001-5,000" },
];

function personLabel(p: PersonResult): string {
  return p.name || [p.firstName, p.lastName].filter(Boolean).join(" ") || "(name unknown)";
}

export default function ApolloSourcingApp({ segments }: { segments: Segment[] }) {
  const [status, setStatus] = useState<"loading" | "configured" | "unconfigured" | "error">("loading");
  const [statusError, setStatusError] = useState<string | null>(null);

  const [mode, setMode] = useState<Mode>("people");
  const [titles, setTitles] = useState(TITLE_PRESET);
  const [location, setLocation] = useState("");
  const [employeeRange, setEmployeeRange] = useState<string>("");
  const [keywords, setKeywords] = useState("");

  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [people, setPeople] = useState<PersonResult[]>([]);
  const [companies, setCompanies] = useState<CompanyResult[]>([]);
  const [totalEntries, setTotalEntries] = useState<number | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [segmentId, setSegmentId] = useState(segments[0]?.id ?? "");
  const [importing, setImporting] = useState(false);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/apollo/status")
      .then((r) => r.json())
      .then((data: { configured: boolean; error?: string }) => {
        if (cancelled) return;
        if (data.error) {
          setStatus("error");
          setStatusError(data.error);
        } else {
          setStatus(data.configured ? "configured" : "unconfigured");
        }
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(
    () => (mode === "people" ? people : companies),
    [mode, people, companies]
  );

  async function runSearch(e?: React.FormEvent) {
    e?.preventDefault();
    setSearching(true);
    setSearchError(null);
    setImportSummary(null);
    setImportError(null);
    try {
      const res = await fetch("/api/apollo/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          personTitles:
            mode === "people"
              ? titles
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
              : undefined,
          organizationLocations: location.trim() ? [location.trim()] : undefined,
          organizationNumEmployeesRanges: employeeRange ? [employeeRange] : undefined,
          qKeywords: keywords.trim() || undefined,
          perPage: 25,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSearchError(data.error || "Search failed.");
        setPeople([]);
        setCompanies([]);
        setTotalEntries(null);
        return;
      }
      if (mode === "people") setPeople(data.results ?? []);
      else setCompanies(data.results ?? []);
      setTotalEntries(typeof data.totalEntries === "number" ? data.totalEntries : null);
      setSelected(new Set());
      setHasSearched(true);
    } catch {
      setSearchError("Could not reach the search endpoint.");
    } finally {
      setSearching(false);
    }
  }

  function toggleAll() {
    if (selected.size === rows.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(rows.map((r) => r.id)));
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function runImport() {
    if (selected.size === 0 || !segmentId) return;
    setImporting(true);
    setImportError(null);
    setImportSummary(null);
    try {
      const selectedPeople = mode === "people" ? people.filter((p) => selected.has(p.id)) : [];
      const selectedCompanies = mode === "companies" ? companies.filter((c) => selected.has(c.id)) : [];
      const res = await fetch("/api/apollo/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ segmentId, people: selectedPeople, companies: selectedCompanies }),
      });
      const data = await res.json();
      if (!res.ok) {
        setImportError(data.error || "Import failed.");
        return;
      }
      const r = data.result as {
        companiesCreated: number;
        companiesMatched: number;
        contactsCreated: number;
        contactsSkippedSuppressed: number;
        contactsSkippedNoIdentity: number;
      };
      const parts: string[] = [];
      if (r.companiesCreated) parts.push(`${r.companiesCreated} companies created`);
      if (r.companiesMatched) parts.push(`${r.companiesMatched} companies matched`);
      if (r.contactsCreated) parts.push(`${r.contactsCreated} contacts created`);
      if (r.contactsSkippedSuppressed) parts.push(`${r.contactsSkippedSuppressed} skipped (suppressed)`);
      if (r.contactsSkippedNoIdentity) parts.push(`${r.contactsSkippedNoIdentity} skipped (no identity)`);
      setImportSummary(parts.length ? parts.join(", ") : "Nothing new to import.");
      setSelected(new Set());
    } catch {
      setImportError("Could not reach the import endpoint.");
    } finally {
      setImporting(false);
    }
  }

  if (status === "loading") {
    return <p className="text-sm text-[var(--ink-soft)]">Checking Apollo connection...</p>;
  }

  if (status === "unconfigured") {
    return <ApolloSetupNotice />;
  }

  if (status === "error") {
    return (
      <EmptyState
        title="Apollo did not respond"
        detail={statusError || "The Apollo status check failed. Try again shortly."}
      />
    );
  }

  return (
    <div className="space-y-6">
      <form
        onSubmit={runSearch}
        className="card p-4"
      >
        <div className="card mb-3 inline-flex p-0.5 text-xs font-medium">
          <button
            type="button"
            onClick={() => setMode("people")}
            aria-pressed={mode === "people"}
            className={`min-h-[36px] rounded-[var(--radius-sm)] px-3 ${mode === "people" ? "bg-[var(--paper-deep)] font-semibold text-[var(--ink)]" : "text-[var(--ink-soft)]"}`}
          >
            People
          </button>
          <button
            type="button"
            onClick={() => setMode("companies")}
            aria-pressed={mode === "companies"}
            className={`min-h-[36px] rounded-[var(--radius-sm)] px-3 ${mode === "companies" ? "bg-[var(--paper-deep)] font-semibold text-[var(--ink)]" : "text-[var(--ink-soft)]"}`}
          >
            Companies
          </button>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
          {mode === "people" && (
            <FieldInput label="Titles" htmlFor="titles" hint="Comma-separated">
              <input
                id="titles"
                className={inputClass}
                value={titles}
                onChange={(e) => setTitles(e.target.value)}
                placeholder={TITLE_PRESET}
              />
            </FieldInput>
          )}
          <FieldInput label="Company location" htmlFor="location" hint="City, state, or region">
            <input
              id="location"
              className={inputClass}
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Texas"
            />
          </FieldInput>
          <FieldInput label="Employee range" htmlFor="employees">
            <Select
              id="employees"
              value={employeeRange}
              onChange={(e) => setEmployeeRange(e.target.value)}
            >
              <option value="">Any size</option>
              {EMPLOYEE_RANGES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </FieldInput>
          <FieldInput label="Industry keywords" htmlFor="keywords">
            <input
              id="keywords"
              className={inputClass}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="manufacturing, distribution"
            />
          </FieldInput>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <Button type="submit" disabled={searching}>
            {searching ? "Searching..." : "Search Apollo"}
          </Button>
          {searchError && <p className="text-sm text-[var(--bad)]">{searchError}</p>}
        </div>
      </form>

      {hasSearched && rows.length === 0 && !searchError && (
        <EmptyState title="No results" detail="Try widening the location, employee range, or titles." />
      )}

      {rows.length > 0 && (
        <div className="card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--rule)] px-4 py-3">
            <p className="text-sm text-[var(--ink-soft)]">
              {rows.length} result{rows.length === 1 ? "" : "s"} shown
              {totalEntries !== null && totalEntries > rows.length ? ` of ${totalEntries} total` : ""}
              {" · "}
              {selected.size} selected
            </p>
            <div className="flex items-center gap-2">
              <Select
                aria-label="Segment to import into"
                wrapperClassName="w-auto"
                value={segmentId}
                onChange={(e) => setSegmentId(e.target.value)}
              >
                {segments.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
              <Button
                type="button"
                variant="secondary"
                onClick={runImport}
                disabled={selected.size === 0 || importing}
              >
                {importing ? "Importing..." : `Import selected to ${segments.find((s) => s.id === segmentId)?.label ?? "segment"}`}
              </Button>
            </div>
          </div>

          {importSummary && <p className="border-b border-[var(--rule)] px-4 py-2 text-sm text-[var(--good)]">{importSummary}</p>}
          {importError && <p className="border-b border-[var(--rule)] px-4 py-2 text-sm text-[var(--bad)]">{importError}</p>}

          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--rule)] bg-[var(--paper)] text-left text-[12px] font-semibold text-[var(--ink-soft)]">
                  <th className="px-4 py-2">
                    <input
                      type="checkbox"
                      checked={rows.length > 0 && selected.size === rows.length}
                      onChange={toggleAll}
                      aria-label="Select all"
                    />
                  </th>
                  {mode === "people" ? (
                    <>
                      <th className="px-4 py-2">Name</th>
                      <th className="px-4 py-2">Title</th>
                      <th className="px-4 py-2">Company</th>
                      <th className="px-4 py-2">Email</th>
                      <th className="px-4 py-2">Location</th>
                    </>
                  ) : (
                    <>
                      <th className="px-4 py-2">Company</th>
                      <th className="px-4 py-2">Domain</th>
                      <th className="px-4 py-2">Industry</th>
                      <th className="px-4 py-2">Employees</th>
                      <th className="px-4 py-2">Location</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {mode === "people"
                  ? people.map((p) => (
                      <tr key={p.id} className="border-b border-[var(--rule)] last:border-0 hover:bg-[var(--paper)]">
                        <td className="px-4 py-2.5 align-top">
                          <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleOne(p.id)} />
                        </td>
                        <td className="px-4 py-2.5 align-top font-medium text-[var(--ink)]">{personLabel(p)}</td>
                        <td className="px-4 py-2.5 align-top text-[var(--ink-soft)]">{p.title || EMPTY_CELL}</td>
                        <td className="px-4 py-2.5 align-top text-[var(--ink-soft)]">
                          {p.organizationName || p.organizationDomain || EMPTY_CELL}
                        </td>
                        <td className="px-4 py-2.5 align-top text-[var(--ink-soft)]">{p.email || EMPTY_CELL}</td>
                        <td className="px-4 py-2.5 align-top text-[var(--ink-soft)]">
                          {[p.city, p.state].filter(Boolean).join(", ") || EMPTY_CELL}
                        </td>
                      </tr>
                    ))
                  : companies.map((c) => (
                      <tr key={c.id} className="border-b border-[var(--rule)] last:border-0 hover:bg-[var(--paper)]">
                        <td className="px-4 py-2.5 align-top">
                          <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggleOne(c.id)} />
                        </td>
                        <td className="px-4 py-2.5 align-top font-medium text-[var(--ink)]">{c.name || EMPTY_CELL}</td>
                        <td className="px-4 py-2.5 align-top text-[var(--ink-soft)]">{c.domain || EMPTY_CELL}</td>
                        <td className="px-4 py-2.5 align-top text-[var(--ink-soft)]">{c.industry || EMPTY_CELL}</td>
                        <td className="px-4 py-2.5 align-top text-[var(--ink-soft)]">
                          {c.estimatedEmployees ?? EMPTY_CELL}
                        </td>
                        <td className="px-4 py-2.5 align-top text-[var(--ink-soft)]">
                          {[c.city, c.state].filter(Boolean).join(", ") || EMPTY_CELL}
                        </td>
                      </tr>
                    ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
