/**
 * THE ICONS A DICTIONARY VALUE CAN HAVE (tour of 24 Sep 2026, G40).
 *
 * The portal drew an icon for the six shipped categories and a generic tag
 * for the customer's own («Infrastructure», «Workplace», «People»): the icon
 * was a table in the portal's code. Now a value carries the NAME of an icon
 * the customer chose in the Dictionary, from this list — the web and the
 * portal map each name to their drawing; no drawing is ever stored.
 */
export const VALUE_ICONS = [
  'monitor', 'laptop', 'server', 'database', 'cloud', 'wifi', 'network', 'code', 'app',
  'key', 'lock', 'shield', 'user', 'users', 'building', 'briefcase', 'phone', 'printer',
  'mail', 'calendar', 'wrench', 'box', 'globe', 'help', 'tag',
] as const

export type ValueIcon = typeof VALUE_ICONS[number]

export function isValueIcon(v: unknown): v is ValueIcon {
  return typeof v === 'string' && (VALUE_ICONS as readonly string[]).includes(v)
}
