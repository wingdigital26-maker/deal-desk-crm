"use client";
// Section tab bar (PATTERN-LIBRARY s3 view switcher, Quiet Ledger form): a
// hairline row of text tabs, the active one ink with a 2px navy underline.
// Scrolls inside itself on phones so the page never overflows.
import Link from "next/link";
import { usePathname } from "next/navigation";

export default function SectionTabs({ tabs, label }: { tabs: { href: string; label: string }[]; label: string }) {
  const path = usePathname();
  const active = tabs
    .filter((t) => path === t.href || path.startsWith(t.href + "/"))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  if (!tabs.length) return null;
  return (
    <nav aria-label={label} className="section-tabs">
      <ul>
        {tabs.map((t) => (
          <li key={t.href}>
            <Link href={t.href} aria-current={active === t.href ? "page" : undefined}>
              {t.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
