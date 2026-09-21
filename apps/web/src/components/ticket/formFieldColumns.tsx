/**
 * Le colonne dei campi della LIBRERIA dei moduli nelle liste delle richieste
 * (moduli del catalogo, ondata 4).
 *
 * Stesso stampo delle colonne dei campi personalizzati (`cf:<nome>`), e per lo
 * stesso motivo: la tabella e l'esportazione CSV leggono una chiave per
 * colonna, quindi i valori si stendono in `ff:<nome>`. Prefisso diverso perché
 * sono due insiemi diversi — i campi personalizzati valgono per TUTTE le
 * richieste, questi vengono dai moduli del catalogo — e due nomi uguali
 * darebbero una colonna con il valore dell'altro.
 *
 * Non TUTTA la libreria: solo i campi con «nelle liste» acceso. Una libreria
 * ricca ha decine di campi, e una colonna per ognuno renderebbe la lista
 * illeggibile; la scelta è dell'amministratore, nella pagina della libreria.
 * Il server filtra allo stesso modo, quindi la riga non porta nemmeno i valori
 * dei campi spenti.
 *
 * Le ETICHETTE, non i valori: `production` sul nodo si legge «Produzione»,
 * come ovunque nel prodotto. La traduzione la fa l'API (`displayValue` /
 * `displayValues`), la stessa che serve le risposte del ticket e i report:
 * «come si legge production» è una verità sola, in un posto solo.
 *
 * Non ordinabili: l'ordinamento delle liste è del server, che ordina solo sui
 * campi del prodotto (la stessa ragione delle colonne `cf:`).
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@apollo/client/react'
import type { ColumnDef } from '@/components/SortableFilterTable'
import { GET_FORM_FIELDS } from '@/graphql/queries'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'

export interface FormFieldValue {
  name: string
  label: string
  fieldType: string
  /** Il valore come si legge; `value`/`values` restano il dato. */
  displayValue: string | null
  displayValues: string[]
}

interface WithFormFieldValues { formFieldValues?: FormFieldValue[] | null }

interface CampoInLista {
  name: string
  label: string
  inList: boolean
}

const cell = (name: string) => `ff:${name}`

/**
 * Colonne + la funzione che stende i valori nelle righe. Stanno insieme perché
 * leggono la STESSA libreria: separarli vorrebbe dire due query e il rischio
 * che una colonna e la sua cella non parlino della stessa cosa.
 */
export function useFormFieldColumns<T extends WithFormFieldValues>(): {
  columns: ColumnDef<T>[]
  withCells: (rows: readonly T[]) => T[]
} {
  const { i18n } = useTranslation()
  const { data } = useQuery<{ formFields: CampoInLista[] }>(
    // La stessa `language` della pagina della libreria, così le due query
    // condividono la cache invece di leggere due volte.
    GET_FORM_FIELDS, { variables: { language: i18n.language }, fetchPolicy: METAMODEL_FETCH_POLICY },
  )
  const campi = data?.formFields

  return useMemo(() => {
    const inLista = (campi ?? []).filter((f) => f.inList)

    const columns: ColumnDef<T>[] = inLista.map((f) => ({
      key:      cell(f.name) as keyof T,
      label:    f.label,
      width:    '150px',
      sortable: false,
      render:   (v: unknown) => (
        <span style={{ color: v == null || v === '' ? 'var(--color-slate-light)' : undefined }}>
          {v == null || v === '' ? '—' : String(v)}
        </span>
      ),
    }))

    const withCells = (rows: readonly T[]): T[] => rows.map((r) => Object.assign({}, r, Object.fromEntries(
      (r.formFieldValues ?? []).map((f) => [
        cell(f.name),
        // La selezione multipla in una cella: le etichette separate da virgola.
        f.displayValues.length > 0 ? f.displayValues.join(', ') : f.displayValue,
      ]),
    )))

    return { columns, withCells }
  }, [campi])
}
