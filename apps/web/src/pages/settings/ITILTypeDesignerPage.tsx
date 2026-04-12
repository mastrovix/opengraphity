import { Settings2, AlertCircle, Search, GitPullRequest, Inbox } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { CIIcon } from '@/lib/ciIcon'
import { useITILTypeDesigner } from './useITILTypeDesigner'
import type { Tab } from './useITILTypeDesigner'
import { ITILTypeSettings } from './ITILTypeSettings'
import { ITILTypeFields } from './ITILTypeFields'
import { ITILTypeCIRelations } from './ITILTypeCIRelations'
import { ITILTypeRules } from './ITILTypeRules'
import { ITILTypePreview } from './ITILTypePreview'

const ITIL_TYPE_ICONS: Record<string, LucideIcon> = {
  incident:        AlertCircle,
  problem:         Search,
  change:          GitPullRequest,
  service_request: Inbox,
}

export function ITILTypeDesignerPage() {
  const h = useITILTypeDesigner()
  const { t, loading, itilTypes, selectedType, selectedTypeId, settingsForm } = h

  return (
    <PageContainer>
      <div style={{ marginBottom: 24 }}>
        <PageTitle icon={<Settings2 size={22} color="#38bdf8" />}>
          {t('itilDesigner.title')}
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 4, marginBottom: 0 }}>
          {t('itilDesigner.subtitle')}
        </p>
      </div>

      {loading && (
        <div style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', padding: 16 }}>
          {t('common.loading')}
        </div>
      )}

      {!loading && (
        <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20, alignItems: 'start' }}>
          {/* Left: Type list */}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '5px 16px 4px', fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#94a3b8', background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>
              ITIL Types
            </div>
            <div>
              {itilTypes.map((itilType) => {
                const isSelected = itilType.id === selectedTypeId
                const FallbackIcon = ITIL_TYPE_ICONS[itilType.name] ?? Settings2
                return (
                  <button key={itilType.id} onClick={() => h.handleSelectType(itilType)}
                    style={{ width: '100%', textAlign: 'left', padding: '10px 16px', background: isSelected ? '#f0f9ff' : 'transparent', borderLeft: `3px solid ${isSelected ? 'var(--color-brand)' : 'transparent'}`, borderTop: 'none', borderRight: 'none', borderBottom: '1px solid #f3f4f6', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
                    {itilType.icon
                      ? <CIIcon icon={itilType.icon} size={15} color={isSelected ? 'var(--color-brand)' : '#64748b'} />
                      : <FallbackIcon size={15} color={isSelected ? 'var(--color-brand)' : '#64748b'} style={{ flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-size-body)', fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--color-brand)' : 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {itilType.label}
                    </span>
                    <span style={{ fontSize: 'var(--font-size-label)', color: '#94a3b8', flexShrink: 0 }}>{itilType.fields.length} campi</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Right: Type editor */}
          {selectedType && settingsForm && (() => {
            const FallbackIcon = ITIL_TYPE_ICONS[selectedType.name] ?? Settings2
            return (
              <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
                {/* Card header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid #e5e7eb' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {selectedType.icon ? <CIIcon icon={selectedType.icon} size={20} color={selectedType.color ?? 'var(--color-brand)'} /> : <FallbackIcon size={20} color="var(--color-brand)" style={{ flexShrink: 0 }} />}
                    <div>
                      <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{selectedType.label}</div>
                      <div style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8' }}>{selectedType.name}</div>
                    </div>
                    <button style={{ marginLeft: 8, padding: '3px 10px', border: '1px solid #e5e7eb', borderRadius: 100, fontSize: 'var(--font-size-body)', cursor: 'default', background: '#dcfce7', color: '#16a34a', fontWeight: 500 }}>● active</button>
                  </div>
                </div>
                {/* Tabs */}
                <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 20px' }}>
                  {(['settings', 'fields', 'relations', 'rules', 'preview'] as Tab[]).map((tab) => (
                    <button key={tab} onClick={() => h.handleTabChange(tab)}
                      style={{ padding: '10px 14px', border: 'none', borderBottom: h.activeTab === tab ? '2px solid var(--color-brand)' : '2px solid transparent', marginBottom: -1, background: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer', color: h.activeTab === tab ? 'var(--color-brand)' : 'var(--color-slate)', fontWeight: h.activeTab === tab ? 600 : 400 }}>
                      {tab === 'settings' ? 'Impostazioni' : tab === 'fields' ? 'Campi' : tab === 'relations' ? 'Relazioni CI' : tab === 'rules' ? 'Regole' : 'Preview'}
                    </button>
                  ))}
                </div>
                {/* Tab content */}
                <div style={{ padding: '20px 24px' }}>
                  {h.activeTab === 'settings' && <ITILTypeSettings settingsForm={settingsForm} setSettingsForm={h.setSettingsForm} settingsSaving={h.settingsSaving} onSaveSettings={h.handleSaveSettings} FallbackIcon={FallbackIcon} />}
                  {h.activeTab === 'fields' && <ITILTypeFields typeId={selectedType.id} fields={selectedType.fields} editingFieldId={h.editingFieldId} setEditingFieldId={h.setEditingFieldId} addingField={h.addingField} setAddingField={h.setAddingField} onSaveField={h.handleSaveField} onDeleteField={h.handleDeleteField} enumTypesData={h.enumTypesData} />}
                  {h.activeTab === 'relations' && <ITILTypeCIRelations typeName={selectedType.name} rules={h.ciRulesData?.itilCIRelationRules ?? []} ciTypes={h.ciTypesData?.ciTypes ?? []} showRelForm={h.showRelForm} setShowRelForm={h.setShowRelForm} relForm={h.relForm} setRelForm={h.setRelForm} onCreateRule={h.handleCreateRule} onDeleteRule={h.handleDeleteRule} />}
                  {h.activeTab === 'rules' && <ITILTypeRules entityType={selectedType.name} fields={selectedType.fields.map((f) => ({ name: f.name, label: f.label, fieldType: f.fieldType, enumValues: f.enumValues }))} workflowSteps={h.ITIL_WORKFLOW_STEPS[selectedType.name] ?? []} />}
                  {h.activeTab === 'preview' && <ITILTypePreview selectedType={selectedType} setActiveTab={h.handleTabChange} />}
                </div>
              </div>
            )
          })()}
        </div>
      )}
    </PageContainer>
  )
}
