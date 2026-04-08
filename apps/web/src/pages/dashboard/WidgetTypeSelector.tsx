import {
  Hash, BarChart2, TrendingUp, PieChart, Table, Gauge,
} from 'lucide-react'
import { WIDGET_TYPES } from './useWidgetConfig'

// ── Icon lookup ──────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ComponentType<{ size: number }>> = {
  Hash, BarChart2, TrendingUp, PieChart, Table, Gauge,
}

// ── Props ────────────────────────────────────────────────────────────────────

interface WidgetTypeSelectorProps {
  widgetType: string
  color:      string
  onSelect:   (value: string) => void
}

// ── Component ────────────────────────────────────────────────────────────────

export function WidgetTypeSelector({ widgetType, color, onSelect }: WidgetTypeSelectorProps) {
  return (
    <div>
      <label style={labelStyle}>Tipo widget</label>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
        {WIDGET_TYPES.map(({ value, label, icon }) => {
          const Icon = ICON_MAP[icon]
          const selected = widgetType === value
          return (
            <button
              key={value}
              onClick={() => onSelect(value)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
                padding: '10px 6px', borderRadius: 8, cursor: 'pointer',
                border: selected ? `2px solid ${color}` : '1.5px solid #e5e7eb',
                background: selected ? `${color}14` : '#fafafa',
                color: selected ? color : 'var(--color-slate)',
                transition: 'all 0.1s',
              }}
            >
              {Icon && <Icon size={20} />}
              <span style={{ fontSize: 11, fontWeight: 600 }}>{label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Styles ───────────────────────────────────────────────────────────────────

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, fontWeight: 700,
  color: 'var(--color-slate)', marginBottom: 5,
  letterSpacing: 0.3, textTransform: 'uppercase',
}
