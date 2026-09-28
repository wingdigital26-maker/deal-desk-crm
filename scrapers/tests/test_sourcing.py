"""
Offline tests for the sourcing v2 scrapers: name -> domain generator, identity
matcher, fit classifier, owner extraction, officer-change and news matching, and
the pipeline's database writes. No network: every page is a fixture file.

  python -m unittest discover -s scrapers/tests -v
"""
import json
import os
import sqlite3
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import find_websites as fw  # noqa: E402
import fit_score as fs  # noqa: E402
import tx_officers as tx  # noqa: E402
import sourcing_signals as ss  # noqa: E402
import pipeline  # noqa: E402

FIX = os.path.join(HERE, "fixtures")


def page(name: str) -> str:
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return f.read()


class CandidateDomains(unittest.TestCase):
    def test_legal_words_stripped_and_spellings_ordered(self):
        c = fw.candidate_domains("BARNETT & MCKEE CABINETS, L.L.C.")
        self.assertEqual(c[0], "barnettmckeecabinets.com")
        self.assertIn("barnettandmckeecabinets.com", c)
        self.assertIn("barnett-mckee-cabinets.com", c)
        self.assertIn("barnettmckeecabinetstx.com", c)
        self.assertIn("bmcabinets.com", c)          # initials + last word
        self.assertIn("barnettmckeecabinets.net", c)
        self.assertIn("barnettmckeecabinets.us", c)
        self.assertFalse(any("llc" in d for d in c))

    def test_soft_words_dropped_from_core_but_kept_in_full(self):
        c = fw.candidate_domains("SOUTHERN STAR EQUIPMENT SERVICES, L.P.")
        self.assertEqual(c[0], "southernstarequipment.com")
        self.assertIn("southernstarequipmentservices.com", c)
        self.assertIn("southernstarequip.com", c)   # abbreviation

    def test_initials_names_and_filing_suffixes(self):
        self.assertEqual(fw.candidate_domains("N L INDUSTRIES, INC.")[0], "nlindustries.com")
        self.assertEqual(fw.candidate_domains("GAMTEX METALS II, L.P.")[0], "gamtexmetals.com")
        self.assertEqual(fw.candidate_domains("CB LUNA INDUSTRIAL NO. 1, LTD.")[0], "cblunaindustrial.com")
        self.assertEqual(fw.candidate_domains("THE TRADE GROUP - MANUFACTURING, LLC")[0], "trademanufacturing.com")

    def test_capped_and_unique(self):
        c = fw.candidate_domains("THE LIFTGATE PARTS COMPANY TEXAS HYDRAULIC & EQUIP", max_n=10)
        self.assertLessEqual(len(c), 10)
        self.assertEqual(len(c), len(set(c)))
        self.assertTrue(all(len(d.split(".")[0].replace("-", "")) >= 5 for d in c))

    def test_empty_name(self):
        self.assertEqual(fw.candidate_domains("LLC"), [])


class IdentityMatcher(unittest.TestCase):
    NAME = "BRAZOS VALLEY FABRICATION, INC."

    def test_confirmed_needs_name_and_texas_location(self):
        v = fw.judge(self.NAME, "Waxahachie", "1200 Industrial Blvd, Waxahachie, TX 75165",
                     [("https://brazosvalleyfab.com/", page("site_home.html"))], "brazosvalleyfab.com")
        self.assertEqual(v["verdict"], "confirmed")
        ev = " ".join(v["evidence"])
        self.assertIn("full name", ev)
        self.assertIn("city 'Waxahachie'", ev)
        self.assertIn("registered street address", ev)
        self.assertIn("area code 972", ev)

    def test_namesake_out_of_state_is_unconfirmed(self):
        v = fw.judge(self.NAME, "Waxahachie", None,
                     [("https://brazosvalleyfabrication.com/", page("namesake_ohio.html"))], "brazosvalleyfabrication.com")
        self.assertEqual(v["verdict"], "unconfirmed")
        self.assertIn("no Texas location", v["reason"])

    def test_parked_and_placeholder_rejected(self):
        v = fw.judge(self.NAME, "Waxahachie", None, [("https://brazosvalleyfab.com/", page("parked.html"))], "brazosvalleyfab.com")
        self.assertEqual((v["verdict"], v["reason"]), ("rejected", "parked page"))
        v = fw.judge(self.NAME, "Waxahachie", None, [("https://bvfab.com/", page("placeholder.html"))], "bvfab.com")
        self.assertEqual(v["verdict"], "rejected")
        self.assertIn("placeholder", v["reason"])

    def test_redirect_to_big_brand_rejected(self):
        v = fw.judge(self.NAME, "Waxahachie", None,
                     [("https://www.facebook.com/brazosvalleyfab", page("site_home.html"))], "brazosvalleyfab.com")
        self.assertEqual(v["verdict"], "rejected")
        self.assertIn("facebook.com", v["reason"])

    def test_page_that_does_not_name_the_company_rejected(self):
        v = fw.judge("PECOS INDUSTRIAL SUPPLY, LLC", "Odessa", None,
                     [("https://brazosvalleyfab.com/", page("site_home.html"))], "brazosvalleyfab.com")
        self.assertEqual(v["verdict"], "rejected")

    def test_word_match_with_only_a_distant_texas_zip_is_not_confirmed(self):
        # every name word is on the page, but only a Texas ZIP elsewhere in the state
        html = ("<html><head><title>Integrity Furniture</title></head><body><p>Integrity Furniture sells office "
                "furniture and equipment for schools and churches across the region, with delivery and install. "
                "Call our team for a quote on your next classroom, office or chapel project.</p>"
                "<p>Carthage, TX 75633 (903) 555-0100</p></body></html>")
        v = fw.judge("INTEGRITY FURNITURE AND EQUIPMENT, L.L.C.", "Richardson", "100 Main St, Richardson, TX 75080",
                     [("https://integrityfurniture.com/", html)], "integrityfurniture.com")
        self.assertEqual(v["verdict"], "unconfirmed")

    def test_full_name_with_a_texas_address_in_another_area_is_unconfirmed(self):
        html = page("site_home.html").replace("Waxahachie, TX 75165", "Corsicana, TX 75109").replace("Waxahachie", "Corsicana")
        v = fw.judge(self.NAME, "Dallas", "5430 Lyndon B Johnson Fwy, Dallas, TX 75240",
                     [("https://brazosvalleyfab.com/", html)], "brazosvalleyfab.com")
        self.assertEqual(v["verdict"], "unconfirmed")
        self.assertIn("another area", v["reason"])

    def test_location_evidence(self):
        ev = fw.location_evidence("Call (817) 555-0100. 500 Main, Fort Worth, Texas 76102", "Fort Worth", None)
        self.assertEqual(len(ev), 3)
        self.assertEqual(fw.location_evidence("Call (312) 555-0100, Chicago IL 60601", "Dallas", None), [])

    def test_registrable(self):
        self.assertEqual(fw.registrable("www.shop.acme.com"), "acme.com")
        self.assertEqual(fw.registrable("www.selectpackaging.co.uk"), "selectpackaging.co.uk")

    def test_redirect_to_unrelated_domain_rejected(self):
        v = fw.judge(self.NAME, "Waxahachie", None,
                     [("https://domainbroker.example/", page("site_home.html"))], "brazosvalleyfab.com")
        self.assertEqual(v["verdict"], "rejected")
        self.assertIn("unrelated domain", v["reason"])

    def test_redirect_to_a_name_bearing_domain_is_followed(self):
        v = fw.judge(self.NAME, "Waxahachie", None,
                     [("https://brazosvalleysteel.com/", page("site_home.html"))], "brazosvalleyfab.com")
        self.assertEqual(v["verdict"], "confirmed")
        self.assertTrue(any("redirects to brazosvalleysteel.com" in e for e in v["evidence"]))

    def test_generic_only_name_never_matches(self):
        html = "<html><head><title>Machinery</title></head><body>" + "<p>Machinery for sale in Dallas, TX 75201. " * 10 + "</p></body></html>"
        v = fw.judge("AMERICAN MACHINERY GROUP LLC", "Dallas", None, [("https://machinery.com/", html)], "machinery.com")
        self.assertEqual(v["verdict"], "rejected")


class FitClassifier(unittest.TestCase):
    def test_confirmed_manufacturer_scores_as_good_fit_with_reasons(self):
        r = fs.score_company("BRAZOS VALLEY FABRICATION, INC.", [("https://brazosvalleyfab.com/", page("site_home.html"))],
                             "confirmed", {"sos_charter_date": "1978-03-01"})
        self.assertGreaterEqual(r["fit_score"], fs.GOOD_FIT)
        self.assertEqual(r["industry"], "Manufacturing")
        text = " | ".join(x["reason"] for x in r["reasons"])
        for want in ("Operating website confirmed", "manufacturing", "founded 1978", "85 employees",
                     "45,000 square foot", "Fleet of about 12", "ISO 9001", "family ownership"):
            self.assertIn(want, text)
        self.assertTrue(all(x["url"].startswith("https://") for x in r["reasons"]))

    def test_pe_owned_is_penalised(self):
        r = fs.score_company("PECOS INDUSTRIAL SUPPLY, LLC", [("https://pecossupply.com/", page("pe_owned.html"))], "confirmed")
        self.assertEqual(r["industry"], "Distribution")
        self.assertTrue(any(x["points"] == -30 for x in r["reasons"]))
        self.assertLess(r["fit_score"], fs.GOOD_FIT)

    def test_public_parent_needs_the_site_to_say_so(self):
        import tx_registry as tr
        old = tr._SEC_NAMES
        tr._SEC_NAMES = {"arcosa", "atlas"}
        try:
            self.assertEqual(fs.public_parent("ARCOSA SHORING PRODUCTS, INC.", "Copyright 2026. Arcosa, Inc."),
                             ("Arcosa", "Arcosa, Inc."))
            self.assertIsNone(fs.public_parent("ATLAS HOSE & GASKET CO", "Atlas Hose and Gasket is family owned."))
            html = page("site_home.html").replace("Brazos Valley Fabrication, Inc.", "Brazos Valley Fabrication. Arcosa, Inc.")
            r = fs.score_company("ARCOSA SHORING PRODUCTS", [("https://arcosashoring.com/", html)], "confirmed")
            self.assertTrue(any("public company Arcosa" in x["reason"] and x["points"] == -30 for x in r["reasons"]))
        finally:
            tr._SEC_NAMES = old

    def test_exclusions_cap_the_score(self):
        for name, why in (("SMITH FAMILY HOLDINGS, LLC", "holding"), ("GRACE CHURCH MINISTRIES", "church"),
                          ("OAK PROPERTIES LTD", "property"), ("ARW INDUSTRIAL GP, LLC", "general-partner"),
                          ("MP PLASTIC SURGERY PLLC", "professional practice")):
            r = fs.score_company(name, [], "none", {"sos_charter_date": "1980-01-01"})
            self.assertLessEqual(r["fit_score"], 10, name)
            self.assertIn(why, r["exclusion"], name)

    def test_restaurant_site_excluded(self):
        r = fs.score_company("HILL COUNTRY SMOKEHOUSE LLC", [("https://hcsmoke.com/", page("restaurant.html"))], "confirmed")
        self.assertEqual(r["exclusion"], "restaurant")
        self.assertLessEqual(r["fit_score"], 10)

    def test_no_site_is_capped_and_uses_the_registry_year(self):
        r = fs.score_company("LINDEN STEEL, L.P.", [], "none", {"sos_charter_date": "1990-05-01"})
        self.assertLessEqual(r["fit_score"], 30)
        self.assertEqual(r["industry"], "Manufacturing")
        self.assertTrue(any("registry charter date 1990" in x["reason"] for x in r["reasons"]))

    def test_unconfirmed_site_text_is_never_read(self):
        r = fs.score_company("BRAZOS VALLEY FABRICATION, INC.", [("https://x.com/", page("site_home.html"))], "unconfirmed")
        self.assertLessEqual(r["fit_score"], 40)
        self.assertFalse(any("employees" in x["reason"] for x in r["reasons"]))


class Owners(unittest.TestCase):
    def test_only_owner_level_people_from_the_site(self):
        people = tx.people_from_pages([("https://brazosvalleyfab.com/", page("site_home.html"))])
        self.assertEqual([p["name"] for p in people], ["Dale Hollis"])
        self.assertIn("President", people[0]["title"])
        self.assertEqual(people[0]["url"], "https://brazosvalleyfab.com/")

    def test_parse_pir_skips_entities_and_dupes(self):
        data = {"success": True, "data": {"officerInfo": [
            {"AGNT_NM": "JANE DOE", "AGNT_TITL_TX": "PRESIDENT", "AGNT_ACTV_YR": "2025"},
            {"AGNT_NM": "JANE DOE", "AGNT_TITL_TX": "DIRECTOR", "AGNT_ACTV_YR": "2025"},
            {"AGNT_NM": "ACME HOLDINGS LLC", "AGNT_TITL_TX": "MANAGER"},
            {"AGNT_NM": "SMITH, JOHN", "AGNT_TITL_TX": "SECRETARY"},
        ]}}
        got = tx.parse_pir(data)
        self.assertEqual([(o["name"], o["title"]) for o in got], [("Jane Doe", "President"), ("John Smith", "Secretary")])

    def test_api_is_not_called_without_a_key(self):
        old = os.environ.pop("TX_COMPTROLLER_API_KEY", None)
        try:
            self.assertEqual(tx.fetch_pir_officers("12345678901")[2], "no-key")
        finally:
            if old is not None:
                os.environ["TX_COMPTROLLER_API_KEY"] = old


def mem_db() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:")
    con.row_factory = sqlite3.Row
    con.executescript("""
    CREATE TABLE companies (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, domain TEXT, segment_id TEXT NOT NULL DEFAULT 'owners',
      industry TEXT, city TEXT, state TEXT, employees INTEGER, revenue_band TEXT, source TEXT NOT NULL DEFAULT 'manual',
      signal_score REAL NOT NULL DEFAULT 0, notes TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE UNIQUE INDEX companies_domain ON companies(domain) WHERE domain IS NOT NULL;
    CREATE TABLE contacts (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, first_name TEXT, last_name TEXT, title TEXT,
      email TEXT, email_status TEXT, phone TEXT, linkedin_url TEXT, source TEXT NOT NULL DEFAULT 'manual', enriched_at TEXT,
      created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE signals (id INTEGER PRIMARY KEY AUTOINCREMENT, company_id INTEGER, kind TEXT NOT NULL, title TEXT NOT NULL,
      url TEXT, observed_at TEXT, weight REAL NOT NULL DEFAULT 1, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, actor_user_id INTEGER, actor_label TEXT, action TEXT NOT NULL,
      entity TEXT, entity_id INTEGER, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')));
    """)
    pipeline.ensure_schema(con)
    return con


class Signals(unittest.TestCase):
    def test_diff_officers(self):
        added, removed = ss.diff_officers(["Dale Hollis", "Marta Hollis"], ["dale hollis", "Sam Ortiz"])
        self.assertEqual((added, removed), (["Sam Ortiz"], ["Marta Hollis"]))

    def test_officer_change_only_after_a_baseline_and_deduped(self):
        con = mem_db()
        cid = con.execute("INSERT INTO companies (name) VALUES ('Brazos Valley Fabrication')").lastrowid
        tx.snapshot(con, cid, "tx-comptroller-pir", ["Dale Hollis"], "https://api.example/1", "2026-09-01 00:00:00")
        self.assertEqual(ss.officer_change_signals(con, cid), 0)          # baseline only
        tx.snapshot(con, cid, "tx-comptroller-pir", ["Marta Hollis"], "https://api.example/1", "2026-09-08 00:00:00")
        self.assertEqual(ss.officer_change_signals(con, cid), 1)
        self.assertEqual(ss.officer_change_signals(con, cid), 0)          # same change is not stored twice
        row = con.execute("SELECT kind, title, weight FROM signals").fetchone()
        self.assertEqual(row["kind"], "officer-change")
        self.assertIn("no longer listed: Dale Hollis", row["title"])
        self.assertEqual(row["weight"], 5.0)

    def test_owner_news_needs_surname_event_word_and_company_or_city(self):
        co = {"name": "BRAZOS VALLEY FABRICATION, INC.", "city": "Waxahachie"}
        self.assertTrue(ss.owner_news_match("Dale Hollis Obituary - Waxahachie, TX", "Dale Hollis", co))
        self.assertTrue(ss.owner_news_match("Hollis retires after 45 years at Brazos Valley", "Dale Hollis", co))
        self.assertFalse(ss.owner_news_match("Dale Hollis Obituary - Tulsa, OK", "Dale Hollis", co))
        self.assertFalse(ss.owner_news_match("Hollis named to Waxahachie chamber board", "Dale Hollis", co))

    def test_press_kind(self):
        self.assertEqual(ss.press_kind("www.bizjournals.com"), "business-journal")
        self.assertEqual(ss.press_kind("dallasnews.com"), "business-journal")
        self.assertEqual(ss.press_kind("example.com"), "news")


class PipelineWrites(unittest.TestCase):
    def setUp(self):
        self.con = mem_db()
        notes = json.dumps({"source": "tx-franchise-registry", "taxpayer_number": "32000000001",
                            "sos_charter_date": "1978-03-01", "registered_address": "1200 Industrial Blvd, Waxahachie, TX 75165"})
        self.cid = self.con.execute("INSERT INTO companies (name, city, state, source, notes) VALUES (?,?,?,?,?)",
                                    ("BRAZOS VALLEY FABRICATION, INC.", "Waxahachie", "TX", "tx-franchise-registry", notes)).lastrowid
        self.con.execute("INSERT INTO companies (name, source, website_checked_at) VALUES ('Old Co', 'apollo', datetime('now'))")
        self.con.commit()
        self.company = pipeline.select_companies(self.con, 10, None)[0]

    def gathered(self):
        company = self.company
        html = page("site_home.html")
        res = fw.judge(company["name"], company["city"], json.loads(company["notes"])["registered_address"],
                       [("https://brazosvalleyfab.com/", html)], "brazosvalleyfab.com")
        res.update(url="https://brazosvalleyfab.com/", pages=[("https://brazosvalleyfab.com/", html)], tried=[])
        people = tx.people_from_pages(res["pages"])
        return {"company": company, "notes": fw.registry_notes(company), "res": res, "pages": res["pages"],
                "status": "confirmed", "host": "brazosvalleyfab.com", "pir_status": "no-key", "people": people,
                "owner_source": tx.SITE_SOURCE, "mx": (True, "https://dns.google/resolve?type=MX&name=brazosvalleyfab.com"),
                "signals": [{"kind": "business-journal", "title": "Brazos Valley Fabrication expands in Waxahachie",
                             "url": "https://www.bizjournals.com/dallas/news/1", "observed_at": "2026-09-01", "weight": 3.0}],
                "seconds": 1.0}

    def test_selection_skips_recently_checked(self):
        ids = [c["id"] for c in pipeline.select_companies(self.con, 10, None)]
        self.assertEqual(ids, [self.cid])

    def test_apply_writes_domain_fit_owner_and_signal_then_is_resumable(self):
        out = pipeline.apply(self.con, self.gathered())
        self.con.commit()
        c = self.con.execute("SELECT domain, fit_score, website_checked_at, industry, signal_score FROM companies WHERE id=?",
                             (self.cid,)).fetchone()
        self.assertEqual(c["domain"], "brazosvalleyfab.com")
        self.assertGreaterEqual(c["fit_score"], fs.GOOD_FIT)
        self.assertIsNotNone(c["website_checked_at"])
        self.assertEqual(c["industry"], "Manufacturing")
        self.assertGreater(c["signal_score"], 0)
        reasons = self.con.execute("SELECT value, source_url FROM profile_facts WHERE entity_id=? AND field='fit_reasons'",
                                   (self.cid,)).fetchall()
        self.assertGreaterEqual(len(reasons), 5)
        self.assertTrue(all(r["source_url"].startswith("https://") for r in reasons))
        owner = self.con.execute("SELECT first_name, last_name, title, email, source FROM contacts WHERE company_id=?",
                                 (self.cid,)).fetchall()
        self.assertEqual([(o["first_name"], o["last_name"], o["email"], o["source"]) for o in owner],
                         [("Dale", "Hollis", None, "company-website")])
        self.assertEqual(out["signals"], {"business-journal": 1})
        # a second pass writes no duplicate contact, reason or signal
        pipeline.apply(self.con, self.gathered())
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM contacts").fetchone()[0], 1)
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM signals").fetchone()[0], 1)
        self.assertEqual(len(self.con.execute("SELECT id FROM profile_facts WHERE entity_id=? AND field='fit_reasons'",
                                              (self.cid,)).fetchall()), len(reasons))
        # resumable: the company is not picked again inside 30 days
        self.assertEqual(pipeline.select_companies(self.con, 10, None), [])

    def test_unconfirmed_site_never_writes_the_domain_or_owners(self):
        g = self.gathered()
        g["res"]["verdict"] = "unconfirmed"
        g["status"] = "unconfirmed"
        pipeline.apply(self.con, g)
        c = self.con.execute("SELECT domain FROM companies WHERE id=?", (self.cid,)).fetchone()
        self.assertIsNone(c["domain"])
        fact = self.con.execute("SELECT confidence FROM profile_facts WHERE entity_id=? AND field='website'", (self.cid,)).fetchone()
        self.assertEqual(fact["confidence"], "unconfirmed")
        self.assertEqual(self.con.execute("SELECT COUNT(*) FROM contacts").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
