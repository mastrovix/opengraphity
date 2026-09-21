// ── SkeletonLoader — shimmer animation for loading states ─────────────────────

import { useEffect } from 'react'
import { colors } from '@/lib/tokens'

// Inject keyframes once into document head
let _injected = false
function injectShimmer() {
  if (_injected || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.textContent = `
    @keyframes shimmer {
      0%   { background-position:  200% 0 }
      100% { background-position: -200% 0 }
    }
  `
  document.head.appendChild(style)
  _injected = true
}

// ── SkeletonLine ──────────────────────────────────────────────────────────────

interface SkeletonLineProps {
  width?:  string
  height?: number
}

export function SkeletonLine({ width = '100%', height = 14 }: SkeletonLineProps) {
  useEffect(() => { injectShimmer() }, [])
  return (
    <div
      style={{
        width,
        height,
        borderRadius: 4,
        background:       `linear-gradient(90deg, ${colors.slateBg} 25%, ${colors.border} 50%, ${colors.slateBg} 75%)`,
        backgroundSize:   '200% 100%',
        animation:        'shimmer 1.5s infinite',
      }}
    />
  )
}

// ── SkeletonCard ──────────────────────────────────────────────────────────────

interface SkeletonCardProps {
  rows?: number
}

const ROW_WIDTHS = ['100%', '75%', '55%', '85%', '40%']

export function SkeletonCard({ rows = 3 }: SkeletonCardProps) {
  useEffect(() => { injectShimmer() }, [])
  return (
    <div style={{
      padding:      20,
      border:       `1px solid ${colors.border}`,
      borderRadius: 8,
      background:   colors.white,
      marginBottom: 8,
      display:      'flex',
      flexDirection:'column',
      gap:          12,
    }}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonLine
          key={i}
          width={ROW_WIDTHS[i % ROW_WIDTHS.length]}
          height={i === 0 ? 16 : 13}
        />
      ))}
    </div>
  )
}
