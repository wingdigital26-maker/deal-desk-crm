// Honest setup state for when Apollo is not configured. No fake results, no
// sample rows, and never implies a search could return anything right now.
import EmptyState from "../crm/EmptyState";

export default function ApolloSetupNotice() {
  return (
    <EmptyState
      title="Apollo is not connected"
      detail="This desk has not connected an Apollo account, so no search can run and no results can show here yet. Connecting it takes a server setting only the maintainer can set."
      action={
        <details className="text-left text-xs text-[var(--ink-faint)]">
          <summary className="cursor-pointer select-none">For whoever maintains this</summary>
          <p className="mt-2 max-w-md">
            Set <code className="rounded bg-[var(--paper)] px-1 py-0.5 text-[var(--ink)]">APOLLO_API_KEY</code> in
            the server environment, then reload this page.
          </p>
        </details>
      }
    />
  );
}
