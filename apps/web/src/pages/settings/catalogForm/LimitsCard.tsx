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
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { GET_CATALOG_FORM_LIMITS } from '@/graphql/queries'
import { SET_CATALOG_FORM_LIMITS } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { colors, fontWeight } from '@/lib/tokens'
import { Input } from '@/components/ui/FormControls'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'

interface Tetti {
  maxLibraryFields: number
  maxFieldsPerForm: number
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

  // I campi partono dai valori veri, e li riprendono quando arrivano dal server.
  useEffect(() => {
    if (!tetti) return
    setLibreria(String(tetti.maxLibraryFields))
    setPerModulo(String(tetti.maxFieldsPerForm))
  }, [tetti])

  if (!tetti) return null

  const usati = tetti.libraryFieldsUsed
  const quota = Math.min(1, usati / Math.max(1, tetti.maxLibraryFields))
  const vicino = quota >= 0.8

  const conferma = async () => {
    const a = Number(libreria)
    const b = Number(perModulo)
    // Scritto come funzione e non come catena di confronti: il guardiano i18n
    // legge un `a < x` seguito da un `>` come se fosse un tag JSX.
    const dentro = (n: number) => Number.isInteger(n) && n >= tetti.min && n <= tetti.max
    if (!dentro(a) || !dentro(b)) {
      toast.error(t('pages.catalogForms.limits.outOfRange', { min: tetti.min, max: tetti.max }))
      return
    }
    const r = await salva({ variables: { maxLibraryFields: a, maxFieldsPerForm: b } })
    if (!r.data) return
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
        <button type="button" onClick={() => setAperto(!aperto)}
          style={{ padding: '5px 12px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.white, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', cursor: 'pointer' }}>
          {aperto ? t('common.cancel') : t('pages.catalogForms.limits.change')}
        </button>
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
          <button type="button" onClick={() => void conferma()} disabled={loading}
            style={{ padding: '7px 14px', borderRadius: 8, border: 'none', background: 'var(--color-brand)', color: colors.white, fontSize: 'var(--font-size-body)', fontWeight: fontWeight.medium, cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
            {t('common.save')}
          </button>
          <p style={{ flexBasis: '100%', margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '70ch' }}>
            {t('pages.catalogForms.limits.range', { min: tetti.min, max: tetti.max })}
          </p>
        </div>
      )}
    </div>
  )
}
