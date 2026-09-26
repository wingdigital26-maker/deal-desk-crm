"use client";
// App frame, Dashboards V2 (Jack's reference board, 2026-09-24):
// desktop = slim white icon rail (icon + short label, active = dark tile) and a
// top bar with search, date and the signed-in person; phone = top bar + a
// floating bottom tab bar in the thumb zone, full menu in a drawer. Reads NAV only.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { visibleTo, type NavItem } from "../lib/nav";
import type { SessionUser } from "../lib/session";
import { firm } from "../../firm.config";
import Mark from "./ui/Mark";
import {
  ActivityIcon,
  BuildingIcon,
  ColumnsIcon,
  FileTextIcon,
  ListIcon,
  MailIcon,
  SearchIcon,
  ShieldCheckIcon,
  UsersIcon,
  CalendarIcon,
} from "./ui/icons";

type IconT = (p: { className?: string }) => React.ReactNode;
const ICONS: Record<string, IconT> = {
  "/": CalendarIcon,
  "/pipeline": ColumnsIcon,
  "/tasks": ListIcon,
  "/outbound": MailIcon,
  "/companies": BuildingIcon,
  "/contacts": UsersIcon,
  "/sourcing": ActivityIcon,
  "/admin/users": ShieldCheckIcon,
  "/audit": FileTextIcon,
};
// The four screens a banker opens most sit in the phone's bottom bar.
const PHONE_TABS = ["/", "/pipeline", "/contacts", "/outbound"];

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export default function Shell({ user, demo = false, children }: { user: SessionUser; demo?: boolean; children: React.ReactNode }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const all = visibleTo(user.role);
  const items = all.filter((n) => !n.parent && n.place !== "account");
  const account = all.filter((n) => n.place === "account");
  const activeHref = [...items, ...account]
    .filter((n) => (n.href === "/" ? path === "/" : path === n.href || path.startsWith(n.href + "/")))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  const dateLabel = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

  const railLink = (n: NavItem) => {
    const Icon = ICONS[n.href] ?? CalendarIcon;
    const active = activeHref === n.href;
    return (
      <li key={n.href}>
        <Link
          href={n.href}
          aria-current={active ? "page" : undefined}
          title={n.label}
          className="group flex min-h-[60px] flex-col items-center justify-center gap-1 rounded-[14px] px-1 py-1.5 text-center"
        >
          <span
            className={`grid h-10 w-10 place-items-center rounded-[12px] transition-colors duration-200 ${
              active ? "bg-[var(--navy)] text-white" : "text-[var(--ink-soft)] group-hover:bg-[var(--paper)] group-hover:text-[var(--ink)]"
            }`}
          >
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <span className={`text-[11px] leading-tight ${active ? "font-semibold text-[var(--ink)]" : "text-[var(--ink-soft)]"}`}>
            {n.href === "/admin/users" ? "People" : n.href === "/audit" ? "Audit" : n.label}
          </span>
        </Link>
      </li>
    );
  };

  const drawerLink = (n: NavItem) => {
    const Icon = ICONS[n.href] ?? CalendarIcon;
    const active = activeHref === n.href;
    return (
      <li key={n.href}>
        <Link
          href={n.href}
          onClick={() => setOpen(false)}
          aria-current={active ? "page" : undefined}
          className={`flex min-h-[48px] items-center gap-3 rounded-[12px] px-3 text-[15px] ${
            active ? "bg-[var(--navy)] text-white" : "text-[var(--ink)] hover:bg-[var(--paper)]"
          }`}
        >
          <Icon className="h-[18px] w-[18px]" />
          {n.label}
        </Link>
      </li>
    );
  };

  return (
    <div className="app-shell min-h-screen bg-[var(--paper)] md:grid md:grid-cols-[88px_1fr]">
      {/* Desktop icon rail */}
      <aside className="hidden border-r border-[var(--rule)] bg-[var(--surface)] md:sticky md:top-0 md:flex md:h-screen md:flex-col md:items-center md:py-5">
        <Link href="/" aria-label={`${firm.productName} home`} className="mb-5 grid h-11 w-11 place-items-center rounded-[12px] bg-[var(--navy)]">
          <Mark size={24} tone="light" />
        </Link>
        <nav aria-label="Main" className="w-full flex-1 overflow-y-auto px-2">
          <ul className="flex flex-col gap-1">{items.map(railLink)}</ul>
        </nav>
        {account.length > 0 && (
          <ul aria-label="Account" className="flex w-full flex-col gap-1 border-t border-[var(--rule)] px-2 pt-3">
            {account.map(railLink)}
          </ul>
        )}
      </aside>

      <div className="flex min-w-0 flex-col">
        {/* Top bar */}
        <header className="sticky top-0 z-30 border-b border-[var(--rule)] bg-[var(--paper)]/90 backdrop-blur">
          <div className="mx-auto flex min-h-[64px] w-full max-w-[1240px] items-center gap-3 px-4 md:px-8">
          <span className="display inline-flex items-center gap-2 text-[18px] md:hidden"><Mark size={22} />{firm.productName}</span>
          <form action="/companies" method="get" role="search" className="hidden max-w-[420px] flex-1 md:block">
            <label htmlFor="global-search" className="sr-only">Search companies</label>
            <div className="flex h-11 items-center gap-2 rounded-full bg-[var(--surface)] px-4 shadow-[var(--shadow-card)]">
              <SearchIcon className="h-4 w-4 shrink-0 text-[var(--ink-faint)]" />
              <input
                id="global-search"
                name="q"
                type="search"
                autoComplete="off"
                placeholder="Search companies"
                className="h-full w-full bg-transparent text-[15px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-faint)]"
              />
            </div>
          </form>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden rounded-full bg-[var(--surface)] px-4 py-2.5 text-[13px] font-medium text-[var(--ink-soft)] shadow-[var(--shadow-card)] lg:inline-block">
              {dateLabel}
            </span>
            <details className="relative">
              <summary className="flex min-h-[44px] cursor-pointer list-none items-center gap-2 rounded-full bg-[var(--surface)] py-1 pl-1 pr-3 shadow-[var(--shadow-card)]">
                <span className="grid h-9 w-9 place-items-center rounded-full bg-[var(--tint-2)] text-[13px] font-bold text-[var(--ink)]">
                  {initials(user.name)}
                </span>
                <span className="hidden text-left leading-tight sm:block">
                  <span className="block text-[13px] font-semibold text-[var(--ink)]">{user.name}</span>
                  <span className="block text-[11px] capitalize text-[var(--ink-soft)]">{user.role}</span>
                </span>
              </summary>
              <div className="card absolute right-0 top-[calc(100%+8px)] z-40 w-52 p-2">
                <form action="/api/auth/logout" method="post">
                  <button className="flex min-h-[44px] w-full items-center rounded-[10px] px-3 text-left text-sm text-[var(--ink)] hover:bg-[var(--paper)]">
                    Sign out
                  </button>
                </form>
              </div>
            </details>
            <button
              onClick={() => setOpen(true)}
              aria-expanded={open}
              aria-controls="drawer"
              className="min-h-[44px] rounded-full bg-[var(--surface)] px-4 text-sm font-medium text-[var(--ink)] shadow-[var(--shadow-card)] md:hidden"
            >
              Menu
            </button>
          </div>
          </div>
        </header>

        {demo && (
          <div className="no-print w-full border-b border-[var(--rule)] bg-[var(--surface)] px-4 py-2 text-[13px] text-[var(--ink-soft)] md:px-8">
            Demo workspace. Sample data, sending disabled.
          </div>
        )}
        <main className="mx-auto w-full max-w-[1240px] min-w-0 px-4 pb-28 pt-6 md:px-8 md:pb-10 md:pt-8">{children}</main>
      </div>

      {/* Phone: floating bottom tab bar (thumb zone) */}
      <nav aria-label="Quick" className="fixed inset-x-3 bottom-3 z-30 md:hidden">
        <ul className="flex items-center justify-between rounded-full bg-[var(--navy)] p-1.5 shadow-[var(--shadow-lift)]">
          {PHONE_TABS.map((href) => items.find((n) => n.href === href))
            .filter((n): n is NavItem => !!n)
            .map((n) => {
              const Icon = ICONS[n.href] ?? CalendarIcon;
              const active = activeHref === n.href;
              return (
                <li key={n.href} className="flex-1">
                  <Link
                    href={n.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex min-h-[48px] flex-col items-center justify-center rounded-full text-[11px] ${
                      active ? "bg-white font-semibold text-[var(--ink)]" : "text-white/80"
                    }`}
                  >
                    <Icon className="h-[18px] w-[18px]" />
                    {n.label}
                  </Link>
                </li>
              );
            })}
        </ul>
      </nav>

      {open && (
        <div id="drawer" role="dialog" aria-modal="true" aria-label="Menu" className="fixed inset-0 z-50 bg-[var(--paper)] p-4 md:hidden">
          <div className="mb-4 flex items-center justify-between">
            <span className="display text-[20px]">{firm.productName}</span>
            <button onClick={() => setOpen(false)} className="min-h-[44px] rounded-full bg-[var(--surface)] px-4 text-sm font-medium shadow-[var(--shadow-card)]">
              Close
            </button>
          </div>
          <ul className="card flex flex-col gap-1 p-2">{items.map(drawerLink)}</ul>
          {account.length > 0 && <ul className="card mt-3 flex flex-col gap-1 p-2">{account.map(drawerLink)}</ul>}
        </div>
      )}
    </div>
  );
}
