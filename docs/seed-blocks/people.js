// PEOPLE block: how well the banker knows the people at each deal company.
// Deterministic: first person knows-well, second knows, third met, rest unset.
{
  const setRel = db.prepare("UPDATE contacts SET relationship = ? WHERE id = ?");
  const ladder = ["knows-well", "knows", "met"];
  const seenCompanies = new Set();
  for (const d of deals) {
    if (seenCompanies.has(d.company_id)) continue;
    seenCompanies.add(d.company_id);
    const people = db.prepare("SELECT id FROM contacts WHERE company_id = ? AND do_not_contact = 0 ORDER BY id").all(d.company_id);
    // Early-stage deals: the banker often knows no one there yet.
    if (d.stage === "Sourced") continue;
    people.forEach((p, i) => {
      if (ladder[i]) setRel.run(ladder[i], p.id);
    });
  }
}
