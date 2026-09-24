/**
 * LE RISPOSTE AL MODULO di una richiesta (moduli del catalogo, ondata 1), e da
 * qui SI CORREGGONO (decisione del proprietario, 17 set 2026).
 *
 * Il riquadro mostra le risposte nell'ordine della REVISIONE con cui il modulo
 * è stato compilato — le domande come sono state fatte. Fino a oggi era sola
 * lettura, e il motivo scritto qui era che «servirebbe rivalutare le condizioni
 * sul modulo di allora»: ora il server lo fa (`setServiceRequestFormAnswer`
 * passa dalle stesse cinque regole della compilazione, revisione di allora
 * compresa), quindi il motivo non c'è più. Prima un ambiente scelto male
 * restava sbagliato per sempre in filtri, report, widget e SLA.
 *
 * Si corregge UNA risposta per volta, e solo quelle che sono un valore: un
 * calcolato lo fa la formula, e allegati, riferimenti e tabelle sono un altro
 * lavoro — offrirli a metà sarebbe peggio che non offrirli.
 *
 * I campi personalizzati del tipo `service_request` restano nel loro riquadro,
 * modificabili come prima: sono due cose diverse — quelli valgono per tutte le
 * richieste, questi sono le risposte a UNA voce di catalogo.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@apollo/client/react'
import { Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { SectionCard } from '@/components/ui/SectionCard'
import { Button } from '@/components/Button'
import { Input, Select } from '@/components/ui/FormControls'
import { SET_REQUEST_FORM_ANSWER } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
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
  /** Le scelte del vocabolario, per correggere una risposta senza indovinare il valore interno. */
  options: Array<{ value: string; label: string }>
  /** Per i campi tabella: le colonne di ALLORA e le righe, in ordine (ondata 7). */
  tableColumns: Array<{ name: string; label: string; fieldType: string }>
  rows: Array<{ cells: Array<{ column: string; value: string | null; displayValue: string | null }> }>
}

/** I tipi che si correggono da qui: un valore singolo che diventa una proprietà. */
const CORREGGIBILI = ['text', 'textarea', 'number', 'date', 'datetime', 'boolean', 'enum']

export function FormAnswersCard({ answers, revision, requestId }: {
  answers: readonly FormAnswer[]
  revision: number | null
  /**
   * L'id della richiesta: senza, le risposte restano in sola lettura — è così
   * che il riquadro si riusa dove non c'è niente da correggere.
   */
  requestId?: string
}) {
  const { t } = useTranslation()
  const [inModifica, setInModifica] = useState<string | null>(null)
  const [bozza, setBozza] = useState('')
  const [salva, { loading }] = useMutation(SET_REQUEST_FORM_ANSWER, { onError: (e) => showError(e) })

  const apri = (a: FormAnswer) => { setInModifica(a.name); setBozza(a.value ?? '') }
  const conferma = async (a: FormAnswer) => {
    /*
     * Il `.catch(...)` non è di troppo: con Apollo Client 4 `mutate()` RIGETTA
     * anche quando `onError` c'è, quindi un rifiuto del server (per esempio
     * «una condizione lo nasconde», visto dal vivo su c-test) arrivava a
     * schermo come avviso ma lasciava un «unhandled rejection» in console. Il
     * campo resta in correzione, che è giusto: il valore non è stato salvato.
     */
    const r = await salva({ variables: { requestId, field: a.name, value: bozza === '' ? null : bozza } })
      .catch(() => null)
    if (!r?.data) return
    toast.success(t('detail.formAnswerSaved', { field: a.label }))
    setInModifica(null)
  }
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
              {/* In CORREZIONE: il controllo giusto per il tipo, e per un campo a
                  vocabolario la tendina con le etichette — non una casella dove
                  indovinare il valore interno. */}
              {inModifica === a.name ? (
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  {a.options.length > 0 ? (
                    <Select value={bozza} onChange={(e) => setBozza(e.target.value)} style={{ width: 'auto', minWidth: 140 }}>
                      <option value="">{t('common.select')}</option>
                      {a.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                  ) : a.fieldType === 'boolean' ? (
                    <Select value={bozza} onChange={(e) => setBozza(e.target.value)} style={{ width: 'auto', minWidth: 100 }}>
                      <option value="">{t('common.select')}</option>
                      <option value="true">{t('common.yes')}</option>
                      <option value="false">{t('common.no')}</option>
                    </Select>
                  ) : (
                    <Input
                      type={a.fieldType === 'number' ? 'number' : a.fieldType === 'date' ? 'date' : a.fieldType === 'datetime' ? 'datetime-local' : 'text'}
                      value={bozza}
                      onChange={(e) => setBozza(e.target.value)}
                      style={{ width: 'auto', minWidth: 160 }}
                    />
                  )}
                  <Button size="xs" onClick={() => conferma(a)} disabled={loading}>{t('common.save')}</Button>
                  <Button size="xs" variant="secondary" onClick={() => setInModifica(null)}>{t('common.cancel')}</Button>
                </span>
              ) : null}
              {/* `displayValue`/`displayValues`: il valore come si legge, deciso
                  dall'API — «Produzione», non «production» (ondata 5). */}
              {inModifica === a.name ? null : a.tableColumns.length > 0 ? null
                : a.references.length > 0
                  ? a.references.map((r) => r.label).join(', ')
                  : a.files.length > 0
                    ? a.files.map((f) => f.filename).join(', ')
                    : a.displayValues.length > 0
                      ? a.displayValues.join(', ')
                      : a.displayValue != null && a.displayValue !== ''
                        ? (a.fieldType === 'boolean' ? (a.displayValue === 'true' ? t('common.yes') : t('common.no')) : a.displayValue)
                        : <span style={{ color: colors.slateLight }}>{t('detail.formAnswerEmpty')}</span>}
              {/* Si corregge solo quello che è un VALORE, e solo se il riquadro
                  sa a quale richiesta appartiene. Un calcolato lo fa la formula. */}
              {inModifica !== a.name && requestId && CORREGGIBILI.includes(a.fieldType) && a.tableColumns.length === 0 && (
                <button
                  type="button"
                  onClick={() => apri(a)}
                  aria-label={t('detail.formAnswerEdit', { field: a.label })}
                  title={t('detail.formAnswerEdit', { field: a.label })}
                  style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 2, verticalAlign: 'middle' }}
                >
                  <Pencil size={13} aria-hidden="true" />
                </button>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </SectionCard>
  )
}

// Un sì/no si legge «Sì»/«No», non «true»/«false»: la traduzione è sopra,
// dentro il componente, perché è l'unico posto che ha `t`.
