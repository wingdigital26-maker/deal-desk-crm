// How well the banker knows a person. Plain module: safe on server and client.
import { firm } from "../../firm.config";

export const RELATIONSHIPS = ["knows-well", "knows", "met", "not-yet"] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const RELATIONSHIP_LABELS: Record<Relationship, string> = {
  "knows-well": "Knows well",
  knows: "Knows",
  met: "Has met",
  "not-yet": "Does not know yet",
};

/** Knows well or knows: the people the banker can actually call. */
export const KNOWN: Relationship[] = ["knows-well", "knows"];

export const isRelationship = (v: unknown): v is Relationship => typeof v === "string" && (RELATIONSHIPS as readonly string[]).includes(v);

/** The banker's first name from firm.config.ts, for labels like "People Jordan knows". */
export const bankerFirstName = () => firm.sender.name.split(" ")[0];
