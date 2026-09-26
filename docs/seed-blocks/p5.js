// P5 BANK / FIG demo block. Paste into scripts/seed-demo.mjs just before the
// "// 18. Summary" section. Turns on the regulatory tracker for three deals:
// an LOI deal mid-approval, a Closed deal fully approved, and an In Market deal
// still preparing its filings. Deterministic; dates are relative to today.
{
  const d = (n) => isoDate(daysFromToday(n));
  const loi = deals.find((x) => x.stage === "LOI");
  const closed = deals.find((x) => x.stage === "Closed");
  const market = deals.find((x) => x.stage === "In Market");
  const setFig = db.prepare("UPDATE deals SET fig_track = 1 WHERE id = ?");
  const insFiling = db.prepare(
    `INSERT INTO deal_regulatory_filings
       (deal_id, regulator, agency_label, filed_at, accepted_complete_at, public_notice_at, comment_end_at,
        approval_at, doj_concurrence, consummation_eligible_at, status, notes)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insVote = db.prepare(
    `INSERT INTO deal_shareholder_votes (deal_id, party, record_date, notice_mailed_at, meeting_at, result, votes_for_pct, notes)
     VALUES (?,?,?,?,?,?,?,?)`
  );
  let figFilings = 0;
  let figVotes = 0;

  if (loi) {
    setFig.run(loi.id);
    // FDIC: accepted, notice published, comment period ends in about 10 days.
    insFiling.run(loi.id, "FDIC", null, d(-40), d(-30), d(-20), d(10), null, 0, null, "accepted", "Comment period open. No protests received so far.");
    // State department: filed, waiting on acceptance.
    insFiling.run(loi.id, "STATE", "Texas Department of Banking", d(-38), null, null, null, null, 0, null, "filed", "Examiner asked for updated pro forma capital tables.");
    // Fed (holding company): accepted, approval pending.
    insFiling.run(loi.id, "FED", "Federal Reserve (holding company)", d(-45), d(-28), null, null, null, 0, null, "accepted", "Approval pending.");
    insVote.run(loi.id, "target", d(-5), d(3), d(35), "pending", null, "Proxy statement in final review.");
    insVote.run(loi.id, "acquirer", d(-3), d(6), d(38), "pending", null, null);
    figFilings += 3;
    figVotes += 2;
  }

  if (closed) {
    setFig.run(closed.id);
    insFiling.run(closed.id, "FDIC", null, d(-200), d(-185), d(-180), d(-150), d(-130), 1, d(-115), "approved", "DOJ concurrence shortened the wait to 15 days.");
    insFiling.run(closed.id, "STATE", "Texas Department of Banking", d(-198), d(-180), null, null, d(-140), 0, null, "approved", null);
    insFiling.run(closed.id, "FED", "Federal Reserve (holding company)", d(-200), d(-190), null, null, d(-120), 0, d(-90), "approved", null);
    insVote.run(closed.id, "target", d(-170), d(-160), d(-135), "approved", 91.2, null);
    insVote.run(closed.id, "acquirer", d(-168), d(-158), d(-134), "approved", 88.7, null);
    figFilings += 3;
    figVotes += 2;
  }

  if (market) {
    setFig.run(market.id);
    insFiling.run(market.id, "OCC", null, null, null, null, null, null, 0, null, "preparing", "Pre-filing meeting to schedule once a buyer is picked.");
    figFilings += 1;
  }

  console.log(`  P5 FIG: ${[loi, closed, market].filter(Boolean).length} deals on the regulatory tracker, ${figFilings} filings, ${figVotes} votes`);
}
