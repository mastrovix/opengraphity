/**
 * LA FORMULA E LA VALIDAZIONE di un campo della libreria (moduli del catalogo,
 * ondata 6).
 *
 * Due caselle di codice, con la stessa forma e due contratti diversi:
 *
 *  - la FORMULA riceve `input` (le risposte dei campi non calcolati) e
 *    RESTITUISCE il valore: `return input.costo * input.quantita`. Chi ce l'ha
 *    diventa un campo in sola lettura.
 *  - la VALIDAZIONE riceve `input` e `value` e LANCIA un errore per rifiutare:
 *    `if (value < 0) throw new Error('...')`. Esisteva già — il server la
 *    esegue dall'ondata 1 — ma non c'era nessun posto per scriverla: si poteva
 *    mettere solo scrivendo nel database. Ecco il posto.
 *
 * «Prova»: la formula gira DAVVERO, qui nel browser, nello stesso sandbox
 * (QuickJS) che la eseguirà mentre l'utente compila. I valori di prova si
 * scrivono come JSON perché chi scrive una formula in JavaScript sa scrivere
 * `{"costo": 100}` — e perché indovinare quali campi cita una formula vorrebbe
 * dire leggere il suo codice, che è esattamente il mestiere che non vogliamo
 * fare a mano.
 */
import { Textarea } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { runFormula } from '@opengraphity/web-core'
import { ScriptHelp, type CampoLeggibile } from './ScriptHelp'


const aiutoStile: React.CSSProperties = {
  margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '70ch',
}

export function ScriptFields({
  formula, onFormula, canCompute, validationScript, onValidationScript, campiLeggibili,
}: {
  formula: string
  onFormula: (v: string) => void
  /** Il tipo del campo può essere calcolato: se no, la formula non si offre affatto. */
  canCompute: boolean
  validationScript: string
  onValidationScript: (v: string) => void
  /** I campi che uno script può leggere con `input.nome`: li mostra l'aiuto. */
  campiLeggibili?: readonly CampoLeggibile[]
}) {
  const { t } = useTranslation()
  const base = useId()
  const idFormula = `${base}-formula`
  const idScript = `${base}-script`
  const [valoriProva, setValoriProva] = useState('{}')
  const [esito, setEsito] = useState<{ ok: boolean; testo: string } | null>(null)
  const [provando, setProvando] = useState(false)

  const prova = async () => {
    let input: Record<string, unknown>
    try {
      const letto: unknown = JSON.parse(valoriProva)
      if (letto === null || typeof letto !== 'object' || Array.isArray(letto)) throw new Error('not an object')
      input = letto as Record<string, unknown>
    } catch {
      setEsito({ ok: false, testo: t('pages.catalogForms.library.testInputInvalid') })
      return
    }
    setProvando(true)
    try {
      const r = await runFormula(formula, input)
      setEsito(r.error
        ? { ok: false, testo: r.error }
        : { ok: true, testo: r.value === null || r.value === undefined ? t('pages.catalogForms.library.testNoValue') : String(r.value) })
    } finally {
      setProvando(false)
    }
  }

  return (
    <>
      {canCompute && (
        <div style={{ marginTop: 14 }}>
          {/* Un'etichetta, non uno `span`: la casella della formula era senza
              nome accessibile (revisione del 17 set 2026). */}
          <label htmlFor={idFormula} style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
            {t('pages.catalogForms.library.formula')}
          </label>
          <Textarea
            id={idFormula}
            value={formula}
            onChange={(e) => { onFormula(e.target.value); setEsito(null) }}
            placeholder={t('pages.catalogForms.library.formulaPlaceholder')}
            spellCheck={false}
          />
          <p style={aiutoStile}>{t('pages.catalogForms.library.formulaHelp')}</p>

          {formula.trim() !== '' && (
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <label style={{ flex: '1 1 220px', minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
                  {t('pages.catalogForms.library.testInput')}
                </span>
                <Textarea
                  value={valoriProva}
                  onChange={(e) => setValoriProva(e.target.value)}
                  spellCheck={false}
                  style={{ minHeight: 40 }}
                />
              </label>
              <Button variant="secondary"
                onClick={() => prova()}
                disabled={provando}
                style={{ marginTop: 18 }}
              >
                {t('pages.catalogForms.library.testFormula')}
              </Button>
              {esito && (
                /* `role="status"`: chi usa un lettore di schermo premeva «Prova»
                   e non sentiva NIENTE. */
                <p role="status" style={{
                  flexBasis: '100%', margin: 0, fontSize: 'var(--font-size-table)',
                  fontFamily: 'var(--font-mono)',
                  color: esito.ok ? 'var(--color-slate-dark)' : 'var(--color-danger)',
                }}>
                  {esito.ok ? `= ${esito.testo}` : esito.testo}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <label htmlFor={idScript} style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
          {t('pages.catalogForms.library.validationScript')}
        </label>
        <Textarea
          id={idScript}
          value={validationScript}
          onChange={(e) => onValidationScript(e.target.value)}
          placeholder={t('pages.catalogForms.library.validationScriptPlaceholder')}
          spellCheck={false}
        />
        <p style={aiutoStile}>{t('pages.catalogForms.library.validationScriptHelp')}</p>
      </div>

      {/* L'AIUTO sta qui sotto, dove sono le caselle: un esempio che si legge
          in un'altra pagina si copia a memoria, e a memoria si sbaglia il nome
          del campo. */}
      <ScriptHelp
        campi={campiLeggibili ?? []}
        conFormula={canCompute}
        onInserisci={(dove, codice) => {
          /* In CODA a quello che c'è: guardare un esempio non deve cancellare
             quello che si stava scrivendo. */
          if (dove === 'formula') {
            onFormula(formula.trim() === '' ? codice : `${formula.replace(/\n+$/, '')}\n${codice}`)
            setEsito(null)
          } else {
            onValidationScript(validationScript.trim() === '' ? codice : `${validationScript.replace(/\n+$/, '')}\n${codice}`)
          }
        }}
      />
    </>
  )
}
