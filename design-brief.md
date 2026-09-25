# design-brief.md: banker-harness / dashboard
opened: 2026-09-19
judge_model: fable-5.1 (fallback: opus)   # one judge model for the whole build
builder_model: sonnet-5
budget_cap: 10 vision judgments (x3 orderings = 30 image calls), 4 rounds max

## The ONE conversion
A banker selects contacts, queues a principal-approved email, and trusts that nothing leaves without approval. Every screen is judged on whether it moves him toward that with confidence.

## Audience and intended psychological effect
- Primary: a senior investment banker in his 50s, not technical, skeptical of software, judges in the first 60 seconds. Effect wanted: calm, control, "this was built by people who understand my work".
- Secondary: the firm's compliance principal. Effect wanted: nothing hidden, exact content, who and when, a document under review rather than an app.
- Category cues to borrow from: private banking, legal and deal software (quiet, dense, typographic). Cues to refuse: startup SaaS (gradients, glow, playful empty states, emoji, pills everywhere).
- Surface: login-gated app (Next 16, Tailwind 4). Tokens are CSS variables in app/globals.css; primitives in app/components/ui and app/components/crm. A direction change is a token + primitive change.
- Option zero (current look): firm navy #0e2238 + warm paper #f7f4ee, Playfair Display h1 + Inter, accent #0079c2, radius 6px.
- Hard rules: Jack is the Stage 2 decider; no status or live dots; no em dashes; no fake data outside the labeled demo workspace; nothing firm-specific outside firm.config.ts.

## References (Stage 1): at least two, crossed with the brand
Full teardowns with sources and honesty notes: .visual/references.md
- Mercury (banking dashboard): warm neutral canvas, one accent, tabular numerals, density discipline. Validates the firm's navy and paper rather than replacing it.
- GitHub pull-request review: open the content, then decide; explicit named terminal actions. The mechanic for the approval trust screen.
- Linear (issue list): hairline-only separation; status as icon plus label, never a bare dot.
- Anti-references: gradient-card CRM dashboards; playful pastel or emoji workspaces. Both read as startup toys to a banker.
- Chosen cross: Mercury's discipline + GitHub's approval mechanics, on the firm's brand. Linear's status pattern as a tactical borrow.

## Diverge (Stage 2): three tiles in .visual/tiles/{a,b,c}.html, one decider
Three tiles rendered the same screen and content (.visual/tiles/CONTENT.md): A Quiet Ledger, B The Letter, C The Desk. Renders in .visual/round-0/tiles/.
decider: Jack, 2026-09-19: "Go with A and just make it better. I like A the most. Let's just work on A."
pinned tokens: QUIET LEDGER (tile .visual/tiles/a.html; live in app/globals.css)
- colour: navy #0e2238 (rail and text), paper #f7f4ee (canvas), surface #ffffff, hairline #e2ddd0, muted ink #5d574d, accent #0079c2 (the ONE dominant action per view, nothing else)
- type: Playfair Display 700 28/1.25 for the single page title only; Inter 600 15/1.3 headings; Inter 400 14/1.5 body; Inter 600 11 tracked .04em uppercase for table heads and field labels only; Inter 500 13 tabular numerals for numbers, dates and references
- radius scale 2 / 3 / 6 (inputs and tables / buttons / panels). spacing base 4. table row 44px, one line, one height
- refusal: no shadow anywhere; separation is a hairline or a tone step, and only ONE layer of it per list
- rules added by the judges' rounds: one filled action per view counting disabled buttons; disabled = outline; links are ink with an underline so the accent means the one action; status is icon plus text; human dates; the approval record (who, when, reference) is visible in the first viewport wherever an approved email is shown

## Borrowed vs original
borrow: Mercury's density discipline, tabular numerals and single accent; GitHub review's open-then-decide approval mechanics; Linear's icon plus label status and hairline separation
original: the firm's navy and paper; the operator voice; the letter as the unit of work; the approval record as a countersignature (who, when, reference) that travels with every approved email; an honest control room that states capacity in sentences

## Surface prerequisites
next dev on port 4761 (preview name banker-harness); screens need a session cookie (mint pattern in .ja/smoke.mjs); judge with the labeled demo workspace (data/demo.db), never the real database

## v4.1 pass (2026-09-24) — Jack's reference board applied
site_tier: 3 (internal app; the tier rule only bars 3D/sound from Tier 1 trade sites; this pass adds none)
route: kit-equivalent (Quiet Ledger stays the pinned direction; no new look, structure only)
scope: HARD-RULES section L (Fitts, Hick, Miller, Jakob, Proximity) + PATTERN-LIBRARY s3 app patterns.
Baseline measured (.visual/v41-base): rail offered 13 links (L2), Companies table 105 elements past the right edge at 1440,
KPI numbers same size as labels (s3), unlabelled filters (F1), phone targets < 44 (D6), label contrast 4.27 (C1).
Changes: rail cut to 7 (Outbound sub-screens -> section tab bar, admin -> account footer); page fixes by the Sonnet builder.
Lint note: the old "nav contrast 1.3" was a lint bug (Tailwind 4 color(srgb) parsed as 0-255); fixed in conversion_lint.py.
