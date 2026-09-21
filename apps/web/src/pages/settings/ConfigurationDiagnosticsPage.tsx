/**
 * DIAGNOSTICA DELLA CONFIGURAZIONE: cosa manca, cosa è rotto, dove si aggiusta.
 *
 * I rilievi c'erano già — li compone l'API (`configurationIssues`) — e si
 * leggevano in un banner in cima a OGNI pagina: con tre voci aperte prendeva
 * un quinto dello schermo ovunque, e il pulsante «nascondi» lo spegneva fino
 * al ricaricamento. Troppo o niente.
 *
 * Decisione del proprietario (20 set 2026): l'elenco vive qui, in
 * Configurazione, e su ogni pagina resta una pastiglia col numero che porta
 * qui. Non si perde niente e non ingombra niente.
 */
import { useTranslation } from 'react-i18next'
import { Stethoscope } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { ConfigurationIssuesPanel } from '@/components/ConfigurationIssuesPanel'

export function ConfigurationDiagnosticsPage() {
  const { t } = useTranslation()
  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Stethoscope size={22} color="var(--color-icon-accent)" />}>{t('pages.configurationDiagnostics.title')}</PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
          {t('pages.configurationDiagnostics.subtitle')}
        </p>
      </div>
      {/* Niente `SectionCard`: il titolo della sezione sarebbe stato il conto
          («Ci sono 3 cose da sistemare»), che il pannello scrive già — due
          intestazioni per la stessa cosa. Resta la cornice. */}
      <div style={{ background: 'var(--color-white)', border: '1px solid var(--color-border)', borderRadius: 8, padding: 16 }}>
        <ConfigurationIssuesPanel />
      </div>
    </PageContainer>
  )
}
