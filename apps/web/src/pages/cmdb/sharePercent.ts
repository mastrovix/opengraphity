/**
 * A share as the CMDB Health cards write it: one decimal, in the product's
 * language — and «< 0.1» when there is something but it rounds to nothing
 * (7 of 21,179 read «0%», as if the check had found none).
 */
export function sharePercent(part: number, whole: number, language: string): string {
  const num = (n: number) => n.toLocaleString(language)
  if (whole <= 0) return num(0)
  const rounded = Math.round((part / whole) * 1000) / 10
  return part > 0 && rounded === 0 ? `< ${num(0.1)}` : num(rounded)
}
