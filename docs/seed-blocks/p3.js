// ---------------------------------------------------------------------------
// 17e. P3 relationships: referral sources with credit on deals, and people
// who hold roles at more than one company (contact_companies).
// Deterministic, no PRNG draws. Fictional people and firms only.
// ---------------------------------------------------------------------------
{
  // The app backfills this on first open; do it here too so the extra links
  // below sit beside every primary link from the start.
  db.exec(
    `INSERT OR IGNORE INTO contact_companies (contact_id, company_id, is_primary, created_at)
     SELECT id, company_id, 1, created_at FROM contacts WHERE company_id IS NOT NULL`
  );

  // Referral sources: one person at each of six referral-segment firms, kind from the firm.
  const refPeople = db
    .prepare(
      `SELECT MIN(c.id) AS id, co.industry FROM contacts c JOIN companies co ON co.id = c.company_id
       WHERE co.segment_id = 'referrals' AND c.do_not_contact = 0
       GROUP BY co.id ORDER BY co.id DESC LIMIT 6`
    )
    .all();
  const kindFor = (industry, i) => {
    const s = String(industry || "").toLowerCase();
    if (s.includes("cpa")) return "cpa";
    if (s.includes("attorney")) return "attorney";
    if (s.includes("wealth")) return "wealth-manager";
    return ["lender", "banker", "other"][i % 3];
  };
  const setKind = db.prepare("UPDATE contacts SET referral_kind = ? WHERE id = ?");
  refPeople.forEach((p, i) => setKind.run(kindFor(p.industry, i), p.id));

  // Credit six deals, including both Closed deals so credit shows fees.
  const byStage = (s) => deals.filter((d) => d.stage === s);
  const picked = [...byStage("Closed"), byStage("LOI")[0], byStage("In Market")[0], byStage("Engaged")[0], byStage("Passed")[0]].filter(Boolean);
  for (const d of deals) if (picked.length < 6 && !picked.includes(d)) picked.push(d);
  const credit = db.prepare("UPDATE deals SET referral_contact_id = ? WHERE id = ?");
  // The first source is the busiest: two deals, one of them Closed.
  const who = [0, 1, 0, 2, 3, 1];
  if (refPeople.length) {
    picked.slice(0, 6).forEach((d, i) => credit.run(refPeople[who[i] % refPeople.length].id, d.id));
  }

  // People with more than one company: board seats, outside counsel, a former CFO.
  const addLink = db.prepare(
    `INSERT OR IGNORE INTO contact_companies (contact_id, company_id, role, start_date, end_date, is_primary, created_at)
     VALUES (?,?,?,?,?,0,?)`
  );
  const owners = companies.filter((c) => c.segment_id === "owners").slice(0, 12);
  const institutions = companies.filter((c) => c.segment_id === "institutions");
  const ownerPeople = db
    .prepare(
      `SELECT c.id, c.company_id FROM contacts c JOIN companies co ON co.id = c.company_id
       WHERE co.segment_id = 'owners' AND c.do_not_contact = 0 ORDER BY c.id LIMIT 2`
    )
    .all();
  const now = isoDateTime(daysFromToday(-30));
  const links = [];
  if (refPeople[0] && owners[0]) links.push([refPeople[0].id, owners[0].id, "Board member", isoDate(daysFromToday(-1400)), null]);
  if (refPeople[1] && owners[1]) links.push([refPeople[1].id, owners[1].id, "Outside counsel", isoDate(daysFromToday(-900)), null]);
  if (refPeople[2] && owners[2]) links.push([refPeople[2].id, owners[2].id, "Trustee, family trust", isoDate(daysFromToday(-2000)), null]);
  if (refPeople[3] && institutions[0]) links.push([refPeople[3].id, institutions[0].id, "Advisory board", isoDate(daysFromToday(-700)), null]);
  const formerAt = ownerPeople[0] && owners.find((o) => o.id !== ownerPeople[0].company_id);
  if (formerAt) links.push([ownerPeople[0].id, formerAt.id, "Former CFO", isoDate(daysFromToday(-3200)), isoDate(daysFromToday(-1500))]);
  const investorAt = ownerPeople[1] && owners.find((o) => o.id !== ownerPeople[1].company_id && o.id !== formerAt?.id);
  if (investorAt) links.push([ownerPeople[1].id, investorAt.id, "Minority investor", isoDate(daysFromToday(-1100)), null]);
  for (const [contactId, companyId, role, start, end] of links) addLink.run(contactId, companyId, role, start, end, now);
}
