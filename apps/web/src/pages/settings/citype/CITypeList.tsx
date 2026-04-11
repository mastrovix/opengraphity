import { Layers, Layout, Plus } from 'lucide-react'
import { CIIcon } from '@/lib/ciIcon'
import type { CITypeDef } from '@/contexts/MetamodelContext'
import { btnPrimary } from '../shared/designerStyles'

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
  background: selected ? '#f0f9ff' : '#f9fafb',
  borderLeft: `3px solid ${selected ? 'var(--color-brand)' : 'transparent'}`,
  borderTop: 'none', borderRight: 'none',
  borderBottom: '1px solid #e5e7eb',
})

const typeEntryStyle = (selected: boolean): React.CSSProperties => ({
  width: '100%', textAlign: 'left',
  display: 'flex', alignItems: 'center', gap: 10,
  padding: '10px 16px', cursor: 'pointer',
  background: selected ? '#f0f9ff' : 'transparent',
  borderLeft: `3px solid ${selected ? 'var(--color-brand)' : 'transparent'}`,
  borderTop: 'none', borderRight: 'none',
  borderBottom: '1px solid #f3f4f6',
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
  return (
    <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: '1px solid #e5e7eb' }}>
        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>Tipi CI</span>
        <button onClick={onNew} style={{ ...btnPrimary, padding: '4px 10px', fontSize: 'var(--font-size-body)' }}>
          <Plus size={12} /> Nuovo
        </button>
      </div>

      {loading && (
        <div style={{ padding: 20, color: '#94a3b8', fontSize: 'var(--font-size-body)' }}>Caricamento…</div>
      )}

      <div style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }}>
        {/* Campi Base special entry */}
        <button onClick={onSelectBase} style={baseEntryStyle(selectedBase)}>
          <Layout size={15} color={selectedBase ? 'var(--color-brand)' : '#64748b'} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 'var(--font-size-body)', fontWeight: selectedBase ? 600 : 400, color: selectedBase ? 'var(--color-brand)' : 'var(--color-slate)' }}>
              Campi Base
            </div>
            <div style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8' }}>Condivisi da tutti i tipi</div>
          </div>
          <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px', borderRadius: 100, fontWeight: 600, background: '#cffafe', color: 'var(--color-brand)', flexShrink: 0 }}>
            Sistema
          </span>
        </button>

        {/* Separator */}
        <div style={{ padding: '5px 16px 4px', fontSize: 'var(--font-size-label)', fontWeight: 600, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>
          Tipi CI
        </div>

        {ciTypes.map((t) => {
          const isSelected = t.id === selectedId
          return (
            <button key={t.id} onClick={() => onSelectType(t)} style={typeEntryStyle(isSelected)}>
              <CIIcon icon={t.icon} size={15} color={isSelected ? 'var(--color-brand)' : (t.color ?? 'var(--color-brand)')} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-size-body)', fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--color-brand)' : 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t.label}
                </div>
                <div style={{ fontSize: 'var(--font-size-table)', color: '#94a3b8' }}>{t.name}</div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 }}>
                <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 6px', borderRadius: 100, fontWeight: 500, background: t.active ? '#dcfce7' : '#f3f4f6', color: t.active ? '#16a34a' : '#94a3b8' }}>
                  {t.active ? 'active' : 'inactive'}
                </span>
                <span style={{ fontSize: 'var(--font-size-label)', color: '#94a3b8' }}>
                  {t.fields.length} campi
                </span>
              </div>
            </button>
          )
        })}
      </div>

      {!loading && ciTypes.length === 0 && (
        <div style={{ padding: '16px 16px 20px', textAlign: 'center' }}>
          <Layers size={24} color="#94a3b8" style={{ marginBottom: 8 }} />
          <div style={{ fontSize: 'var(--font-size-body)', color: '#94a3b8' }}>Nessun tipo CI</div>
        </div>
      )}
    </div>
  )
}
