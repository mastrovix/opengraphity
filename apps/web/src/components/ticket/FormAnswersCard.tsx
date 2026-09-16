/**
 * LE RISPOSTE AL MODULO di una richiesta (moduli del catalogo, ondata 1).
 *
 * Sola lettura, e per un motivo: le risposte sono state date compilando una
 * REVISIONE precisa del modulo, e il riquadro le mostra nell'ordine di quella
 * revisione — le domande come sono state fatte. Modificarle a posteriori è un
 * altro lavoro (servirebbe rivalutare le condizioni sul modulo di allora) e
 * l'ondata 1 non lo fa: meglio non offrirlo che offrirlo a metà.
 *
 * I campi personalizzati del tipo `service_request` restano nel loro riquadro,
 * modificabili come prima: sono due cose diverse — quelli valgono per tutte le
 * richieste, questi sono le risposte a UNA voce di catalogo.
 */
import { useTranslation } from 'react-i18next'
import { SectionCard } from '@/components/ui/SectionCard'
import { colors } from '@/lib/tokens'

export interface FormAnswer {
  name: string
  label: string
  fieldType: string
  value: string | null
  values: string[]
  /** Il valore come si legge (etichetta del Dizionario): lo decide l'API. */
  displayValue: string | null
  displayValues: string[]
  /** Per i campi di riferimento: i nodi puntati (ondata 2). */
  references: Array<{ id: string; label: string }>
  /** Per i campi allegato: i file del ticket per questo campo (ondata 2). */
  files: Array<{ id: string; filename: string; sizeBytes: number }>
  /** Per i campi tabella: le colonne di ALLORA e le righe, in ordine (ondata 7). */
  tableColumns: Array<{ name: string; label: string; fieldType: string }>
  rows: Array<{ cells: Array<{ column: string; value: string | null; displayValue: string | null }> }>
}

export function FormAnswersCard({ answers, revision }: { answers: readonly FormAnswer[]; revision: number | null }) {
  const { t } = useTranslation()
  // Nessuna risposta = la richiesta non nasce da un modulo: niente riquadro
  // vuoto, che sembrerebbe un modulo rotto.
  if (answers.length === 0) return null

  return (
    <SectionCard
      collapsible={false}
      defaultOpen
      title={revision ? t('detail.sections.formAnswers', { revision }) : t('detail.sections.formAnswersNoRevision')}
    >
      <dl style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 30%) 1fr', gap: '8px 16px', margin: 0 }}>
        {answers.map((a) => (
          <div key={a.name} style={{ display: 'contents' }}>
            <dt style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{a.label}</dt>
            <dd style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', margin: 0, wordBreak: 'break-word' }}>
              {/* UNA TABELLA si legge come una tabella (ondata 7): le colonne
                  sono quelle della revisione con cui è stata compilata, quindi
                  restano leggibili anche se il campo oggi ne ha altre. */}
              {a.tableColumns.length > 0 ? (
                <div className="og-scroll-x">
                  <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                    <thead>
                      <tr>
                        {/* Nessuno stile in linea nella testata: tinta, corpo,
                            peso e colore li decide `table thead th` in
                            index.css, e il test `testateTabelle` lo tiene fermo. */}
                        {a.tableColumns.map((c) => (
                          <th key={c.name} style={{ textAlign: 'left', padding: '2px 8px 2px 0', whiteSpace: 'nowrap' }}>
                            {c.label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {a.rows.map((riga, i) => (
                        <tr key={i}>
                          {riga.cells.map((cella) => (
                            <td key={cella.column} style={{ padding: '2px 8px 2px 0', verticalAlign: 'top' }}>
                              {cella.displayValue ?? cella.value ?? <span style={{ color: colors.slateLight }}>—</span>}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {a.rows.length === 0 && (
                        <tr>
                          <td colSpan={a.tableColumns.length} style={{ color: colors.slateLight, padding: '2px 0' }}>
                            {t('detail.formAnswerEmpty')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              ) : null}
              {/* `displayValue`/`displayValues`: il valore come si legge, deciso
                  dall'API — «Produzione», non «production» (ondata 5). */}
              {a.tableColumns.length > 0 ? null
                : a.references.length > 0
                  ? a.references.map((r) => r.label).join(', ')
                  : a.files.length > 0
                    ? a.files.map((f) => f.filename).join(', ')
                    : a.displayValues.length > 0
                      ? a.displayValues.join(', ')
                      : a.displayValue != null && a.displayValue !== ''
                        ? (a.fieldType === 'boolean' ? (a.displayValue === 'true' ? t('common.yes') : t('common.no')) : a.displayValue)
                        : <span style={{ color: colors.slateLight }}>{t('detail.formAnswerEmpty')}</span>}
            </dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  )
}

// Un sì/no si legge «Sì»/«No», non «true»/«false»: la traduzione è sopra,
// dentro il componente, perché è l'unico posto che ha `t`.
