/**
 * THE ICON OF A VALUE of a dictionary (tour of 24 Sep 2026, G40).
 *
 * `EnumTypeDefinition.value_icons`, a JSON string value → icon name
 * (`VALUE_ICONS` in @opengraphity/types). The same life as the colours
 * (lib/enumValueColors.ts): a rename carries the icon to the new value,
 * removing a value drops its icon.
 */
import { VALUE_ICONS, isValueIcon, type ValueIcon } from '@opengraphity/types'
import { ValidationError } from './errors.js'

export type EnumValueIcons = Readonly<Record<string, ValueIcon>>

export interface EnumValueIconEntry { value: string; icon: ValueIcon }

/** Reads `value_icons`. Corrupt JSON does not make the dictionary unreadable: the icons are lost, and it says why. */
export function parseValueIcons(raw: unknown): { icons: EnumValueIcons; error: string | null } {
  if (raw == null || raw === '') return { icons: {}, error: null }
  if (typeof raw !== 'string') return { icons: {}, error: `value_icons is not a string (${typeof raw})` }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (e) {
    return { icons: {}, error: `value_icons is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { icons: {}, error: 'value_icons is not an object value → icon' }
  }
  const icons: Record<string, ValueIcon> = {}
  const unknown: string[] = []
  for (const [value, icon] of Object.entries(parsed as Record<string, unknown>)) {
    if (isValueIcon(icon)) icons[value] = icon
    else unknown.push(`${value}=${String(icon)}`)
  }
  return { icons, error: unknown.length ? `value_icons has icons outside the list: ${unknown.join(', ')}` : null }
}

/** The icons in the order of the values, only for the values that have one. */
export function valueIconEntries(values: readonly string[], icons: EnumValueIcons): EnumValueIconEntry[] {
  return values.filter((v) => icons[v] !== undefined).map((v) => ({ value: v, icon: icons[v]! }))
}

export function renameValueIcon(icons: EnumValueIcons, from: string, to: string): EnumValueIcons {
  if (icons[from] === undefined) return icons
  const { [from]: icon, ...rest } = icons
  return { ...rest, [to]: icon! }
}

export function pruneValueIcons(icons: EnumValueIcons, values: readonly string[]): EnumValueIcons {
  return Object.fromEntries(Object.entries(icons).filter(([v]) => values.includes(v)))
}

export function serializeValueIcons(icons: EnumValueIcons): string | null {
  return Object.keys(icons).length ? JSON.stringify(icons) : null
}

/** Checks the icons the Dictionary sends against the list and the values of the dictionary. */
export function assertValueIconsInput(
  input: readonly { value: string; icon: string }[], values: readonly string[], name: string,
): EnumValueIcons {
  const out: Record<string, ValueIcon> = {}
  for (const e of input) {
    if (!isValueIcon(e.icon)) {
      throw new ValidationError(
        `Icon "${e.icon}" for "${e.value}" is not in the list (${VALUE_ICONS.join(', ')}).`,
        { key: 'errors.enum.unknownValueIcon', params: { icon: e.icon, value: e.value, available: VALUE_ICONS.join(', ') } },
      )
    }
    if (!values.includes(e.value)) {
      throw new ValidationError(
        `"${e.value}" is not a value of "${name}" (${values.join(', ')}): it cannot have an icon.`,
        { key: 'errors.enum.valueIconNotInValues', params: { value: e.value, name, values: values.join(', ') } },
      )
    }
    out[e.value] = e.icon
  }
  return out
}
