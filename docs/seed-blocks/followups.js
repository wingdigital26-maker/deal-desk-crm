// ---------------------------------------------------------------------------
// FOLLOWUPS: the banker's next step with about eight buyers across the seeded
// buyer logs: two overdue, two due today, the rest over the next ten days.
// Deterministic (no PRNG draws), dates relative to today. Internal only: these
// never show on the seller report. Paste into scripts/seed-demo.mjs just
// before "// 18. Summary".
// ---------------------------------------------------------------------------
{
  const open = db
    .prepare(
      `SELECT b.id, b.deal_id, b.stage FROM deal_buyers b JOIN deals d ON d.id = b.deal_id
       WHERE b.removed_at IS NULL AND b.stage NOT IN ('closed', 'declined') AND d.stage NOT IN ('Closed', 'Passed')
       ORDER BY b.deal_id, b.id`
    )
    .all();
  // Round-robin across deals so every seeded buyer log gets some.
  const byDeal = new Map();
  for (const r of open) {
    if (!byDeal.has(r.deal_id)) byDeal.set(r.deal_id, []);
    byDeal.get(r.deal_id).push(r);
  }
  const queues = [...byDeal.values()];
  const picked = [];
  for (let round = 0; picked.length < 8 && queues.some((q) => q.length > round); round++) {
    for (const q of queues) if (q[round] && picked.length < 8) picked.push(q[round]);
  }

  const STEP = {
    teaser_sent: "Chase teaser read, offer NDA",
    nda_sent: "Chase NDA markup",
    nda_signed: "Send CIM and data room login",
    cim_sent: "Check CIM questions before IOI date",
    ioi: "Walk through IOI assumptions",
    mgmt_meeting: "Confirm management meeting agenda",
    loi: "Push for LOI markup",
    exclusivity: "Diligence call on QoE findings",
  };
  // Two overdue, two today, four upcoming.
  const OFFSETS = [-3, -1, 0, 0, 2, 4, 7, 10];
  const set = db.prepare("UPDATE deal_buyers SET next_step = ?, next_step_due = ? WHERE id = ?");
  picked.forEach((b, i) => set.run(STEP[b.stage] ?? "Follow up", isoDate(daysFromToday(OFFSETS[i])), b.id));
}
