// Designer-specific constants. The style constants moved to the design system
// (`@/components/ui/styles`) and are re-exported here so existing imports keep
// working; new code imports from `@/components/ui/styles` (or, better, uses
// `<Button>` / `FormControls`).
export {
  inputS, selectS, textareaS, labelS,
  btnPrimary, btnSecondary, btnDanger,
  enumChipStyle, activeCardStyle, inactiveCardStyle,
} from '@/components/ui/styles'

export const FIELD_TYPES = ['string', 'number', 'date', 'boolean', 'enum'] as const

export interface EnumTypeRef {
  id: string
  label: string
  values: string[]
  scope: string
  /**
   * Spedito col prodotto (`tenant_id = 'system'`): è lo stesso vocabolario per
   * tutti i clienti e non si modifica in posto — si personalizza dal
   * Dizionario, che ne crea la copia del tenant.
   */
  isShipped: boolean
}

/**
 * Etichetta di un vocabolario nelle tendine dei disegnatori: label, scope e —
 * la parte che mancava — **di chi è**. Senza il proprietario un cliente non
 * distingueva i vocabolari del prodotto dai propri, cioè non sapeva quale
 * poteva cambiare.
 */
export function enumOptionLabel(
  e: Pick<EnumTypeRef, 'label' | 'scope' | 'isShipped'>,
  t: (key: string) => string,
): string {
  return `${e.label} (${e.scope}) — ${t(e.isShipped ? 'pages.dictionary.shippedBadge' : 'pages.dictionary.ownBadge')}`
}
