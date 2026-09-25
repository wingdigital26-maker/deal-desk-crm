// Plain-English labels for compliance/outbound statuses and audit actions.
// Code identifiers (db values, action strings) never change; only the copy shown to a
// banker or compliance principal changes here.

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending: "Waiting for approval",
  approved: "Approved",
  rejected: "Sent back",
  retired: "Retired",
};

export const STATUS_TONE: Record<string, string> = {
  draft: "text-[var(--ink-soft)] border-[var(--rule)]",
  pending: "text-[var(--warn)] border-[var(--warn)]/40",
  approved: "text-[var(--good)] border-[var(--good)]/40",
  rejected: "text-[var(--bad)] border-[var(--bad)]/40",
  retired: "text-[var(--ink-faint)] border-[var(--rule)]",
};

export function statusLabel(status: string): string {
  return STATUS_LABEL[status] ?? status;
}

// Audit trail: readable action names. The raw action string is always kept
// visible in a secondary column, this is only the friendly headline.
export const ACTION_LABEL: Record<string, string> = {
  "template.create": "Created email content",
  "template.edit": "Edited email content",
  "template.submit": "Submitted for approval",
  "template.approve": "Approved email content",
  "template.reject": "Sent back for changes",
  "auth.login": "Signed in",
  "auth.login_failed": "Failed sign-in attempt",
  "auth.logout": "Signed out",
};

export function actionLabel(action: string): string {
  return ACTION_LABEL[action] ?? action;
}
