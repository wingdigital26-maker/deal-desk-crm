// The one styled native date input. Same treatment as Select: house chevron's
// sibling, the house calendar icon, 42px tall, house radius/border. The
// browser's own picker indicator stays functional but invisible, stacked
// exactly over our icon, so clicking the icon still opens the native picker
// and all keyboard/screen-reader behaviour is preserved.
import type { InputHTMLAttributes } from "react";
import { CalendarIcon } from "./icons";

type Props = InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  wrapperClassName?: string;
};

export default function DateInput({ label, id, className = "", wrapperClassName = "", ...rest }: Props) {
  const field = (
    <div className={`relative ${wrapperClassName}`}>
      <input
        type="date"
        id={id}
        className={
          "h-[44px] w-full rounded-[var(--radius-sm)] border border-[var(--rule-strong)] bg-[var(--surface)] " +
          "pl-3 pr-9 text-[16px] text-[var(--ink)] outline-none focus-visible:border-[var(--accent)] " +
          "[&::-webkit-calendar-picker-indicator]:absolute [&::-webkit-calendar-picker-indicator]:right-0 " +
          "[&::-webkit-calendar-picker-indicator]:top-0 [&::-webkit-calendar-picker-indicator]:h-full " +
          "[&::-webkit-calendar-picker-indicator]:w-9 [&::-webkit-calendar-picker-indicator]:cursor-pointer " +
          `[&::-webkit-calendar-picker-indicator]:opacity-0 ${className}`
        }
        {...rest}
      />
      <CalendarIcon className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--ink-faint)]" />
    </div>
  );

  if (!label) return field;
  return (
    <div>
      <label htmlFor={id} className="label mb-1 block">
        {label}
      </label>
      {field}
    </div>
  );
}
