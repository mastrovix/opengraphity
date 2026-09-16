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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { runFormula } from '@opengraphity/web-core'
import { colors } from '@/lib/tokens'

const areaStile: React.CSSProperties = {
  width: '100%', minHeight: 64, padding: '6px 8px', borderRadius: 6,
  border: `1px solid ${colors.border}`, background: colors.white,
  fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-table)',
  color: 'var(--color-slate-dark)', boxSizing: 'border-box', resize: 'vertical',
}

const aiutoStile: React.CSSProperties = {
  margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '70ch',
}

export function ScriptFields({
  formula, onFormula, canCompute, validationScript, onValidationScript,
}: {
  formula: string
  onFormula: (v: string) => void
  /** Il tipo del campo può essere calcolato: se no, la formula non si offre affatto. */
  canCompute: boolean
  validationScript: string
  onValidationScript: (v: string) => void
}) {
  const { t } = useTranslation()
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
          <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
            {t('pages.catalogForms.library.formula')}
          </span>
          <textarea
            value={formula}
            onChange={(e) => { onFormula(e.target.value); setEsito(null) }}
            placeholder={t('pages.catalogForms.library.formulaPlaceholder')}
            style={areaStile}
            spellCheck={false}
          />
          <p style={aiutoStile}>{t('pages.catalogForms.library.formulaHelp')}</p>

          {formula.trim() !== '' && (
            <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <label style={{ flex: '1 1 220px', minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
                  {t('pages.catalogForms.library.testInput')}
                </span>
                <textarea value={valoriProva} onChange={(e) => setValoriProva(e.target.value)}
                  style={{ ...areaStile, minHeight: 40 }} spellCheck={false} />
              </label>
              <button type="button" onClick={() => void prova()} disabled={provando}
                style={{
                  marginTop: 18, padding: '6px 12px', borderRadius: 8, border: `1px solid ${colors.border}`,
                  background: colors.white, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)',
                  cursor: provando ? 'progress' : 'pointer',
                }}>
                {t('pages.catalogForms.library.testFormula')}
              </button>
              {esito && (
                <p style={{
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
        <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
          {t('pages.catalogForms.library.validationScript')}
        </span>
        <textarea
          value={validationScript}
          onChange={(e) => onValidationScript(e.target.value)}
          placeholder={t('pages.catalogForms.library.validationScriptPlaceholder')}
          style={areaStile}
          spellCheck={false}
        />
        <p style={aiutoStile}>{t('pages.catalogForms.library.validationScriptHelp')}</p>
      </div>
    </>
  )
}
