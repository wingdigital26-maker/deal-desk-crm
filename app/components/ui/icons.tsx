// The one house icon set. 16px grid, 1.5 stroke, currentColor. Never mix in another set.
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  width: 16,
  height: 16,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 8.5 6.2 11.5 13 4.5" />
    </svg>
  );
}

export function CircleIIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4" />
      <circle cx="8" cy="5.1" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function TriangleAlertIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 2.5 14 13.2H2Z" />
      <path d="M8 6.4v3.2" />
      <circle cx="8" cy="11.4" r="0.15" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CircleSlashIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M3.75 3.75l8.5 8.5" />
    </svg>
  );
}

export function CircleIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="8" cy="8" r="6.25" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="7.1" cy="7.1" r="4.35" />
      <path d="M10.4 10.4 13.5 13.5" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3.5 5.75 8 10.25l4.5-4.5" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}

export function XIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

export function ArrowUpRightIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4.5 11.5 11.5 4.5M5.5 4.5h6v6" />
    </svg>
  );
}

export function CalendarIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.5" y="3.2" width="11" height="10.3" rx="1.2" />
      <path d="M2.5 6.4h11M5.3 2v2.4M10.7 2v2.4" />
    </svg>
  );
}

export function MailIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2" y="3.5" width="12" height="9" rx="1.2" />
      <path d="M2.6 4.3 8 8.6l5.4-4.3" />
    </svg>
  );
}

export function UsersIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="6" cy="6" r="2.2" />
      <path d="M1.7 13c.5-2.3 2.2-3.6 4.3-3.6s3.8 1.3 4.3 3.6" />
      <circle cx="11.6" cy="6.2" r="1.7" />
      <path d="M11 9.5c1.6.2 2.8 1.4 3.2 3.2" />
    </svg>
  );
}

export function BuildingIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="2.3" width="7.5" height="11.4" rx="0.6" />
      <path d="M10.5 6.5H13a0.7 0.7 0 0 1 .7.7v6.5H10.5" />
      <path d="M5.2 5h1M5.2 7.4h1M5.2 9.8h1M7.6 5h1M7.6 7.4h1M7.6 9.8h1" />
    </svg>
  );
}

export function ColumnsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="2.3" y="2.8" width="11.4" height="10.4" rx="1" />
      <path d="M6.7 2.8v10.4M11 2.8v10.4" />
    </svg>
  );
}

export function ListIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M5.2 4.5h8.3M5.2 8h8.3M5.2 11.5h8.3" />
      <path d="M2.3 4.5h.01M2.3 8h.01M2.3 11.5h.01" strokeLinecap="round" />
    </svg>
  );
}

export function InboxIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2.3 8.5h3.4l1 1.6h2.6l1-1.6h3.4" />
      <path d="M3.4 3.5h9.2l1.4 5v3.3a1.2 1.2 0 0 1-1.2 1.2H3.2A1.2 1.2 0 0 1 2 11.8V8.5Z" />
    </svg>
  );
}

export function ShieldCheckIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 2.2 13 4v4.1c0 3.4-2.2 5.7-5 6.7-2.8-1-5-3.3-5-6.7V4Z" />
      <path d="M5.6 8 7.3 9.7 10.4 6.5" />
    </svg>
  );
}

export function FileTextIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4.2 1.8h5.1L12 4.9v9.1a0.7 0.7 0 0 1-.7.7H4.2a0.7 0.7 0 0 1-.7-.7V2.5a0.7 0.7 0 0 1 .7-.7Z" />
      <path d="M9.3 1.8v3.1h2.9" />
      <path d="M5.6 8.1h4.4M5.6 10.4h4.4" />
    </svg>
  );
}

export function ActivityIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M2 8.5h2.7l1.4-4 2 7 1.4-3h3.8" />
    </svg>
  );
}
