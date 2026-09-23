/**
 * A PLAN WINDOW AS IT READS: «21 Sept 2026, 22:00 → 23:30» when it starts and
 * ends on the same day, otherwise both dates in full.
 *
 * A release that crosses midnight is the norm, and writing it «22:00 → 01:00»
 * reads as a window running three hours backwards. The consolidated plan of
 * the change page avoided that form, while the preview of the calendar still
 * wrote it (tour of 23 Sep 2026): one helper for both, so the same window
 * cannot read two ways again.
 */
import { formatDate, formatDateTime, formatHourMinute } from '@/lib/datetime'

export function readableWindow(start: string, end: string): string {
  // `formatHourMinute` and not `formatTime`: the latter adds the SECONDS, and
  // «16:00:00» in a release window is noise — nobody plans to the second
  // (seen live on 18 Sep 2026).
  return formatDate(start) === formatDate(end)
    ? `${formatDateTime(start)} → ${formatHourMinute(end)}`
    : `${formatDateTime(start)} → ${formatDateTime(end)}`
}
