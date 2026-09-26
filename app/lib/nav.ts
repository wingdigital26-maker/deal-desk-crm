// Single source of truth for navigation. Never add literal nav arrays elsewhere.
// Only the main session edits this file.
//
// HARD-RULES L2 (Hick) / L3 (Miller), 2026-09-24: the rail offers at most 7
// choices. Sub-screens of a section carry `parent` and render as that
// section's tab bar (SectionTabs), not as rail items. Admin screens carry
// `place: "account"` and sit in the rail footer next to the signed-in user
// (Jakob: account things live with the account).
// 2026-09-25 (Jack): Tasks removed from the rail; People and Audit moved up
// into the rail itself. Rail is 8 for an owner, 7 for a principal.
import type { Role } from "./session";

export type NavItem = {
  href: string;
  label: string;
  group: "Work" | "Relationships" | "Admin";
  roles?: Role[];
  parent?: string;          // shown as a tab under this section, not in the rail
  place?: "rail" | "account";
};

export const NAV: NavItem[] = [
  { href: "/", label: "Today", group: "Work" },
  { href: "/pipeline", label: "Pipeline", group: "Work" },
  { href: "/outbound", label: "Outbound", group: "Work" },
  { href: "/companies", label: "Companies", group: "Relationships" },
  { href: "/contacts", label: "Contacts", group: "Relationships" },
  // 2026-09-26 (Jack): Sourcing is parked, one thing at a time. The /sourcing
  // routes still work; they are just not in the menu.
  { href: "/contacts/referrals", label: "Referral sources", group: "Relationships", parent: "/contacts" },
  { href: "/outbound/queue", label: "Queue", group: "Work", parent: "/outbound" },
  { href: "/outbound/replies", label: "Replies", group: "Work", parent: "/outbound" },
  { href: "/outbound/templates", label: "Templates", group: "Work", parent: "/outbound" },
  { href: "/outbound/approvals", label: "Approvals", group: "Work", parent: "/outbound", roles: ["owner", "principal"] },
  { href: "/outbound/mailboxes", label: "Mailboxes", group: "Work", parent: "/outbound" },
  { href: "/admin/users", label: "People", group: "Admin", roles: ["owner"] },
  { href: "/audit", label: "Audit", group: "Admin", roles: ["owner", "principal"] },
];

export const visibleTo = (role: Role) => NAV.filter((n) => !n.roles || n.roles.includes(role));

/** Tabs for a section: the section's own overview first, then its children. */
export function sectionTabs(parent: string, role: Role): { href: string; label: string }[] {
  const items = visibleTo(role);
  const head = items.find((n) => n.href === parent);
  const kids = items.filter((n) => n.parent === parent);
  return kids.length && head ? [{ href: head.href, label: "Overview" }, ...kids] : [];
}
