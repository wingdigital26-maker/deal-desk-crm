// Touch cadence: contacts with a "touch every N days" reminder whose last
// touch (any note, call, email or meeting on their timeline) is older than N
// days, or who have never been touched. Feeds the Today page.
import { db } from "./db";

export type DueRelationship = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  company_id: number | null;
  company_name: string | null;
  touch_every_days: number;
  last_touch_at: string | null;
  days_since: number | null;
};

const TOUCH_KINDS = "('note','call','email-out','email-in','meeting')";

export function relationshipsDue(limit = 50): DueRelationship[] {
  return db()
    .prepare(
      `SELECT * FROM (
         SELECT c.id, c.first_name, c.last_name, c.company_id, co.name AS company_name, c.touch_every_days,
                (SELECT MAX(a.created_at) FROM activities a WHERE a.contact_id = c.id AND a.kind IN ${TOUCH_KINDS}) AS last_touch_at
         FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.touch_every_days IS NOT NULL AND c.do_not_contact = 0
       ) t
       WHERE t.last_touch_at IS NULL OR t.last_touch_at <= datetime('now', '-' || t.touch_every_days || ' days')
       ORDER BY (t.last_touch_at IS NOT NULL), t.last_touch_at ASC
       LIMIT ?`
    )
    .all(limit)
    .map((r) => {
      const row = r as Omit<DueRelationship, "days_since">;
      const days = row.last_touch_at
        ? Math.floor((Date.now() - new Date(row.last_touch_at.replace(" ", "T") + "Z").getTime()) / 86400000)
        : null;
      return { ...row, days_since: days };
    });
}
