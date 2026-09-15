import { useTranslation } from 'react-i18next'
import { Layers, Layout, Plus } from 'lucide-react'
import { CIIcon } from '@/lib/ciIcon'
import type { CITypeDef } from '@/contexts/MetamodelContext'
import { btnPrimary } from '../shared/designerStyles'
import { colors, palette } from '@/lib/tokens'

interface CITypeListProps {
  ciTypes: CITypeDef[]
  selectedId: string | null
  selectedBase: boolean
  loading: boolean
  onSelectType: (t: CITypeDef) => void
  onSelectBase: () => void
  onNew: () => void
}

const baseEntryStyle = (selected: boolean): React.CSSProperties => ({
  width: '100%', textAlign: 'left',
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 16px', cursor: 'pointer',
  background: selected ? palette.info.light : 'var(--color-slate-bg)',
  borderLeft: `3px solid ${selected ? 'var(--color-brand)' : 'transparent'}`,
  borderTop: 'none', borderRight: 'none',
  borderBottom: '1px solid var(--border)',
})

const typeEntryStyle = (selected: boolean): React.CSSProperties => ({
  width: '100%', textAlign: 'left',
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 16px', cursor: 'pointer',
  background: selected ? palette.info.light : 'transparent',
  borderLeft: `3px solid ${selected ? 'var(--color-brand)' : 'transparent'}`,
  borderTop: 'none', borderRight: 'none',
  borderBottom: `1px solid ${palette.neutral.borderLight}`,
})

export function CITypeList({
  ciTypes,
  selectedId,
  selectedBase,
  loading,
  onSelectType,
  onSelectBase,
  onNew,
}: CITypeListProps) {
  const { t } = useTranslation()
  return (
    <div style={{ background: colors.white, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid var(--border)' }}>
        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{t('citypeDesigner.ciTypes')}</span>
        <button type="button" onClick={onNew} style={{ ...btnPrimary, padding: '4px 10px', fontSize: 'var(--font-size-body)' }}>
          <Plus size={12} /> {t('common.new')}
        </button>
      </div>

      {loading && (
        <div style={{ padding: 20, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('common.loading')}</div>
      )}

      <div style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }}>
        {/* Campi Base special entry */}
        <button type="button" onClick={onSelectBase} style={baseEntryStyle(selectedBase)}>
          <Layout size={15} color={selectedBase ? 'var(--color-brand)' : 'var(--color-slate)'} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-body)', fontWeight: selectedBase ? 600 : 400, color: selectedBase ? 'var(--color-brand)' : 'var(--color-slate)' }}>
              {t('citypeDesigner.baseFields')}
            </div>
            <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('citypeDesigner.sharedByAll')}</div>
          </div>
          <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px', borderRadius: 100, fontWeight: 600, background: palette.teal.bg, color: 'var(--color-brand)', flexShrink: 0 }}>
            {t('citypeDesigner.system')}
          </span>
        </button>

        {/* Separator */}
        <div style={{ padding: '5px 16px 4px', fontSize: 'var(--font-size-label)', fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', background: 'var(--color-slate-bg)', borderBottom: `1px solid ${palette.neutral.borderLight}` }}>
          {t('citypeDesigner.ciTypes')}
        </div>

        {ciTypes.map((ct) => {
          const isSelected = ct.id === selectedId
          return (
            <button type="button" key={ct.id} onClick={() => onSelectType(ct)} style={typeEntryStyle(isSelected)}>
              <CIIcon icon={ct.icon} size={15} color={isSelected ? 'var(--color-brand)' : (ct.color ?? 'var(--color-brand)')} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-size-body)', fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--color-brand)' : 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {ct.label}
                </div>
                <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{ct.name}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px', borderRadius: 100, fontWeight: 500, background: ct.active ? palette.success.tint : 'var(--color-border-light)', color: ct.active ? 'var(--color-success)' : 'var(--color-slate-light)' }}>
                  {ct.active ? t('common.active') : t('common.inactive')}
                </span>
                <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                  {t('citypeDesigner.fieldCount', { count: ct.fields.length })}
                </span>
              </div>
            </button>
          )
        })}
      </div>

      {!loading && ciTypes.length === 0 && (
        <div style={{ padding: '16px 16px 20px', textAlign: 'center' }}>
          <Layers size={24} color={colors.slateLight} style={{ marginBottom: 8 }} />
          <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('citypeDesigner.noCITypes')}</div>
        </div>
      )}
    </div>
  )
}
