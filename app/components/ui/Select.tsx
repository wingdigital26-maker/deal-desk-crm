// The one styled native select. Appearance is fully custom (house chevron,
// 42px tall, house radius/border) but it stays a real <select> underneath, so
// keyboard and screen-reader behaviour is exactly what the browser gives you
// for free. Never swap this for a div-based listbox.
import type { ReactNode, SelectHTMLAttributes } from "react";
import { ChevronDownIcon } from "./icons";

type Props = SelectHTMLAttributes<HTMLSelectElement> & {
  label?: string;
  wrapperClassName?: string;
  children: ReactNode;
};

export default function Select({ label, id, className = "", wrapperClassName = "", children, ...rest }: Props) {
  const field = (
    <div className={`relative ${wrapperClassName}`}>
      <select
        id={id}
        className={
          "h-[44px] w-full appearance-none rounded-[var(--radius-sm)] border border-[var(--rule-strong)] " +
          "bg-[var(--surface)] pl-3 pr-8 text-[16px] text-[var(--ink)] outline-none " +
          `focus-visible:border-[var(--accent)] ${className}`
        }
        {...rest}
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-faint)]" />
    </div>
  );

  if (!label) return field;
  return (
    <div>
      <label htmlFor={id} className="label mb-1 block text-[var(--ink-soft)]">
        {label}
      </label>
      {field}
    </div>
  );
}
