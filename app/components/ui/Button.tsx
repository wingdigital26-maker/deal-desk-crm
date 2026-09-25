// The only button in the app. Every section uses this; no hand-rolled button classes.
import Link from "next/link";
import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

// accent  = THE one dominant action of a view (filled brand blue). At most one on screen.
// primary = the main action when no accent is present (filled navy). Never beside an accent.
// secondary = hairline outline. quiet = text only. danger = destructive.
type Variant = "accent" | "primary" | "secondary" | "quiet" | "danger";
type Size = "sm" | "md";

// min-h-[44px] on every size, every breakpoint: HARD-RULES D6, any tap target >= 44px.
const base = "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-[var(--radius)] font-semibold whitespace-nowrap transition-colors";
const sizes: Record<Size, string> = { sm: "px-3.5 py-1.5 text-[13px]", md: "px-5 py-2 text-sm" };
const variants: Record<Variant, string> = {
  accent: "bg-[var(--accent)] text-[var(--accent-ink)] hover:bg-[var(--accent-deep)]",
  primary: "bg-[var(--navy)] text-white hover:bg-[var(--navy-soft)]",
  secondary: "border border-[var(--rule-strong)] bg-[var(--surface)] text-[var(--ink)] hover:bg-[var(--paper)]",
  quiet: "text-[var(--ink-soft)] underline-offset-2 hover:text-[var(--ink)] hover:underline",
  danger: "border border-[var(--bad)] text-[var(--bad)] hover:bg-[var(--bad)] hover:text-white",
};
// A disabled button of ANY variant is always an outline: 1px rule-strong border,
// surface background, ink-faint text. Never a pale tint of its fill.
const disabledLook = "border border-[var(--rule-strong)] bg-[var(--surface)] text-[var(--ink-faint)] cursor-not-allowed";

export function buttonClass(variant: Variant = "primary", size: Size = "md", extra = "", disabled = false) {
  const look = disabled ? disabledLook : variants[variant];
  return `${base} ${sizes[size]} ${look} ${extra}`.trim();
}

type Props = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size; children: ReactNode };

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "primary", size = "md", className = "", type = "button", disabled, ...rest },
  ref
) {
  return (
    <button ref={ref} type={type} disabled={disabled} className={buttonClass(variant, size, className, disabled)} {...rest} />
  );
});

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  className = "",
  children,
}: {
  href: string;
  variant?: Variant;
  size?: Size;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)}>
      {children}
    </Link>
  );
}
