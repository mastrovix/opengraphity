/**
 * Pastiglia dello stato di un ticket nel portale.
 *
 * Ondata 7 · D-15 — prima lo stile veniva da una mappa di **otto nomi di passo
 * di fabbrica** (`new`, `open`, `assigned`, …) con `?? grigio` per tutto il
 * resto, e l'etichetta da `t('ticket.status.<nome>', {defaultValue: nome})`.
 * Conseguenza: un passo aggiunto o rinominato nel disegnatore dei workflow
 * diventava una pastiglia grigia col nome grezzo (`in_verifica`), e nessuno lo
 * diceva.
 *
 * Adesso lo stile viene dalla **categoria** del passo, come fa già il web
 * (`PhaseBadge` / `lib/workflowStepStyle`): la categoria è un vocabolario
 * chiuso del prodotto, la dichiara l'amministratore sul passo nel disegnatore,
 * e sopravvive a una rinomina. L'etichetta è quella del workflow del cliente
 * (`statusLabel`), con l'i18n del portale come seconda scelta per i passi
 * spediti e il nome ripulito come ultima.
 *
 * Un passo **senza** categoria resta neutro: è una configurazione legittima e
 * incompleta, non un errore — e si vede in console (`console.warn`), non si
 * tace.
 */
import { useTranslation } from 'react-i18next'
import { colors, palette } from '@/lib/tokens'

interface CategoryStyle { bg: string; color: string }

/**
 * Le categorie dei passi (vocabolario chiuso del prodotto, le stesse di
 * `apps/web/src/lib/workflowStepStyle.ts`).
 */
const CATEGORY_STYLE: Record<string, CategoryStyle> = {
  active:    { bg: palette.info.bg, color: palette.info.text },
  waiting:   { bg: palette.warning.bg, color: palette.warning.dark },
  escalated: { bg: palette.danger.bg, color: palette.danger.dark },
  resolved:  { bg: palette.success.bg, color: palette.success.text },
  published: { bg: palette.success.bg, color: palette.success.text },
  closed:    { bg: colors.slateBg, color: colors.slate },
  failed:    { bg: palette.danger.bg, color: palette.danger.dark },
  draft:     { bg: colors.slateBg, color: colors.slate },
}

const NEUTRAL: CategoryStyle = { bg: colors.slateBg, color: colors.slate }

export function styleForStatusCategory(category: string | null | undefined, status: string): CategoryStyle {
  if (!category) {
    console.warn(`[TicketStatusBadge] il passo "${status}" non dichiara una categoria: pastiglia neutra`)
    return NEUTRAL
  }
  const style = CATEGORY_STYLE[category]
  if (!style) {
    console.error(`[TicketStatusBadge] categoria sconosciuta "${category}" sul passo "${status}"`)
    return NEUTRAL
  }
  return style
}

interface Props {
  status: string
  /** Categoria del passo nel workflow del cliente (`myTicket.statusCategory`). */
  statusCategory?: string | null
  /** Etichetta del passo nel workflow del cliente (`myTicket.statusLabel`). */
  statusLabel?: string | null
  size?: 'sm' | 'md'
}

/** `in_verifica` → `In verifica`: meglio del nome grezzo quando non c'è un'etichetta. */
function prettify(status: string): string {
  const words = status.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function TicketStatusBadge({ status, statusCategory = null, statusLabel = null, size = 'sm' }: Props) {
  const { t } = useTranslation()
  const style = styleForStatusCategory(statusCategory, status)
  const label = statusLabel ?? t(`ticket.status.${status}`, { defaultValue: prettify(status) })

  return (
    <span style={{
      display:         'inline-flex',
      alignItems:      'center',
      padding:         size === 'md' ? '4px 12px' : '2px 8px',
      borderRadius:    100,
      fontSize:        size === 'md' ? 13 : 11,
      fontWeight:      600,
      backgroundColor: style.bg,
      color:           style.color,
      whiteSpace:      'nowrap',
    }}>
      {label}
    </span>
  )
}
