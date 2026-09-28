// WALLS demo block (need-to-know deal access and code names). Paste into
// scripts/seed-demo.mjs just before the "// 18. Summary" section.
// Gives three open deals project code names and puts the member user (id 3)
// on exactly four deal teams, so signing in as the member shows a walled
// pipeline. Deterministic: picks by stage order, then deal id.
{
  const OPEN = ["LOI", "In Market", "Engaged", "NDA", "In Dialogue", "Contacted", "Sourced"];
  const open = deals
    .filter((d) => OPEN.includes(d.stage))
    .sort((a, b) => OPEN.indexOf(a.stage) - OPEN.indexOf(b.stage) || a.id - b.id);

  const setCode = db.prepare("UPDATE deals SET code_name = ? WHERE id = ?");
  const codeNames = ["Project Juniper", "Project Falcon", "Project Harbor"];
  const coded = open.slice(0, codeNames.length);
  coded.forEach((d, i) => setCode.run(codeNames[i], d.id));

  // The member sees only the deals they work: off every team and ownership first,
  // then onto four teams (two of the code-named deals and two earlier-stage ones).
  const MEMBER = 3;
  db.prepare("DELETE FROM deal_team WHERE user_id = ?").run(MEMBER);
  db.prepare("UPDATE deals SET owner_user_id = NULL WHERE owner_user_id = ?").run(MEMBER);
  const memberDeals = [coded[0], coded[2], ...open.slice(codeNames.length).filter((_, i) => i % 3 === 0).slice(0, 2)].filter(Boolean);
  const insTeam = db.prepare("INSERT OR IGNORE INTO deal_team (deal_id, user_id, role, added_at) VALUES (?,?,?,?)");
  memberDeals.forEach((d, i) => insTeam.run(d.id, MEMBER, i === 0 ? "execution" : "analyst", isoDateTime(daysFromToday(-20 + i))));

  console.log(`  walls: ${coded.length} code names (${codeNames.slice(0, coded.length).join(", ")}), member on ${memberDeals.length} deal teams`);
}
