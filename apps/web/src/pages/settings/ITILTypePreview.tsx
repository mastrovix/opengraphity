import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { CIDynamicForm } from '@/components/CIDynamicForm'
import type { CITypeDef } from '@/contexts/MetamodelContext'
import type { ITILType, Tab } from './useITILTypeDesigner'

export interface ITILTypePreviewProps {
  selectedType: ITILType
  setActiveTab:  (tab: Tab) => void
}

export function ITILTypePreview({ selectedType, setActiveTab }: ITILTypePreviewProps) {
  const { t } = useTranslation()
  // Only the customer's fields: the system ones are drawn by the ticket
  // itself. The form hides them but still validated them, so a required
  // system field — an incident's title — made «Save» do nothing, with no
  // message (tour of 23 Sep 2026).
  const customerFields = selectedType.fields.filter((f) => !f.isSystem)
  const previewType: CITypeDef = {
    id:               selectedType.id,
    name:             selectedType.name,
    label:            selectedType.label,
    icon:             selectedType.icon  || '',
    color:            selectedType.color || 'var(--color-trigger-manual)',
    active:           selectedType.active,
    // I tipi ITIL sono spediti col prodotto (A-6): qui serve solo l'anteprima
    // del form, ma il tipo lo dichiara comunque invece di mentire.
    scope:            'itil',
    tenantId:         'system',
    validationScript: selectedType.validationScript ?? null,
    // I tipi ITIL non sono CI e non entrano nelle mappe dei servizi: nessun ruolo.
    serviceRole:      null,
    chainFamilies:    ['Application', 'Infrastructure'],
    relations:        [],
    systemRelations:  [],
    fields:           customerFields.map((f) => ({
      ...f,
      defaultValue:     null,
      validationScript: null,
      visibilityScript: null,
      defaultScript:    null,
    })),
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 16 }}>
        {t('itilDesigner.previewNote')}
      </p>
      {customerFields.length === 0
        ? <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('itilDesigner.previewNoFields')}</p>
        : <CIDynamicForm
            ciType={previewType}
            onSubmit={async () => { toast.info(t('toast.itil.previewNoSave')) }}
            onCancel={() => setActiveTab('fields')}
          />
      }
    </div>
  )
}
