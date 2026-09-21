/**
 * Le colonne dei campi del cliente nelle liste dei ticket (ondata 4). Le righe
 * portano `customFields: [{name, value}]`; la tabella e l'export CSV leggono
 * una chiave per colonna, quindi i valori si stendono in `cf:<nome>`.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { ColumnDef } from '@/components/SortableFilterTable'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { customFieldDisplay, useTicketCustomFieldDefs, type TicketEntityType } from './customFields'

const cell = (name: string) => `cf:${name}`

interface WithCustomFields { customFields?: { name: string; value: string | null }[] | null }

/** Le righe con un valore per colonna (`cf:<nome>`), per la tabella e per l'export. */
export function withCustomFieldCells<T extends WithCustomFields>(rows: readonly T[]): T[] {
  return rows.map((r) => Object.assign({}, r, Object.fromEntries((r.customFields ?? []).map((f) => [cell(f.name), f.value]))))
}

/**
 * Una colonna per campo del cliente, dopo quelle del prodotto. Non ordinabili:
 * l'ordinamento delle liste è del server, che ordina solo sui campi del prodotto.
 */
export function useCustomFieldColumns<T>(entityType: TicketEntityType): ColumnDef<T>[] {
  const { t } = useTranslation()
  const { labelOf } = useDomainVocabularies()
  const { defs } = useTicketCustomFieldDefs(entityType)
  return useMemo(() => defs.map((d) => ({
    key:      cell(d.name) as keyof T,
    label:    d.label,
    width:    '150px',
    sortable: false,
    render:   (v: unknown) => (
      <span style={{ color: v == null || v === '' ? 'var(--color-slate-light)' : undefined }}>
        {customFieldDisplay({ fieldType: d.fieldType, enumTypeName: d.enumTypeName, value: v == null ? null : String(v) }, labelOf, t)}
      </span>
    ),
  })), [defs, labelOf, t])
}
