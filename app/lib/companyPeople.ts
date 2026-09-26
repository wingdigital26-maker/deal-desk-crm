// Everyone at a company: people whose primary company it is, plus current
// (no end date) links through contact_companies. Ordered by how well the
// banker knows them, then name. Feeds the deal page and the pipeline.
import { db } from "./db";

export type Person = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  role: string | null;
  email: string | null;
  phone: string | null;
  relationship: string | null;
  do_not_contact: number;
  last_touch_at: string | null;
};

const RANK = `CASE c.relationship WHEN 'knows-well' THEN 0 WHEN 'knows' THEN 1 WHEN 'met' THEN 2 WHEN 'not-yet' THEN 4 ELSE 3 END`;

export function peopleAtCompany(companyId: number): Person[] {
  return db()
    .prepare(
      `SELECT c.id, c.first_name, c.last_name, c.title, cc.role, c.email, c.phone, c.relationship, c.do_not_contact,
              (SELECT MAX(a.created_at) FROM activities a WHERE a.contact_id = c.id AND a.kind IN ('note','call','meeting','email-out','email-in')) AS last_touch_at
       FROM contacts c
       LEFT JOIN contact_companies cc ON cc.contact_id = c.id AND cc.company_id = ?
       WHERE c.company_id = ? OR (cc.id IS NOT NULL AND cc.end_date IS NULL)
       ORDER BY ${RANK}, c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE`
    )
    .all(companyId, companyId) as Person[];
}
