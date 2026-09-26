// Outlook / Microsoft Graph auto-capture settings. OFF by default: nothing in
// this folder makes a network call unless GRAPH_CAPTURE_ENABLED is exactly "1"
// AND every credential below is set. Values are read from process.env at call
// time only. Never log them, echo them to a client, or persist them.

export type GraphConfig = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  mailbox: string;
};

export type GraphStatus = {
  enabled: boolean;
  configured: boolean;
  missing: string[];
};

const REQUIRED = ["GRAPH_TENANT_ID", "GRAPH_CLIENT_ID", "GRAPH_CLIENT_SECRET", "GRAPH_MAILBOX"] as const;

export function graphEnabled(): boolean {
  return process.env.GRAPH_CAPTURE_ENABLED === "1";
}

export function graphStatus(): GraphStatus {
  const missing = REQUIRED.filter((k) => !(process.env[k] || "").trim());
  return { enabled: graphEnabled(), configured: missing.length === 0, missing: [...missing] };
}

/** The full config, or null when capture is off or any value is missing. */
export function graphConfig(): GraphConfig | null {
  const s = graphStatus();
  if (!s.enabled || !s.configured) return null;
  return {
    tenantId: process.env.GRAPH_TENANT_ID!.trim(),
    clientId: process.env.GRAPH_CLIENT_ID!.trim(),
    clientSecret: process.env.GRAPH_CLIENT_SECRET!.trim(),
    mailbox: process.env.GRAPH_MAILBOX!.trim(),
  };
}

/** Plain-English reason capture will not run, or null when it can. */
export function graphRefusal(): string | null {
  const s = graphStatus();
  if (!s.enabled) return "Outlook capture is turned off. Set GRAPH_CAPTURE_ENABLED=1 after the firm signs off.";
  if (!s.configured) return `Outlook capture is not set up yet. Missing: ${s.missing.join(", ")}.`;
  return null;
}
