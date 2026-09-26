// ---------------------------------------------------------------------------
// P4 DOCUMENTS: document ROWS only. The demo ships no real files, so every
// download in the demo answers "File not available in this workspace". The
// sha256 values are well-formed but fake (a hash of a label, not of a file).
// Paste into scripts/seed-demo.mjs just before "// 18. Summary".
// ---------------------------------------------------------------------------
{
  const fakeSha = (label) => createHash("sha256").update(`demo-document:${label}`, "utf8").digest("hex");
  const insDoc = db.prepare(
    `INSERT INTO documents (deal_id, deal_buyer_id, kind, title, doc_key, version, filename, mime, size, sha256, note, uploaded_by, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const PDF = "application/pdf";
  const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  // The deals with the busiest buyer logs get a full document set.
  const buyerRows = db
    .prepare("SELECT b.id, b.deal_id, b.stage, b.nda_signed_at, b.loi_at, c.name AS buyer_name FROM deal_buyers b JOIN companies c ON c.id = b.buyer_company_id WHERE b.removed_at IS NULL ORDER BY b.deal_id, b.id")
    .all();
  const byDeal = new Map();
  for (const r of buyerRows) {
    if (!byDeal.has(r.deal_id)) byDeal.set(r.deal_id, []);
    byDeal.get(r.deal_id).push(r);
  }
  const docDeals = [...byDeal.keys()].sort((a, b) => byDeal.get(b).length - byDeal.get(a).length || a - b).slice(0, 3);
  const CODENAMES = ["Falcon", "Juniper", "Harbor"];

  docDeals.forEach((dealId, i) => {
    const code = CODENAMES[i];
    const slug = code.toLowerCase();
    const at = (daysAgo, hour = 10) => {
      const d = daysFromToday(-daysAgo);
      d.setHours(hour, 15 + i * 7, 0, 0);
      return isoDateTime(d);
    };
    const base = 120 - i * 20; // older deals started earlier

    insDoc.run(dealId, null, "engagement_letter", `Project ${code} engagement letter`, `deal:${dealId}:engagement_letter`, 1,
      `Project ${code} - Engagement Letter (executed).pdf`, PDF, 286_412 + i * 1_337, fakeSha(`${dealId}:el:1`), "Countersigned by the seller.", 1, at(base));

    insDoc.run(dealId, null, "teaser", `Project ${code} teaser`, `deal:${dealId}:teaser`, 1,
      `Project ${code} Teaser.pdf`, PDF, 1_214_880 + i * 9_431, fakeSha(`${dealId}:teaser:1`), null, 3, at(base - 12));

    const cim = [
      [1, `Project ${code} CIM draft.docx`, DOCX, 3_902_114, "First draft for seller review.", 3, base - 20],
      [2, `Project ${code} CIM v2.pdf`, PDF, 6_481_227, "Seller comments incorporated.", 1, base - 26],
      [3, `Project ${code} CIM final.pdf`, PDF, 6_730_905, "Final, cleared for distribution under NDA.", 2, base - 30],
    ];
    for (const [ver, filename, mime, size, note, by, ago] of cim) {
      insDoc.run(dealId, null, "cim", `Project ${code} CIM`, `deal:${dealId}:cim`, ver, filename, mime, size + i * 4_111, fakeSha(`${dealId}:cim:${ver}`), note, by, at(ago, 9 + ver));
    }

    // NDAs for buyers who signed one (or, failing that, the first few on the log).
    const rows = byDeal.get(dealId);
    const signed = rows.filter((r) => r.nda_signed_at);
    const ndaRows = (signed.length ? signed : rows).slice(0, 6);
    ndaRows.forEach((r, j) => {
      const when = r.nda_signed_at || at(base - 14 - j);
      insDoc.run(dealId, r.id, "nda", `${r.buyer_name} NDA`, `buyer:${r.id}:nda`, 1,
        `${slug}-nda-executed-${String(j + 1).padStart(2, "0")}.pdf`, PDF, 188_000 + j * 2_417 + i * 311, fakeSha(`${r.id}:nda:1`), null, 1, when);
    });

    // An LOI for any buyer that got that far.
    rows
      .filter((r) => r.loi_at)
      .slice(0, 2)
      .forEach((r, j) => {
        insDoc.run(dealId, r.id, "loi", `${r.buyer_name} LOI`, `buyer:${r.id}:loi`, 1,
          `${slug}-loi-${String(j + 1).padStart(2, "0")}.pdf`, PDF, 402_551 + j * 5_003, fakeSha(`${r.id}:loi:1`), null, 1, r.loi_at);
      });
  });
  console.log(`P4 documents: ${db.prepare("SELECT COUNT(*) AS n FROM documents").get().n} rows on ${docDeals.length} deals (rows only, no files).`);
}
