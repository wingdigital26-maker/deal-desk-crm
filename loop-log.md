# loop-log.md: banker-harness / dashboard
| round | capture | mechanical gate | judge A | judge C | better? | fix scope | note |
|---|---|---|---|---|---|---|---|

## Stage 2 diverge, 2026-09-19 (round-0, overall TILES, no gate at this stage)
Three tiles captured at 1440x900 into .visual/round-0/tiles (a, b, c, contact). Same screen and content per .visual/tiles/CONTENT.md.
Orchestrator notes from the pixels (not a decision; Jack decides):
- A Quiet Ledger: brand-faithful and calm. Defects: TWO filled blue actions at once; names and "Do not contact" truncated; email body set in Playfair (a display face) reads heavy.
- B The Letter: the letter sheet is the strongest single element of the three (true measure, signature block, countersignature-style approval). Defects: table wraps to 3 lines and mixes mono for city/dates; "Do not contact" clipped; an em dash after "Subject" (hard-rule violation); dark red primary.
- C The Desk: best table (full names, alignment, density, quiet summary line). Defects: TWO filled amber actions at once; em dash after "Subject"; letter narrower and less of a document than B.
Status: WAITING ON JACK (Stage 2 decider). No page code before the pick.

## Round 1, 2026-09-20 (Stage 3 build applied Quiet Ledger; Stage 4 capture to .visual/round-1)
| stage | result | notes |
|---|---|---|
| capture | 12 shots, 0 console errors | demo workspace, 1440 + two at 375; scripted state (3 rows selected + panel open; principal on the trust screen) |
| crawl (36 page loads) | PASS | 0 console errors, 0 overflow, never more than 1 filled action after the fix lane. Caught before it: nested anchors in DataTable mobile rows broke hydration on every table page (fixed e62e516) |
| rule check | PASS | 0 shadows, 0 raw hex, 0 firm-name leaks, em dashes only in the two files that test the rule |
| orchestrator pixel read | FAIL, go to Stage 7 without spending judges | contacts panel covers the table and opens empty, panel heading in the display face; Today right column runs off the viewport; Outbound table prints ISO dates and repeats a status 12 times; trust screen omits the legal footer, uses green and red buttons and a monospace reference, renders a first version as an all-green diff; navy rail stops at 900px on long pages; pipeline cards dominated by a large Move select |
| Stage 7 | 3 scoped fix lanes out | contacts-panel, today-outbound-pipeline, trust-screen-rail; acceptance = recapture + crawl |
Judgments spent: 0 of 10.

## Round 2, 2026-09-20 (capture .visual/round-2; verdicts in judge-A.json and judge-C.json)
| stage | result | notes |
|---|---|---|
| Stage 7 fixes from round 1 | landed | contacts panel reflows + opens on the approved letter; Today fits; ramp table in plain dates; quiet Move control; trust screen shows the footer, one accent; phone-width overflow fixed at the root |
| crawl (36 loads, content-filled demo data) | PASS | 0 console errors, 0 overflow, max 1 enabled filled action |
| Judge A brief fidelity (Fable 5.1, 3 orderings) | FAIL | U4 Us3 C3 B3, no tells, better_than_previous true. Gaps: 3 filled buttons on company detail + pale-accent disabled state; Replies/Queue column widths and raw dates; countersignature undersold; Signals spends the accent on links |
| Judge C slop detector (Fable 5.1, 3 orderings) | FAIL | U4 Us3 C3 B3, tells: stock-everything, blank-region. Cleared: anthropic-clusters, eyebrow-microlabels, uniform-radius. Gaps: table column fit and single row height; native selects and date input; one owned device on sign-in + sidebar |
| orchestrator correction | noted | the "rail stops at 900px" defect reported in round 1 was a full-page-screenshot artifact of a sticky 100vh element, not a bug; captures are viewport-height now |
| crawler blind spot | noted | it counts only ENABLED filled buttons; a disabled pale-accent button still reads as a fill to a human. Judge A caught it |
Judgments spent: 2 of 10. Round 3 = scoped fixes on the converged gaps, then recapture and re-judge. Cap is 4 rounds.

## Round 3, 2026-09-20 (capture .visual/round-3; verdicts in judge-A.json and judge-C.json; fresh judges, no access to earlier verdicts)
| stage | result | notes |
|---|---|---|
| Stage 7 fixes from round 2 | landed | single-line equal-height tables with flexible columns; human dates; styled select + date; disabled = outline; ink links; ledger Mark + ruling on sign-in; Countersignature block; full-height pipeline columns |
| integration regression | caught + fixed by orchestrator | nowrap-by-default broke Companies, Signals, Audit on desktop (no flexible column declared). Crawl back to 36/0 |
| Judge A brief fidelity | FAIL | U4 Us4 C3 B3, tell: stacked-separation. better_than_previous true |
| Judge C slop detector | FAIL | U3 Us3 C3 B3, tells: blank-region, stacked-separation, eyebrow-microlabels, even-spacing. better_than_previous true |
| CONVERGED #1 (both judges) | real bug | approval screen prints "DATE an unknown date"; the queue panel no longer shows approver, date and reference in the first viewport. Regression introduced by the round-3 Countersignature change |
| converged, smaller | open | sign-in ruling cuts through the text and the sentence is stranded; panel Template select still native; browser-blue checkboxes compete with the accent; last header cell larger than its neighbours; table nested in bordered card = 3 layers; "Overdue" wraps on one pipeline card; Replies "First line" squeezed |
| ORCHESTRATOR ERROR | fixed | design-brief.md pinned tokens, references and borrowed/original were BLANK since 09-19: the pin script's anchors missed on CRLF and printed success without verifying. Judges in rounds 2 and 3 graded against an incomplete brief plus the prompt. Re-pinned with an assertion (.ja/brief_pin2.js) |
Judgments spent: 4 of 10. Round 4 is the LAST under the cap: scoped to the converged items only. If it does not pass, the rule applies: the brief or reference is the problem and it goes back to Jack, not to a round 5.

## 2026-09-20 sign-in replaced (Jack's direct instruction, outside the judged loop)
Jack: "change the sign in to the os sign in for wing digital". The sign-in now uses the Wing Digital OS house style (obsidian background, centred card, Wing mark with glow, gradient Enter button). This is a DELIBERATE, scoped exception to Quiet Ledger's refusal (it has a shadow, a gradient and a glow); all of it lives in the `.os-signin` block of app/globals.css. The ledger monogram + ruling sign-in from round 3 is retired. Any future judge must be told the sign-in is out of scope for the Quiet Ledger rules.

## Sign-in refine (2026-09-21)
Improved within the Wing Digital OS dark style (kept per Jack's 2026-09-20 call): visible Email/Password labels (was placeholder-only), left-aligned fields, Show/Hide password toggle, stronger 22px "Deal Desk" title, button "Enter"->"Sign in" and live (dropped empty-disable), spacing rhythm. All values stay in the .os-signin CSS block.
Conversion lint: labels/16px/contrast PASS. A7 (Show target <44px) fixed to min-height 44. A1/A2 "login wall" = FAIL by the rule but CORRECT for an internal bank CRM (rule targets consumer first-value; brand/context wins per skill). Captures: .visual/signin-base (before) vs .visual/signin-r1 (after).

## Today screen refine (2026-09-21)
Added a "desk at a glance" stat strip (4 accent-rail tiles: Open deals, Going quiet, Replies to handle, Signals this week) above the two-column grid. Fills the empty column on quiet days and gives an at-a-glance pulse; each tile links to its screen. Live counts (cheap COUNT queries), honest zeros. Quiet Ledger tokens only. tsc clean, slop lint clean. Captures: .visual/app-base/home.png (before) vs .visual/app-r1/home.png (after). Added scripts/auth_capture.py (dev-only Playwright login+shoot helper) so authed screens can be captured for the visual loop.
