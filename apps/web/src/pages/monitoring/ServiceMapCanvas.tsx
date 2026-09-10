/**
 * Mappa del servizio a livelli: il servizio in alto, poi una riga per livello
 * (applicazioni, componenti, infrastruttura…); nodi = card compatte con nome,
 * tipo e salute; archi SVG fra i nodi; percorso d'impatto (dal nodo malato
 * al servizio) evidenziato in rosso/ambra spesso; clic su un nodo → pannello
 * laterale (gestito dal chiamante via `onSelect`).
 *
 * Resa: HTML (card assolute) + SVG puro per gli archi, NON React Flow, per
 * scelta esplicita:
 * - la mappa è congelata e in sola lettura in ondata 1: niente trascinamento,
 *   connessioni o mini-mappa da editor; il layout è calcolato qui
 *   (serviceMapLayout.ts, funzione pura) e non dall'utente;
 * - i nodi sono veri <button> accessibili (nome, tipo, salute in aria-label,
 *   aria-pressed), navigabili da tastiera senza plugin;
 * - React Flow rende i nodi solo dopo averli misurati con ResizeObserver,
 *   che in jsdom è uno stub: i test («un nodo per componente sul livello
 *   giusto, percorso evidenziato») sarebbero ciechi. Qui ogni nodo e arco
 *   porta `data-*` deterministici (livello, salute, percorso).
 * Se in ondata 2 servisse modificare la mappa trascinando, il layout calcolato
 * qui si passa a React Flow come posizioni iniziali senza cambiare il modello.
 *
 * Colori dalla salute: `palette.danger.*` giù, `palette.warning.*` degradato,
 * `palette.success.*` operativo, `palette.purple.*` manutenzione, neutro
 * sconosciuto (SERVICE_HEALTH_FAMILY); mai esadecimali.
 */
import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Star, Wrench } from 'lucide-react'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { CIIcon } from '@/lib/ciIcon'
import { ciTypeLabelKey, enumLabel } from '@/lib/ciEnums'
import { alpha, colors, palette } from '@/lib/tokens'
import { layoutServiceMap, NODE_W, NODE_H, GAP_Y, LABEL_W, PAD, type PathSeverity, type PlacedNode } from './serviceMapLayout'
import { SERVICE_HEALTH_FAMILY, ciHealthLabel, nodeHealthFamily, serviceHealthFamily, serviceHealthLabel } from './servicesShared'
import type { ServiceMapDetail } from '@/types/services'

interface Props {
  map:        ServiceMapDetail
  selectedId: string | null
  onSelect:   (id: string | null) => void
}

const PATH_COLOR: Record<PathSeverity, string> = {
  down:     SERVICE_HEALTH_FAMILY.down.accent,
  degraded: SERVICE_HEALTH_FAMILY.degraded.accent,
}
const EDGE_COLOR = colors.slateLight

export function ServiceMapCanvas({ map, selectedId, onSelect }: Props) {
  const { t } = useTranslation()
  const { getCIType } = useMetamodel()
  const markerBase = useId()
  const layout = useMemo(() => layoutServiceMap(map.service.id, map.nodes, map.edges, map.explanation), [map.service.id, map.nodes, map.edges, map.explanation])

  const typeLabel = (type: string) => {
    const key = ciTypeLabelKey(type)
    return key ? t(key) : (getCIType(type)?.label ?? enumLabel(type))
  }
  const levelLabel = (level: number) =>
    level === 0 ? t('monitoring.services.map.levelService')
    : level === 1 ? t('monitoring.services.map.levelEntry')
    : t('monitoring.services.map.level', { level })
  const marker = (sev: PathSeverity | null) => `url(#${markerBase}-${sev ?? 'edge'})`

  return (
    <div>
      {map.nodes.length === 0 && (
        <p role="status" style={{ margin: '0 0 12px', fontSize: 'var(--font-size-body)', color: palette.warning.text }}>{t('monitoring.services.map.empty')}</p>
      )}
      {/* La mappa scorre nel proprio contenitore, mai la pagina. */}
      <div style={{ overflow: 'auto', maxHeight: 640, border: `1px solid ${colors.border}`, borderRadius: 10, background: palette.neutral.surface1 }}>
        <div data-testid="service-map" style={{ position: 'relative', width: layout.width, height: layout.height }}>
          <svg width={layout.width} height={layout.height} aria-hidden="true" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
            <defs>
              {(['edge', 'down', 'degraded'] as const).map((k) => (
                <marker key={k} id={`${markerBase}-${k}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={k === 'edge' ? EDGE_COLOR : PATH_COLOR[k]} />
                </marker>
              ))}
            </defs>
            {layout.edges.map((e) => (
              <path
                key={e.key}
                d={e.d}
                fill="none"
                stroke={e.highlight ? PATH_COLOR[e.highlight] : EDGE_COLOR}
                strokeWidth={e.highlight ? 3.5 : 1.5}
                strokeDasharray={e.live ? undefined : '6 4'}
                opacity={e.highlight ? 1 : 0.8}
                markerEnd={marker(e.highlight)}
                data-testid="service-map-edge"
                data-source={e.source}
                data-target={e.target}
                data-rel={e.relType}
                data-highlight={e.highlight ?? undefined}
                data-live={e.live ? 'true' : 'false'}
                style={{ pointerEvents: 'visibleStroke' }}
              >
                <title>{e.live ? e.relType : t('monitoring.services.map.legend.edgeMissing')}</title>
              </path>
            ))}
          </svg>

          {layout.levels.map((level, i) => (
            <div key={level} aria-hidden="true" style={{ position: 'absolute', left: PAD, top: PAD + i * (NODE_H + GAP_Y) + NODE_H / 2 - 8, width: LABEL_W - 8, fontSize: 'var(--font-size-label)', fontWeight: 600, letterSpacing: '0.05em', textTransform: 'uppercase', color: colors.slateLight, lineHeight: 1.2 }}>
              {levelLabel(level)}
            </div>
          ))}

          {layout.nodes.map((p) => p.node === null
            ? <RootCard key={p.id} placed={p} map={map} label={t('monitoring.services.map.levelService')} />
            : <NodeCard key={p.id} placed={p} selected={p.id === selectedId} typeLabel={typeLabel(p.node.ci.type)} icon={getCIType(p.node.ci.type)} onSelect={onSelect} />)}
        </div>
      </div>
      <Legend />
    </div>
  )
}

function RootCard({ placed: p, map, label }: { placed: PlacedNode; map: ServiceMapDetail; label: string }) {
  const { t } = useTranslation()
  const fam = serviceHealthFamily(map.health)
  const border = p.onPath ? PATH_COLOR[p.onPath] : fam.border
  return (
    <div
      data-testid="service-map-root"
      data-level="0"
      data-health={map.health}
      data-on-path={p.onPath ?? undefined}
      aria-label={t('monitoring.services.map.nodeLabel', { name: map.service.name, type: label, health: serviceHealthLabel(t, map.health) })}
      style={{ position: 'absolute', left: p.x, top: p.y, width: NODE_W, height: NODE_H, boxSizing: 'border-box', padding: '8px 10px', borderRadius: 10, background: fam.bg, border: `${p.onPath ? 3 : 2}px solid ${border}`, boxShadow: `0 2px 8px ${alpha.black08}`, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, overflow: 'hidden' }}
    >
      <span style={{ fontSize: 'var(--font-size-caption)', fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: fam.text }}>{label}</span>
      <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, color: colors.slateDark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{map.service.name}</span>
      <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, color: fam.text }}>{serviceHealthLabel(t, map.health)}</span>
    </div>
  )
}

interface NodeCardProps {
  placed:    PlacedNode
  selected:  boolean
  typeLabel: string
  icon:      { icon: string; color: string } | undefined
  onSelect:  (id: string | null) => void
}

function NodeCard({ placed: p, selected, typeLabel, icon, onSelect }: NodeCardProps) {
  const { t } = useTranslation()
  const node = p.node!
  const fam = nodeHealthFamily(node.health, node.inMaintenance)
  const border = p.onPath ? PATH_COLOR[p.onPath] : fam.border
  const healthText = node.inMaintenance ? t('monitoring.services.health.maintenance') : ciHealthLabel(t, node.health)
  return (
    <button
      type="button"
      data-testid="service-map-node"
      data-ci-id={node.ci.id}
      data-level={node.level}
      data-health={node.health ?? 'unknown'}
      data-on-path={p.onPath ?? undefined}
      data-cause={p.isCause ? 'true' : undefined}
      aria-pressed={selected}
      aria-label={t('monitoring.services.map.nodeLabel', { name: node.ci.name, type: typeLabel, health: healthText })}
      onClick={() => onSelect(selected ? null : node.ci.id)}
      style={{
        position: 'absolute', left: p.x, top: p.y, width: NODE_W, height: NODE_H, boxSizing: 'border-box',
        textAlign: 'left', font: 'inherit', padding: '8px 10px', borderRadius: 10, cursor: 'pointer',
        background: fam.bg,
        border: `${p.onPath ? 3 : 2}px solid ${border}`,
        boxShadow: selected ? `0 0 0 3px ${alpha.brand20}` : (p.isCause ? `0 0 0 3px ${fam.tint}` : `0 2px 8px ${alpha.black08}`),
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, overflow: 'hidden',
        transition: 'box-shadow 150ms, border-color 150ms',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        {icon && <CIIcon icon={icon.icon} size={14} color={icon.color} style={{ flexShrink: 0 }} />}
        <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, color: colors.slateDark, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{node.ci.name}</span>
        {node.critical && <Star size={12} aria-hidden="true" color={palette.orange.base} fill={palette.orange.base} style={{ flexShrink: 0 }} />}
        {node.inMaintenance && <Wrench size={12} aria-hidden="true" color={palette.purple.base} style={{ flexShrink: 0 }} />}
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-label)', minWidth: 0 }}>
        <span style={{ color: colors.slate, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 }}>{typeLabel}</span>
        <span style={{ fontWeight: 600, color: fam.text, whiteSpace: 'nowrap' }}>{healthText}</span>
      </span>
    </button>
  )
}

function Legend() {
  const { t } = useTranslation()
  const swatch = (bg: string, border: string) => <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 4, background: bg, border: `2px solid ${border}`, boxSizing: 'border-box', flexShrink: 0 }} />
  const line = (color: string, thick: boolean, dashed = false) => (
    <svg aria-hidden="true" width="26" height="8" style={{ flexShrink: 0 }}>
      <line x1="0" y1="4" x2="26" y2="4" stroke={color} strokeWidth={thick ? 3.5 : 1.5} strokeDasharray={dashed ? '4 3' : undefined} />
    </svg>
  )
  const item = (key: string, sample: React.ReactNode, label: string) => (
    <span key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-table)', color: colors.slate }}>{sample}{label}</span>
  )
  return (
    <div aria-label={t('monitoring.services.map.legend.title')} style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginTop: 10 }}>
      {(['down', 'degraded', 'operational', 'maintenance', 'unknown'] as const).map((h) => item(h, swatch(SERVICE_HEALTH_FAMILY[h].bg, SERVICE_HEALTH_FAMILY[h].border), t(`monitoring.services.health.${h}`)))}
      {item('star', <Star size={12} aria-hidden="true" color={palette.orange.base} fill={palette.orange.base} />, t('monitoring.services.map.legend.critical'))}
      {item('path-down', line(PATH_COLOR.down, true), t('monitoring.services.map.legend.pathDown'))}
      {item('path-degraded', line(PATH_COLOR.degraded, true), t('monitoring.services.map.legend.pathDegraded'))}
      {item('edge', line(EDGE_COLOR, false), t('monitoring.services.map.legend.edge'))}
      {item('edge-missing', line(PATH_COLOR.down, true, true), t('monitoring.services.map.legend.edgeMissing'))}
    </div>
  )
}
