/** Format an annualized wage as whole US dollars, or "N/A" when absent. */
export function formatUSD(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "N/A";
  return "$" + Math.round(value).toLocaleString("en-US");
}
