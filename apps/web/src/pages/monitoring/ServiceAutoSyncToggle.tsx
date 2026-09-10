/**
 * Interruttore «Aggiorna automaticamente i componenti» (ondata 5, solo admin),
 * dentro il riquadro del servizio: acceso = mappa viva (i componenti nuovi
 * entrano da soli e quelli spariti escono), spento = mappa congelata (i
 * cambiamenti restano una proposta da accettare nel dialogo del diff).
 * In tutte e due le modalità le esclusioni e i componenti aggiunti a mano
 * restano dove sono: lo dice l'aiuto sotto l'interruttore.
 *
 * Concorrenza: la mutation porta `expectedVersion` = la versione letta. Se la
 * versione non combacia — un altro amministratore, oppure la sincronizzazione
 * automatica che ha appena cambiato la mappa — l'API rifiuta e qui compare una
 * riga `role="alert"` col messaggio del server e «Ricarica»: mai una
 * sovrascrittura silenziosa, mai un interruttore che finge di essere cambiato.
 */
import { useId, useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/Button'
import { Toggle } from '@/components/ui/Toggle'
import { errorMessage } from '@/hooks/useMutationWithToast'
import { SET_SERVICE_MAP_AUTO_SYNC } from '@/graphql/mutations'
import { colors, palette } from '@/lib/tokens'
import type { ServiceMapDetail } from '@/types/services'

interface Props {
  map: ServiceMapDetail
  /** Rilegge la mappa dopo un conflitto di versione. */
  onReload: () => void
}

const hint: React.CSSProperties = { margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: colors.slateLight, lineHeight: 1.5 }

export function ServiceAutoSyncToggle({ map, onReload }: Props) {
  const { t } = useTranslation()
  const uid = useId()
  const labelId = `${uid}-label`
  const [saveError, setSaveError] = useState<string | null>(null)
  const [setAutoSync, { loading: saving }] = useMutation<{ setServiceMapAutoSync: ServiceMapDetail }>(SET_SERVICE_MAP_AUTO_SYNC)

  async function onChange(next: boolean) {
    setSaveError(null)
    try {
      const res = await setAutoSync({ variables: { id: map.id, expectedVersion: map.version, autoSync: next } })
      if (!res.data?.setServiceMapAutoSync) throw new Error(t('monitoring.services.detail.noResult', { operation: 'setServiceMapAutoSync' }))
    } catch (e) {
      setSaveError(errorMessage(e))
    }
  }

  return (
    <div data-testid="service-auto-sync" style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${colors.border}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Il nome accessibile è il testo accanto (labelledBy): lo screen reader lo legge una volta sola. */}
        <Toggle
          id={`${uid}-switch`}
          checked={map.autoSync}
          onChange={(v) => void onChange(v)}
          label={t('monitoring.services.syncMode.toggle')}
          labelledBy={labelId}
          disabled={saving}
        />
        <label id={labelId} htmlFor={`${uid}-switch`} style={{ fontSize: 'var(--font-size-body)', color: saving ? colors.slateLight : colors.slateDark, cursor: saving ? 'default' : 'pointer' }}>
          {t('monitoring.services.syncMode.toggle')}
        </label>
      </div>
      <p style={hint}>{t('monitoring.services.syncMode.toggleHelp')}</p>
      <p style={hint}>{t('monitoring.services.syncMode.toggleGuarantee')}</p>

      {saveError && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginTop: 10, padding: '8px 12px', borderRadius: 8, background: palette.danger.bg, border: `1px solid ${palette.danger.border}`, color: palette.danger.text, fontSize: 'var(--font-size-body)' }}>
          <span>{t('monitoring.services.syncMode.saveFailed', { error: saveError })}</span>
          <Button variant="secondary" size="xs" onClick={onReload}>{t('monitoring.services.rulesEdit.reload')}</Button>
        </div>
      )}
    </div>
  )
}
