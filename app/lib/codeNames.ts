// Deal code names ("Project Juniper"). Pure and client-safe: no database.
// When a deal has a code name, the seller report, exports and document default
// titles use it instead of the company name, and the Pipeline can hide real
// names entirely ("Show code names") so the screen can be shared.

export const CODE_NAME_PREF_KEY = "dealdesk.showCodeNames";

type Named = { code_name?: string | null; company_name?: string | null };

/** The code name when one is set, else the company name. */
export function dealDisplayName(d: Named): string {
  const code = d.code_name?.trim();
  return code || d.company_name || "Deal";
}

export const hasCodeName = (d: { code_name?: string | null }) => !!d.code_name?.trim();

/**
 * A copy of a pipeline deal with everything that identifies the company taken
 * out (name, website, city, people, and the free-text title, outcome, next step and last note), for
 * screen sharing. Deals without a code name come back unchanged: there is
 * nothing to stand in for them.
 */
export function maskDeal<
  T extends Named & {
    title: string;
    company_domain?: string | null;
    company_city?: string | null;
    company_state?: string | null;
    primary_contact_name?: string | null;
    primary_contact_title?: string | null;
    known_names?: string | null;
    last_note?: string | null;
    outcome?: string | null;
    next_step?: string | null;
  },
>(d: T): T & { masked?: boolean } {
  if (!hasCodeName(d)) return d;
  const code = d.code_name!.trim();
  return {
    ...d,
    company_name: code,
    title: code,
    company_domain: null,
    company_city: null,
    company_state: null,
    primary_contact_name: null,
    primary_contact_title: null,
    known_names: null,
    last_note: null,
    outcome: null,
    next_step: null,
    masked: true,
  };
}

// When storage is blocked the choice lives here for this visit.
let memoryPref: boolean | null = null;
const PREF_EVENT = "dealdesk:codenames";

export function writeCodeNamePref(on: boolean) {
  memoryPref = on;
  try {
    window.localStorage.setItem(CODE_NAME_PREF_KEY, on ? "1" : "0");
  } catch {
    // Private mode or blocked storage: the toggle still works for this visit.
  }
  window.dispatchEvent(new Event(PREF_EVENT));
}

/** For useSyncExternalStore: the saved choice, following other tabs too. */
export function subscribeCodeNamePref(onChange: () => void): () => void {
  window.addEventListener(PREF_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREF_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export const codeNamePrefSnapshot = (): boolean => {
  try {
    return window.localStorage.getItem(CODE_NAME_PREF_KEY) === "1";
  } catch {
    return memoryPref ?? false;
  }
};
