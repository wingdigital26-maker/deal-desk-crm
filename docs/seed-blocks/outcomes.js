// OUTCOMES block: why a deal ended, the way a 4Degrees list reads.
{
  const setOutcome = db.prepare("UPDATE deals SET outcome = ? WHERE id = ?");
  const passReasons = ["Pass - owner not ready, revisit next year", "Pass - valuation expectations too high"];
  let p = 0;
  for (const d of deals) {
    if (d.stage === "Passed") setOutcome.run(passReasons[p++ % passReasons.length], d.id);
    if (d.stage === "Closed") setOutcome.run("Closed - sold to a strategic buyer", d.id);
    if (d.stage === "LOI") setOutcome.run("LOI signed, in exclusivity", d.id);
  }
}
