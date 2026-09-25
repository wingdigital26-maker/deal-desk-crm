#!/usr/bin/env python3
"""Log into Deal Desk and screenshot the authed screens. Dev-only helper.
Usage: SEED_PASSWORD=... python scripts/auth_capture.py <out-dir> [route ...]"""
import os, sys, pathlib
from playwright.sync_api import sync_playwright

BASE = "http://localhost:4761"
EMAIL = os.environ.get("DESK_EMAIL", "owner@harness.local")
PW = os.environ["DESK_PW"]
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
routes = sys.argv[2:] or ["/"]

def slug(r): return "home" if r == "/" else r.strip("/").replace("/", "-")

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1440, "height": 900})
    # authenticate via the API so the session cookie is set on the context,
    # avoiding form-hydration race conditions
    r = ctx.request.post(f"{BASE}/api/auth/login",
                         data={"email": EMAIL, "password": PW})
    if not r.ok:
        print("LOGIN FAILED", r.status); b.close(); sys.exit(2)
    pg = ctx.new_page()
    pg.goto(f"{BASE}/", wait_until="networkidle")
    if "/login" in pg.url:
        print("LOGIN FAILED - redirected to /login"); b.close(); sys.exit(2)
    print("logged in ->", pg.url)
    for r in routes:
        pg.goto(f"{BASE}{r}", wait_until="networkidle")
        pg.wait_for_timeout(600)
        f = out / f"{slug(r)}.png"
        pg.screenshot(path=str(f), full_page=True)
        print("shot", r, "->", f)
    b.close()
