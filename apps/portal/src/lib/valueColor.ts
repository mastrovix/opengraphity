/**
 * Il colore che il Dizionario del cliente dà a un valore (`ValueColor`: la
 * stessa scala del web), reso con la palette del portale. Verifica «Cosa resta
 * cablato», ondata 1: il portale colorava la priorità con una mappa
 * `high/medium/low` scritta nella pagina, e ogni valore del cliente era grigio.
 *
 * `null` = il cliente non gli ha dato un colore: neutro, come nel web. Un nome
 * di colore sconosciuto è un errore di chi manda il dato, e lo si dice.
 */
import { colors, palette } from './tokens'

export interface ValueColorStyle { base: string; text: string; tint: string }

const NEUTRAL: ValueColorStyle = { base: colors.slateLight, text: palette.neutral.textStrong, tint: colors.slateBg }

const FAMILIES: Readonly<Record<string, ValueColorStyle>> = {
  neutral: NEUTRAL,
  success: { base: palette.success.base, text: palette.success.text, tint: palette.success.tint },
  info:    { base: palette.info.base,    text: palette.info.text,    tint: palette.info.tint },
  purple:  { base: palette.purple.base,  text: palette.purple.text,  tint: palette.purple.tint },
  warning: { base: palette.warning.base, text: palette.warning.text, tint: palette.warning.tint },
  orange:  { base: palette.orange.base,  text: palette.orange.text,  tint: palette.orange.tint },
  danger:  { base: palette.danger.base,  text: palette.danger.text,  tint: palette.danger.tint },
}

export function valueColorStyle(color: string | null | undefined): ValueColorStyle {
  if (color == null) return NEUTRAL
  const family = FAMILIES[color]
  if (!family) {
    console.error(`[valueColor] unknown dictionary color "${color}"`)
    return NEUTRAL
  }
  return family
}
