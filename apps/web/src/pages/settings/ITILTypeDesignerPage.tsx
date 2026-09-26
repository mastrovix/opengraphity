import { Loading } from '@/components/ui/Loading'
import { Pill } from '@/components/ui/Pill'
import { Settings2, AlertCircle, Search, GitPullRequest, Inbox } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { Tabs } from '@/components/ui/Tabs'
import { CIIcon } from '@/lib/ciIcon'
import { useITILTypeDesigner } from './useITILTypeDesigner'
import type { Tab } from './useITILTypeDesigner'
import { ITILTypeSettings } from './ITILTypeSettings'
import { ITILTypeFields } from './ITILTypeFields'
import { ITILTypeCIExclusions } from './ITILTypeCIExclusions'
import { ITILTypeRules } from './ITILTypeRules'
import { ITILTypePreview } from './ITILTypePreview'
import { lookupOrError, colors, palette } from '@/lib/tokens'
import { DetailLayout } from '@/components/ui/DetailLayout'

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
        <PageTitle icon={<Settings2 size={22} color="var(--color-icon-accent)" />}>
          {t('itilDesigner.title')}
        </PageTitle>
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
          {t('itilDesigner.subtitle')}
        </p>
      </div>

      {loading && (
        <Loading />
      )}

      {!loading && (
        <DetailLayout sideWidth={220} sideFirst gap={20}>
          {/* Left: Type list */}
          <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '5px 16px 4px', fontSize: 'var(--font-size-label)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--color-slate-light)', background: 'var(--color-slate-bg)', borderBottom: `1px solid ${palette.neutral.borderLight}` }}>
              {t('itilDesigner.itilTypes')}
            </div>
            <div>
              {itilTypes.map((itilType) => {
                const isSelected = itilType.id === selectedTypeId
                const FallbackIcon = lookupOrError(ITIL_TYPE_ICONS, itilType.name, 'ITIL_TYPE_ICONS', Settings2)
                return (
                  <button type="button" key={itilType.id} onClick={() => h.handleSelectType(itilType)}
                    style={{ width: '100%', textAlign: 'left', padding: '10px 16px', background: isSelected ? palette.info.light : 'transparent', borderLeft: `3px solid ${isSelected ? 'var(--color-brand)' : 'transparent'}`, borderTop: 'none', borderRight: 'none', borderBottom: `1px solid ${palette.neutral.borderLight}`, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}>
                    {itilType.icon
                      ? <CIIcon icon={itilType.icon} size={15} color={isSelected ? 'var(--color-brand)' : 'var(--color-slate)'} />
                      : <FallbackIcon size={15} color={isSelected ? 'var(--color-brand)' : 'var(--color-slate)'} style={{ flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, fontSize: 'var(--font-size-body)', fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--color-brand)' : 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {itilType.label}
                    </span>
                    <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', flexShrink: 0 }}>{t('citypeDesigner.fieldCount', { count: itilType.fields.length })}</span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Right: Type editor */}
          {selectedType && settingsForm && (() => {
            const FallbackIcon = lookupOrError(ITIL_TYPE_ICONS, selectedType.name, 'ITIL_TYPE_ICONS', Settings2)
            return (
              <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                {/* Card header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    {selectedType.icon ? <CIIcon icon={selectedType.icon} size={20} color={selectedType.color ?? 'var(--color-brand)'} /> : <FallbackIcon size={20} color="var(--color-brand)" style={{ flexShrink: 0 }} />}
                    <div>
                      <div style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{selectedType.label}</div>
                      <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{selectedType.name}</div>
                    </div>
                    <Pill bg={palette.success.tint} color="var(--color-success)" radius={100} style={{ marginLeft: 8, border: '1px solid var(--border)', fontSize: 'var(--font-size-body)', fontWeight: 500 }}>● {t('common.active')}</Pill>
                  </div>
                </div>
                {/* Tabs */}
                <Tabs<Tab>
                  ariaLabel={t('itilDesigner.tabsLabel')}
                  items={(['settings', 'fields', 'ciExclusions', 'rules', 'preview'] as Tab[]).map((tab) => ({ key: tab, label: tab === 'ciExclusions' ? t('itilDesigner.ciExclusions.tab') : t(`citypeDesigner.tab.${tab}`) }))}
                  value={h.activeTab}
                  onChange={(tab) => h.handleTabChange(tab)}
                  style={{ padding: '0 20px', marginBottom: 0 }}
                />
                {/* Tab content */}
                <div style={{ padding: '20px 24px' }}>
                  {h.activeTab === 'settings' && <ITILTypeSettings settingsForm={settingsForm} setSettingsForm={h.setSettingsForm} settingsSaving={h.settingsSaving} onSaveSettings={h.handleSaveSettings} FallbackIcon={FallbackIcon} />}
                  {h.activeTab === 'fields' && <ITILTypeFields typeId={selectedType.id} typeName={selectedType.name} fields={selectedType.fields} editingFieldId={h.editingFieldId} setEditingFieldId={h.setEditingFieldId} addingField={h.addingField} setAddingField={h.setAddingField} onSaveField={h.handleSaveField} onDeleteField={h.handleDeleteField} enumTypesData={h.enumTypesData} />}
                  {h.activeTab === 'ciExclusions' && <ITILTypeCIExclusions ticketType={selectedType.name} ciTypes={h.ciTypesData?.ciTypes ?? []} />}
                  {h.activeTab === 'rules' && <ITILTypeRules entityType={selectedType.name} fields={selectedType.fields.map((f) => ({ name: f.name, label: f.label, fieldType: f.fieldType, enumValues: f.enumValues, enumTypeName: f.enumTypeName }))} />}
                  {h.activeTab === 'preview' && <ITILTypePreview selectedType={selectedType} setActiveTab={h.handleTabChange} />}
                </div>
              </div>
            )
          })()}
        </DetailLayout>
      )}
    </PageContainer>
  )
}
