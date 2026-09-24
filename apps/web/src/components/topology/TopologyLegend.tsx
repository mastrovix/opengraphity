/**
 * The legend of the topology graph: which CI types and relation types are on
 * screen, the health colours and the signals. It has no D3, so it lives apart
 * from the graph (and is tested without loading it).
 */
import { useCILabels } from '@/hooks/useCILabels'
import { useTranslation } from 'react-i18next'
import { humanizeValue } from '@opengraphity/web-core'
import { alpha, colors, fontFamily, palette } from '@/lib/tokens'
import { buildTypeIconMap, iconKeyForType } from '@/lib/ciIconPaths'
import { CIIcon } from '@/lib/ciIcon'
import type { TopologyNode, TopologyEdge, CITypeMeta } from './TopologyGraph'
import { NODE_COLOR, EDGE_COLOR, HEALTH_COLOR } from './topologyStyle'

// ── Legend ───────────────────────────────────────────────────────────────────

/**
 * The name of a CI type in the legend: the one rule of the app (useCILabels —
 * the customer's per-language label, matching the type in either spelling),
 * or the type humanized when the metamodel does not have it (D29). It used
 * `label` alone, by exact name (review of 23 Sep 2026).
 */
function nodeTypeLabel(type: string, typeLabel: (t: string) => string, ciTypes: readonly CITypeMeta[] | undefined): string {
  const label = typeLabel(type)
  if (label !== type) return label
  return ciTypes?.find((ct) => ct.name === type)?.label || humanizeValue(type)
}

interface LegendProps {
  nodes:    TopologyNode[]
  edges:    TopologyEdge[]
  ciTypes?: CITypeMeta[]
  /** Mostra la voce "Salute" (down/degraded) quando l'evidenziazione è attiva. */
  highlightHealth?: boolean
}

export function TopologyLegend({ nodes, edges, ciTypes, highlightHealth = false }: LegendProps) {
  const { t } = useTranslation()
  const ciLabels = useCILabels()
  const presentNodeTypes = [...new Set(nodes.map((n) => n.type))].sort()
  const presentEdgeTypes = [...new Set(edges.map((e) => e.type))].sort()

  // Icon lookup by CI type (color is uniform) — stesso registro dei nodi
  const typeIconMap = buildTypeIconMap(ciTypes ?? [])

  return (
    <div style={{
      position: 'absolute', bottom: 16, left: 16,
      background: alpha.white92, backdropFilter: 'blur(4px)',
      border: `1px solid ${colors.border}`, borderRadius: 8,
      padding: '10px 14px', fontSize: 'var(--font-size-table)',
      fontFamily,
      boxShadow: `0 2px 8px ${alpha.black08}`, minWidth: 190,
    }}>
      <div style={{ fontWeight: 700, color: 'var(--color-slate-dark)', marginBottom: 8 }}>{t('components.topologyGraph.legend')}</div>

      {presentNodeTypes.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-label)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}>{t('components.topologyGraph.nodes')}</div>
          {presentNodeTypes.map((type) => (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <CIIcon icon={iconKeyForType(typeIconMap, type)} size={14} color={NODE_COLOR} style={{ flexShrink: 0, margin: 1 }} />
              <span style={{ color: 'var(--color-slate)' }}>{nodeTypeLabel(type, ciLabels.typeLabel, ciTypes)}</span>
            </div>
          ))}
        </div>
      )}

      {presentEdgeTypes.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-label)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}>{t('components.topologyGraph.edges')}</div>
          {presentEdgeTypes.map((type) => (
            <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <svg width={20} height={8}>
                <line x1={0} y1={4} x2={20} y2={4} stroke={EDGE_COLOR} strokeWidth={2} strokeOpacity={0.7} />
              </svg>
              <span style={{ color: 'var(--color-slate)' }}>{humanizeValue(type)}</span>
            </div>
          ))}
        </div>
      )}

      {highlightHealth && (
        <div style={{ marginBottom: 6 }}>
          <div style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-label)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}>{t('components.topologyGraph.health')}</div>
          {(['down', 'degraded'] as const).map((h) => (
            <div key={h} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
              <svg width={16} height={16} aria-hidden="true"><circle cx={8} cy={8} r={5} fill={HEALTH_COLOR[h]!.fill} stroke={HEALTH_COLOR[h]!.stroke} strokeWidth={2} /></svg>
              <span style={{ color: 'var(--color-slate)' }}>{t(h === 'down' ? 'components.topologyGraph.healthDown' : 'components.topologyGraph.healthDegraded')}</span>
            </div>
          ))}
        </div>
      )}

      <div>
        <div style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-label)', fontWeight: 600, marginBottom: 4, textTransform: 'uppercase' }}>{t('components.topologyGraph.signals')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
          <svg width={16} height={16} aria-hidden="true"><circle cx={8} cy={8} r={5} fill="none" stroke={palette.danger.dark} strokeWidth={2} /></svg>
          <span style={{ color: 'var(--color-slate)' }}>{t('components.topologyGraph.activeIncident')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width={16} height={16} aria-hidden="true"><circle cx={8} cy={8} r={5} fill="none" stroke={palette.purple.light} strokeWidth={1.5} /></svg>
          <span style={{ color: 'var(--color-slate)' }}>{t('components.topologyGraph.changeInProgress')}</span>
        </div>
      </div>
    </div>
  )
}
