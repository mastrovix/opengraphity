/**
 * MODULI DEL CATALOGO (ondata 1).
 *
 * Due schede, che sono i due strati del modello:
 *  - «Moduli»: il modulo di una voce di catalogo, con l'anteprima vera.
 *  - «Libreria dei campi»: i campi del tenant, definiti una volta e riusati.
 *
 * Perché in una pagina sola: sono due passaggi dello stesso lavoro, e chi
 * compone un modulo si accorge a metà che gli serve un campo nuovo. Restano
 * però due schede, non un unico calderone, perché i permessi sono diversi —
 * comporre un modulo è `config.catalog`, creare un campo è `config.metamodel`,
 * cioè toccare la forma dei dati.
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ClipboardList } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Tabs } from '@/components/ui/Tabs'
import { FormBuilderPanel } from './catalogForm/FormBuilderPanel'
import { FieldLibraryPanel } from './catalogForm/FieldLibraryPanel'

type Scheda = 'forms' | 'library'

export function CatalogFormsPage() {
  const { t } = useTranslation()
  const [scheda, setScheda] = useState<Scheda>('forms')

  return (
    <PageContainer>
      <div style={{ marginBottom: 20 }}>
        <PageTitle icon={<ClipboardList size={22} color="var(--color-icon-accent)" />}>
          {t('pages.catalogForms.title')}
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0, maxWidth: '75ch' }}>
          {t('pages.catalogForms.intro')}
        </p>
      </div>

      <Tabs
        ariaLabel={t('pages.catalogForms.title')}
        value={scheda}
        onChange={setScheda}
        items={[
          { key: 'forms', label: t('pages.catalogForms.tabs.forms') },
          { key: 'library', label: t('pages.catalogForms.tabs.library') },
        ]}
      />

      {scheda === 'forms' ? <FormBuilderPanel /> : <FieldLibraryPanel />}
    </PageContainer>
  )
}
