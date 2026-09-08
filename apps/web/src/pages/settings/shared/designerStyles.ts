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
}
