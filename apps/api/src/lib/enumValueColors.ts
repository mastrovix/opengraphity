/**
 * I COLORI PER VALORE di un vocabolario (revisione del 14 set 2026 · F9).
 *
 * `EnumTypeDefinition.value_colors`, stringa JSON valore → nome di colore
 * (`VALUE_COLORS` in @opengraphity/types). Stesso ciclo di vita delle etichette
 * (lib/enumValueLabels.ts): la rinomina porta il colore sul valore nuovo,
 * togliere un valore ne scarta il colore, personalizzare un vocabolario spedito
 * ne copia i colori.
 */
import { VALUE_COLORS, isValueColor, type ValueColor } from '@opengraphity/types'
import { ValidationError } from './errors.js'

export type EnumValueColors = Readonly<Record<string, ValueColor>>

export interface EnumValueColorEntry { value: string; color: ValueColor }

/** Decodifica `value_colors`. Un JSON corrotto non rende illeggibile il vocabolario: si perdono i colori e si dice perché. */
export function parseValueColors(raw: unknown): { colors: EnumValueColors; error: string | null } {
  if (raw == null || raw === '') return { colors: {}, error: null }
  if (typeof raw !== 'string') return { colors: {}, error: `value_colors is not a string (${typeof raw})` }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (e) {
    return { colors: {}, error: `value_colors is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { colors: {}, error: 'value_colors is not an object value → color' }
  }
  const colors: Record<string, ValueColor> = {}
  const unknown: string[] = []
  for (const [value, color] of Object.entries(parsed as Record<string, unknown>)) {
    if (isValueColor(color)) colors[value] = color
    else unknown.push(`${value}=${String(color)}`)
  }
  return { colors, error: unknown.length ? `value_colors has colors outside the palette: ${unknown.join(', ')}` : null }
}

/** I colori nell'ordine dei valori, solo per i valori che ne hanno uno. */
export function valueColorEntries(values: readonly string[], colors: EnumValueColors): EnumValueColorEntry[] {
  return values.filter((v) => colors[v] !== undefined).map((v) => ({ value: v, color: colors[v]! }))
}

export function renameValueColor(colors: EnumValueColors, from: string, to: string): EnumValueColors {
  if (colors[from] === undefined) return colors
  const { [from]: color, ...rest } = colors
  return { ...rest, [to]: color! }
}

export function pruneValueColors(colors: EnumValueColors, values: readonly string[]): EnumValueColors {
  return Object.fromEntries(Object.entries(colors).filter(([v]) => values.includes(v)))
}

export function serializeValueColors(colors: EnumValueColors): string | null {
  return Object.keys(colors).length ? JSON.stringify(colors) : null
}

/** Valida i colori mandati dal Dizionario contro la palette e i valori del vocabolario. */
export function assertValueColorsInput(
  input: readonly { value: string; color: string }[], values: readonly string[], name: string,
): EnumValueColors {
  const out: Record<string, ValueColor> = {}
  for (const e of input) {
    if (!isValueColor(e.color)) {
      throw new ValidationError(
        `Color "${e.color}" for "${e.value}" is not in the palette (${VALUE_COLORS.join(', ')}).`,
        { key: 'errors.enum.unknownValueColor', params: { color: e.color, value: e.value, available: VALUE_COLORS.join(', ') } },
      )
    }
    if (!values.includes(e.value)) {
      throw new ValidationError(
        `"${e.value}" is not a value of "${name}" (${values.join(', ')}): it cannot have a color.`,
        { key: 'errors.enum.valueColorNotInValues', params: { value: e.value, name, values: values.join(', ') } },
      )
    }
    out[e.value] = e.color
  }
  return out
}
