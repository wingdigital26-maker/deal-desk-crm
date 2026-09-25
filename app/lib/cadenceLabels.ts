// Touch-cadence choices and labels. Plain module: safe on server and client.
export const CADENCE_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "No reminder" },
  { value: 14, label: "Every 2 weeks" },
  { value: 30, label: "Every month" },
  { value: 60, label: "Every 2 months" },
  { value: 90, label: "Every quarter" },
  { value: 180, label: "Every 6 months" },
];

export function cadenceLabel(days: number | null | undefined): string {
  if (!days) return "No reminder";
  return CADENCE_OPTIONS.find((o) => o.value === days)?.label ?? `Every ${days} days`;
}
