import { Layers, Layout, Plus } from 'lucide-react'
import { CIIcon } from '@/lib/ciIcon'
import type { CITypeDef } from '@/contexts/MetamodelContext'

interface CITypeListProps {
  ciTypes: CITypeDef[]
  selectedId: string | null
  selectedBase: boolean
  loading: boolean
  onSelectType: (t: CITypeDef) => void
  onSelectBase: () => void
  onNew: () => void
}

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
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid #e5e7eb' }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Tipi CI</span>
        <button
          onClick={onNew}
          style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px', border: 'none', borderRadius: 5, background: 'var(--color-brand)', color: '#fff', fontSize: 12, cursor: 'pointer' }}
        >
          <Plus size={12} /> Nuovo
        </button>
      </div>

      {loading && <div style={{ padding: 20, color: 'var(--color-slate-light)', fontSize: 14 }}>Caricamento…</div>}

      <div style={{ maxHeight: 'calc(100vh - 220px)', overflowY: 'auto' }}>
        {/* Campi Base special entry */}
        <div
          onClick={onSelectBase}
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '10px 16px', cursor: 'pointer',
            borderBottom: '1px solid #e5e7eb',
            background: selectedBase ? 'var(--color-brand-light)' : '#f9fafb',
            borderLeft: selectedBase ? '3px solid #0284c7' : '3px solid transparent',
          }}
        >
          <Layout size={16} color="var(--color-brand)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: selectedBase ? 600 : 400, color: selectedBase ? 'var(--color-brand)' : 'var(--color-slate)' }}>
              Campi Base
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>Condivisi da tutti i tipi</div>
          </div>
          <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 100, fontWeight: 600, background: '#cffafe', color: 'var(--color-brand)' }}>
            Sistema
          </span>
        </div>

        {/* Separator */}
        <div style={{ padding: '6px 16px 4px', fontSize: 10, fontWeight: 600, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em', background: '#f9fafb', borderBottom: '1px solid #f3f4f6' }}>
          Tipi CI
        </div>

        {ciTypes.map((t) => {
          const isSelected = t.id === selectedId
          return (
            <div
              key={t.id}
              onClick={() => onSelectType(t)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 16px', cursor: 'pointer',
                borderBottom: '1px solid #f3f4f6',
                background: isSelected ? 'var(--color-brand-light)' : 'transparent',
                borderLeft: isSelected ? '3px solid #0284c7' : '3px solid transparent',
              }}
            >
              <CIIcon icon={t.icon} size={16} color={t.color ?? 'var(--color-brand)'} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: isSelected ? 600 : 400, color: isSelected ? 'var(--color-brand)' : 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t.label}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>{t.name}</div>
              </div>
              <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 100, fontWeight: 500, background: t.active ? '#dcfce7' : '#f3f4f6', color: t.active ? '#16a34a' : 'var(--color-slate-light)' }}>
                {t.active ? 'active' : 'inactive'}
              </span>
            </div>
          )
        })}
      </div>

      {!loading && ciTypes.length === 0 && (
        <div style={{ padding: '16px 16px 20px', textAlign: 'center' }}>
          <Layers size={24} color="var(--color-slate-light)" style={{ marginBottom: 8 }} />
          <div style={{ fontSize: 13, color: 'var(--color-slate-light)' }}>Nessun tipo CI</div>
        </div>
      )}
    </div>
  )
}
