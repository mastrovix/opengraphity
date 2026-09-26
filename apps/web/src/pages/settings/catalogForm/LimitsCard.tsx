/**
 * IL TETTO SUI MODULI, dove lo si può cambiare (moduli del catalogo, ondata 4).
 *
 * Non è un limite di piano: è una cinghia di sicurezza tecnica, uguale per
 * tutti, e chi può creare i campi può allentarla sapendo cosa costa. Per questo
 * sta QUI, accanto alla libreria che limita, e non in una pagina di
 * amministrazione che nessuno collega al rifiuto che ha appena letto.
 *
 * La barra dice quanto manca prima dell'errore: un tetto che si scopre solo
 * quando ti ferma è un tetto mal spiegato.
 */
import { Button } from '@/components/Button'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { GET_CATALOG_FORM_LIMITS } from '@/graphql/queries'
import { SET_CATALOG_FORM_LIMITS } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { colors } from '@/lib/tokens'
import { Input } from '@/components/ui/FormControls'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'

interface Tetti {
  maxLibraryFields: number
  maxFieldsPerForm: number
  /** Quante RIGHE può avere una tabella ripetibile (ondata 7). */
  maxTableRows: number
  libraryFieldsUsed: number
  min: number
  max: number
}

export function LimitsCard() {
  const { t } = useTranslation()
  const { data, refetch } = useQuery<{ catalogFormLimits: Tetti }>(GET_CATALOG_FORM_LIMITS, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const [salva, { loading }] = useMutation(SET_CATALOG_FORM_LIMITS, { onError: (e) => showError(e) })
  const tetti = data?.catalogFormLimits
  const [aperto, setAperto] = useState(false)
  const [libreria, setLibreria] = useState('')
  const [perModulo, setPerModulo] = useState('')
  /*
   * Il terzo tetto: applicato dal server dall'ondata 7 e non configurabile da
   * nessuna parte, mentre tre commenti nel codice promettevano il contrario —
   * un cliente che serve 80 righe doveva farsi cambiare una proprietà nel
   * grafo (revisione del 17 set 2026).
   */
  const [righeTabella, setRigheTabella] = useState('')

  // I campi partono dai valori veri, e li riprendono quando arrivano dal server.
  useEffect(() => {
    if (!tetti) return
    setLibreria(String(tetti.maxLibraryFields))
    setPerModulo(String(tetti.maxFieldsPerForm))
    setRigheTabella(String(tetti.maxTableRows))
  }, [tetti])

  if (!tetti) return null

  const usati = tetti.libraryFieldsUsed
  const quota = Math.min(1, usati / Math.max(1, tetti.maxLibraryFields))
  const vicino = quota >= 0.8

  const conferma = async () => {
    const a = Number(libreria)
    const b = Number(perModulo)
    const c = Number(righeTabella)
    // Scritto come funzione e non come catena di confronti: il guardiano i18n
    // legge un `a < x` seguito da un `>` come se fosse un tag JSX.
    const dentro = (n: number) => Number.isInteger(n) && n >= tetti.min && n <= tetti.max
    if (!dentro(a) || !dentro(b) || !dentro(c)) {
      toast.error(t('pages.catalogForms.limits.outOfRange', { min: tetti.min, max: tetti.max }))
      return
    }
    try {
      await salva({ variables: { maxLibraryFields: a, maxFieldsPerForm: b, maxTableRows: c } })
    } catch {
      // The mutation's onError has already told the user; the boxes stay open with what was typed.
      return
    }
    toast.success(t('pages.catalogForms.limits.saved'))
    setAperto(false)
    void refetch()
  }

  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 14, marginBottom: 16, background: colors.white }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>
            {t('pages.catalogForms.limits.title')}
          </strong>
          <p style={{ margin: '3px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '70ch' }}>
            {t('pages.catalogForms.limits.help')}
          </p>
        </div>
        <Button variant="secondary"
          onClick={() => setAperto(!aperto)}
        >
          {aperto ? t('common.cancel') : t('pages.catalogForms.limits.change')}
        </Button>
      </div>

      <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 220px', minWidth: 160, height: 6, borderRadius: 3, background: colors.slateBg, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(quota * 100)}%`, height: '100%', background: vicino ? 'var(--color-warning)' : 'var(--color-brand)' }} />
        </div>
        <span style={{ fontSize: 'var(--font-size-table)', color: vicino ? 'var(--color-warning)' : 'var(--color-slate)', fontVariantNumeric: 'tabular-nums' }}>
          {t('pages.catalogForms.limits.used', { used: usati, max: tetti.maxLibraryFields })}
        </span>
        <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', fontVariantNumeric: 'tabular-nums' }}>
          {t('pages.catalogForms.limits.perForm', { max: tetti.maxFieldsPerForm })}
        </span>
        <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', fontVariantNumeric: 'tabular-nums' }}>
          {t('pages.catalogForms.limits.tableRows', { max: tetti.maxTableRows })}
        </span>
      </div>

      {aperto && (
        <div style={{ marginTop: 12, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ flex: '1 1 180px', minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
              {t('pages.catalogForms.limits.libraryLabel')}
            </span>
            <Input type="number" min={tetti.min} max={tetti.max} value={libreria} onChange={(e) => setLibreria(e.target.value)} />
          </label>
          <label style={{ flex: '1 1 180px', minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
              {t('pages.catalogForms.limits.perFormLabel')}
            </span>
            <Input type="number" min={tetti.min} max={tetti.max} value={perModulo} onChange={(e) => setPerModulo(e.target.value)} />
          </label>
          <label style={{ flex: '1 1 180px', minWidth: 0 }}>
            <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginBottom: 3 }}>
              {t('pages.catalogForms.limits.tableRowsLabel')}
            </span>
            <Input type="number" min={tetti.min} max={tetti.max} value={righeTabella} onChange={(e) => setRigheTabella(e.target.value)} />
          </label>
          <Button variant="primary"
            onClick={() => conferma()}
            disabled={loading}
          >
            {t('common.save')}
          </Button>
          <p style={{ flexBasis: '100%', margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '70ch' }}>
            {t('pages.catalogForms.limits.range', { min: tetti.min, max: tetti.max })}
          </p>
        </div>
      )}
    </div>
  )
}
