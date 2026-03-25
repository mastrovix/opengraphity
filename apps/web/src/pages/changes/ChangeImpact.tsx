import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { ImpactPanel } from '@/components/ImpactPanel'
import type { ImpactAnalysis } from '@/components/ImpactPanel'

interface Props {
  impactAnalysis: ImpactAnalysis | null
  hasCIs: boolean
}

export function ChangeImpact({ impactAnalysis, hasCIs }: Props) {
  const [open, setOpen] = useState(true)

  if (!hasCIs || !impactAnalysis) return null

  const cardStyle: React.CSSProperties = {
    backgroundColor: '#fff', border: '1px solid #e2e6f0', borderRadius: 10, padding: 0, marginBottom: 16,
  }

  return (
    <div style={cardStyle}>
      <div
        onClick={() => setOpen((p) => !p)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', padding: '14px 20px', borderBottom: open ? '1px solid #e5e7eb' : 'none' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-slate-dark)' }}>Impact Analysis</span>
        </div>
        {open ? <ChevronDown size={16} color="var(--color-slate-light)" /> : <ChevronRight size={16} color="var(--color-slate-light)" />}
      </div>
      {open && <ImpactPanel analysis={impactAnalysis} compact={false} />}
    </div>
  )
}
