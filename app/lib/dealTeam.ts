// Deal team roles, shared by the team API and the deal page.
export const TEAM_ROLES = ["lead", "coverage", "execution", "analyst", "other"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const TEAM_ROLE_LABELS: Record<TeamRole, string> = {
  lead: "Lead banker",
  coverage: "Coverage",
  execution: "Execution",
  analyst: "Analyst",
  other: "Other",
};
