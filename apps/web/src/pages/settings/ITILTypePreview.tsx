import { toast } from 'sonner'
import { CIDynamicForm } from '@/components/CIDynamicForm'
import type { CITypeDef } from '@/contexts/MetamodelContext'
import type { ITILType, Tab } from './useITILTypeDesigner'

export interface ITILTypePreviewProps {
  selectedType: ITILType
  setActiveTab:  (tab: Tab) => void
}

export function ITILTypePreview({ selectedType, setActiveTab }: ITILTypePreviewProps) {
  const previewType: CITypeDef = {
    id:               selectedType.id,
    name:             selectedType.name,
    label:            selectedType.label,
    icon:             selectedType.icon  || '',
    color:            selectedType.color || '#0284c7',
    active:           selectedType.active,
    validationScript: selectedType.validationScript ?? null,
    chainFamilies:    ['Application', 'Infrastructure'],
    relations:        [],
    systemRelations:  [],
    fields:           selectedType.fields.map((f) => ({
      ...f,
      defaultValue:     null,
      validationScript: null,
      visibilityScript: null,
      defaultScript:    null,
    })),
  }

  return (
    <div style={{ maxWidth: 520 }}>
      <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8', marginBottom: 16 }}>
        Anteprima del form — tutti i campi visibili.
      </p>
      {selectedType.fields.length === 0
        ? <p style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8' }}>Nessun campo. Aggiungi campi nella tab "Campi".</p>
        : <CIDynamicForm
            ciType={previewType}
            onSubmit={async () => { toast.info('Preview — nessun dato salvato') }}
            onCancel={() => setActiveTab('fields')}
          />
      }
    </div>
  )
}
