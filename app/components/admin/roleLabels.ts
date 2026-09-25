// Plain-English labels for the role enum, shared between the People and
// Access UI and anywhere else a role needs to be shown to the banker.
import type { Role } from "../../lib/session";

export const ROLE_LABEL: Record<Role, string> = {
  owner: "Owner",
  principal: "Compliance principal",
  member: "Team member",
};

export const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "principal", label: "Compliance principal" },
  { value: "member", label: "Team member" },
];
