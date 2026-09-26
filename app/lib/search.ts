// Global search (P3): one query across companies, people and deals. Prepared
// LIKE queries with the wildcard characters escaped, a fixed cap per kind, and
// an empty or blank query returns nothing (never the whole database).
import { db } from "./db";

export type SearchCompany = { id: number; name: string; domain: string | null; city: string | null; state: string | null };
export type SearchContact = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  email: string | null;
  company_id: number | null;
  company_name: string | null;
};
export type SearchDeal = { id: number; title: string; stage: string; company_id: number; company_name: string };
export type SearchResults = { q: string; companies: SearchCompany[]; contacts: SearchContact[]; deals: SearchDeal[] };

export const SEARCH_LIMIT = 8;
const MAX_QUERY = 100;

/** `%term%` with \, % and _ escaped so a user's "50%" matches literally. Use with ESCAPE '\'. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function globalSearch(raw: string | null | undefined, limit = SEARCH_LIMIT): SearchResults {
  const q = (raw ?? "").trim().slice(0, MAX_QUERY);
  if (!q) return { q, companies: [], contacts: [], deals: [] };
  const n = Math.max(1, Math.min(50, Math.floor(limit) || SEARCH_LIMIT));
  const p = likePattern(q);

  const companies = db()
    .prepare(
      `SELECT id, name, domain, city, state FROM companies
       WHERE name LIKE ? ESCAPE '\\' OR domain LIKE ? ESCAPE '\\'
       ORDER BY (name LIKE ? ESCAPE '\\') DESC, name COLLATE NOCASE LIMIT ?`
    )
    .all(p, p, likePattern(q).slice(1), n) as SearchCompany[];

  const contacts = db()
    .prepare(
      `SELECT c.id, c.first_name, c.last_name, c.title, c.email, c.company_id, co.name AS company_name
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
       WHERE c.first_name LIKE ? ESCAPE '\\' OR c.last_name LIKE ? ESCAPE '\\'
          OR (COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) LIKE ? ESCAPE '\\'
          OR c.email LIKE ? ESCAPE '\\' OR c.title LIKE ? ESCAPE '\\'
       ORDER BY c.last_name COLLATE NOCASE, c.first_name COLLATE NOCASE, c.id LIMIT ?`
    )
    .all(p, p, p, p, p, n) as SearchContact[];

  const deals = db()
    .prepare(
      `SELECT d.id, d.title, d.stage, d.company_id, co.name AS company_name
       FROM deals d JOIN companies co ON co.id = d.company_id
       WHERE d.title LIKE ? ESCAPE '\\' OR co.name LIKE ? ESCAPE '\\'
       ORDER BY d.updated_at DESC, d.id DESC LIMIT ?`
    )
    .all(p, p, n) as SearchDeal[];

  return { q, companies, contacts, deals };
}
