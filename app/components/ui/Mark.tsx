// The Deal Desk mark: logo 21 "Offset Half Discs" (Jack's pick, 2026-09-25).
// Two half discs offset on a diagonal: the navy disc follows currentColor, the
// blue disc takes the royal token on light grounds and a lifted blue on navy,
// so the same mark works on white and inside the navy rail tile. Decorative:
// the product name is always set as real text beside it or in an aria-label.
export default function Mark({
  size = 28,
  tone = "dark",
  className = "",
}: {
  size?: number;
  tone?: "dark" | "light";
  className?: string;
}) {
  const color = tone === "light" ? "text-white" : "text-[var(--navy)]";
  const blue = tone === "light" ? "var(--blue-300)" : "var(--royal)";
  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox="10 10 80 80"
      width={size}
      height={size}
      className={`flex-shrink-0 ${color} ${className}`}
    >
      <path d="M46,22A34,34 0 0 0 46,90Z" fill="currentColor" />
      <path d="M54,10A34,34 0 0 1 54,78Z" fill={blue} />
    </svg>
  );
}
