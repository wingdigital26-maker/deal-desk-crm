// Demo-mode policy, kept free of Node imports so proxy.ts can use it.
// See app/lib/demo.ts for what demo mode is.
export const isDemo = () => process.env.DEAL_DESK_DEMO === "1";

export const DEMO_REFUSAL = "Not available in the demo. This is a sample workspace, so nothing here connects to outside services or sends email.";

/** API paths that would reach an outside service, spawn a process, or touch credentials. */
const BLOCKED: RegExp[] = [
  /^\/api\/apollo(\/|$)/,
  /^\/api\/capture(\/|$)/,
  /^\/api\/outbound\/instantly(\/|$)/,
  /^\/api\/outbound\/run(\/|$)/,
  /^\/api\/replies\/(sync|instantly|ingest)(\/|$)/,
  /^\/api\/companies\/[^/]+\/profile\/refresh(\/|$)/,
  /^\/api\/auth\/(password|login)(\/|$)/,
  /^\/api\/users\/[^/]+\/(reset-password|disable|restore)(\/|$)/,
];

export function demoBlocks(pathname: string, method: string): boolean {
  if (BLOCKED.some((re) => re.test(pathname))) return true;
  // Creating or editing users means passwords; keep the user list read-only.
  if (/^\/api\/users(\/|$)/.test(pathname) && method !== "GET") return true;
  // No file uploads from the public: demo documents are sample rows only.
  if (/^\/api\/documents\/?$/.test(pathname) && method === "POST") return true;
  return false;
}
