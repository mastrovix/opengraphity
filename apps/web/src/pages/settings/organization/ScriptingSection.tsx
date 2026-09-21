/**
 * GLI SCRIPT DEL CLIENTE, accesi o spenti (moduli del catalogo, ondata 6).
 *
 * `scripting_enabled` esisteva dal primo giorno, ma veniva dal PIANO e non
 * aveva nessun interruttore: un tenant starter non poteva avere né la
 * validazione di un campo, né l'azione «esegui script», né — da questa ondata —
 * le FORMULE dei campi calcolati dei moduli. Un campo calcolato spento da un
 * listino è un campo calcolato che non esiste.
 *
 * Il varco resta quello di prima: spento, nessuno script gira, e chi ne ha
 * configurato uno riceve un rifiuto che lo dice. È l'interruttore che è
 * passato di mano, dal listino all'amministratore.
 */
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { GET_SCRIPTING_SETTINGS } from '@/graphql/queries'
import { SET_SCRIPTING_ENABLED } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { OrgSection } from './shared'

interface Impostazioni { enabled: boolean; plan: string }

export function ScriptingSection() {
  const { t } = useTranslation()
  const { data, loading, error, refetch } = useQuery<{ scriptingSettings: Impostazioni }>(
    GET_SCRIPTING_SETTINGS, { fetchPolicy: 'cache-and-network' },
  )
  const [applica, { loading: salvando }] = useMutation(SET_SCRIPTING_ENABLED, {
    onError: (e) => showError(e),
    refetchQueries: [GET_SCRIPTING_SETTINGS],
    onCompleted: () => toast.success(t('pages.organization.scriptingSaved')),
  })
  const impostazioni = data?.scriptingSettings
  /**
   * Corpo a BLOCCO e non espressione: il guardiano i18n legge un `=> nome(` come
   * se fosse testo a schermo (stesso inciampo della terza revisione). Il
   * commento c'è perché «graffe inutili» è la prima cosa che si vorrebbe
   * togliere rileggendo.
   */
  function toggle(enabled: boolean): void {
    void applica({ variables: { enabled } })
  }

  return (
    <OrgSection
      title={t('pages.organization.scripting')}
      description={t('pages.organization.scriptingHelp')}
      loading={loading && !impostazioni}
      error={error ?? null}
      onRetry={() => void refetch()}
    >
      {impostazioni && (
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>
          <input
            type="checkbox"
            checked={impostazioni.enabled}
            disabled={salvando}
            onChange={(e) => { toggle(e.target.checked) }}
            style={{ marginTop: 3 }}
          />
          <span>
            {t('pages.organization.scriptingEnabled')}
            <span style={{ display: 'block', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', maxWidth: '70ch' }}>
              {t('pages.organization.scriptingEnabledHelp')}
            </span>
          </span>
        </label>
      )}
    </OrgSection>
  )
}
