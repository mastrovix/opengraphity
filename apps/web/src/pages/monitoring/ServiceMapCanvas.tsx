/**
 * Mappa del servizio a livelli: il servizio in alto, poi una riga per livello
 * (applicazioni, componenti, infrastruttura…); nodi = card compatte con nome,
 * tipo e salute; archi SVG fra i nodi; percorso d'impatto (dal nodo malato
 * al servizio) evidenziato in rosso/ambra spesso; clic su un nodo → pannello
 * laterale (gestito dal chiamante via `onSelect`).
 *
 * Resa: HTML (card assolute) + SVG puro per gli archi, NON React Flow, per
 * scelta esplicita:
 * - la mappa è in sola lettura: niente trascinamento, connessioni o mini-mappa
 *   da editor; il layout è calcolato in serviceMapLayout.ts (funzione pura) e
 *   non dall'utente;
 * - i nodi sono veri <button> accessibili (nome, tipo, salute in aria-label,
 *   aria-pressed), navigabili da tastiera senza plugin;
 * - React Flow rende i nodi solo dopo averli misurati con ResizeObserver,
 *   che in jsdom è uno stub: i test («un nodo per componente sul livello
 *   giusto, percorso evidenziato») sarebbero ciechi. Qui ogni nodo e arco
 *   porta `data-*` deterministici (livello, salute, percorso).
 *
 * Revisione 2 · C-9 (la mappa alla scala vera):
 * - righe allineate a sinistra (il servizio è sempre in alto a sinistra);
 * - il contenitore scorre sul nodo selezionato (`scrollIntoView`), e
 *   all'apertura sulla prima causa (o sul servizio se non ce ne sono);
 * - le etichette dei livelli stanno in una colonna FISSA (`position: sticky;
 *   left: 0`): prima sparivano al primo scorrimento orizzontale;
 * - sopra FOCUS_THRESHOLD nodi si apre in modalità «solo percorso d'impatto»
 *   (il resto di ogni riga in un chip «+N», espandibile);
 * - ricerca del nodo per nome e zoom «Adatta» (0,5–1) con `transform: scale()`.
 *
 * Revisione 2 · C-10 (tastiera e lettori di schermo): contenitore
 * `role="group"` con nome, roving tabindex (UN solo nodo nel giro dei tab,
 * frecce fra i nodi della riga, su/giù fra i livelli seguendo `via`),
 * `aria-describedby` col percorso per i nodi sul percorso d'impatto, legenda
 * come lista vera e riassunto testuale nascosto prima della mappa.
 *
 * Colori dalla salute: `palette.danger.*` giù, `palette.warning.*` degradato,
 * `palette.success.*` operativo, `palette.purple.*` manutenzione, neutro
 * sconosciuto (SERVICE_HEALTH_FAMILY); mai esadecimali.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Maximize2, Search, Star, Wrench, X } from 'lucide-react'
import { Button } from '@/components/Button'
import { Input } from '@/components/ui/FormControls'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { CIIcon } from '@/lib/ciIcon'
import { ciTypeLabelKey, enumLabel } from '@/lib/ciEnums'
import { alpha, colors, palette } from '@/lib/tokens'
import {
  layoutServiceMap,
  NODE_W, NODE_H, GAP_Y, LABEL_W, PAD, CHIP_W, CHIP_H, FOCUS_THRESHOLD,
  type PathSeverity, type PlacedNode,
} from './serviceMapLayout'
import { SERVICE_HEALTH_FAMILY, causeSequenceLabel, ciHealthLabel, nodeHealthFamily, serviceHealthFamily, serviceHealthLabel } from './servicesShared'
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

/** Zoom: sotto 0,5 le etichette non si leggono più, sopra 1 non si ingrandisce (la mappa non è una foto). */
const SCALE_MIN = 0.5
const SCALE_MAX = 1
/** Quanti nomi al più nell'elenco della ricerca. */
const SEARCH_MAX = 8

/** Testo solo per le tecnologie assistive (riassunto della mappa, descrizioni via `aria-describedby`). */
const SR_ONLY: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
}

export function ServiceMapCanvas({ map, selectedId, onSelect }: Props) {
  const { t } = useTranslation()
  const { getCIType } = useMetamodel()
  const markerBase = useId()
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const nodeRefs  = useRef(new Map<string, HTMLElement>())

  /**
   * Modalità percorso di default solo se c'è un percorso da isolare: con tanti
   * nodi e nessuna causa nasconderebbe tutto senza mostrare niente.
   */
  const focusByDefault = map.nodes.length > FOCUS_THRESHOLD && map.explanation.length > 0
  const [focus, setFocus]       = useState(focusByDefault)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set<number>())
  const [scale, setScale]       = useState(1)
  const [search, setSearch]     = useState('')

  // Il nodo selezionato resta visibile anche in modalità percorso: non deve
  // sparire sotto le mani di chi l'ha appena scelto dalla ricerca o da «Perché».
  const keep = useMemo(() => new Set(selectedId === null ? [] : [selectedId]), [selectedId])
  const layout = useMemo(
    () => layoutServiceMap(map.service.id, map.nodes, map.edges, map.explanation, { focus, expanded, keep }),
    [map.service.id, map.nodes, map.edges, map.explanation, focus, expanded, keep],
  )

  const typeLabel = (type: string) => {
    const key = ciTypeLabelKey(type)
    return key ? t(key) : (getCIType(type)?.label ?? enumLabel(type))
  }
  const levelLabel = (level: number) =>
    level === 0 ? t('monitoring.services.map.levelService')
    : level === 1 ? t('monitoring.services.map.levelEntry')
    : t('monitoring.services.map.level', { level })
  const marker = (sev: PathSeverity | null) => `url(#${markerBase}-${sev ?? 'edge'})`

  // ── scorrimento sul nodo che conta ─────────────────────────────────────────
  const scrollTo = useCallback((id: string) => {
    nodeRefs.current.get(id)?.scrollIntoView({ block: 'nearest', inline: 'center' })
  }, [])

  /** All'apertura: la prima causa se c'è, altrimenti il servizio. Calcolata una volta sola: il polling non deve far saltare la vista. */
  const openOn = useRef(map.explanation[0]?.ci.id ?? map.service.id)
  const lastScrolled = useRef<string | null>(null)
  useEffect(() => {
    const target = selectedId ?? openOn.current
    if (lastScrolled.current === target) return
    lastScrolled.current = target
    scrollTo(target)
  }, [selectedId, scrollTo])

  // ── roving tabindex ────────────────────────────────────────────────────────
  const order = useMemo(() => layout.nodes.filter((p) => p.node !== null), [layout.nodes])
  const [focusedId, setFocusedId] = useState<string | null>(null)
  // Il nodo nel giro dei tab: quello scelto, altrimenti lo stesso su cui si è
  // aperta la mappa (la prima causa), altrimenti il primo della prima riga.
  const rovingId = [focusedId, openOn.current, order[0]?.id ?? null]
    .find((candidate) => candidate !== null && order.some((p) => p.id === candidate)) ?? null

  const moveFocus = (from: string, key: string) => {
    const rows = new Map<number, PlacedNode[]>()
    for (const p of order) rows.set(p.level, [...(rows.get(p.level) ?? []), p])
    const levels = [...rows.keys()].sort((a, b) => a - b)
    const current = order.find((p) => p.id === from)
    if (!current) return null
    const row = rows.get(current.level)!
    const i = row.findIndex((p) => p.id === from)
    const levelIdx = levels.indexOf(current.level)
    if (key === 'ArrowRight') return row[Math.min(i + 1, row.length - 1)]?.id ?? null
    if (key === 'ArrowLeft')  return row[Math.max(i - 1, 0)]?.id ?? null
    if (key === 'Home')       return row[0]?.id ?? null
    if (key === 'End')        return row[row.length - 1]?.id ?? null
    if (key === 'ArrowDown') {
      const next = rows.get(levels[levelIdx + 1] ?? Number.NaN)
      if (!next) return null
      return (next.find((p) => p.node?.via === from) ?? next[0])?.id ?? null
    }
    if (key === 'ArrowUp') {
      const via = current.node?.via ?? null
      if (via !== null && order.some((p) => p.id === via)) return via
      const prev = rows.get(levels[levelIdx - 1] ?? Number.NaN)
      return prev?.[0]?.id ?? null
    }
    return null
  }

  const onNodeKeyDown = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return
    const next = moveFocus(id, e.key)
    if (next === null || next === id) return
    e.preventDefault()
    setFocusedId(next)
    nodeRefs.current.get(next)?.focus()
    scrollTo(next)
  }

  // ── ricerca e zoom ─────────────────────────────────────────────────────────
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (q === '') return []
    return map.nodes.filter((n) => n.ci.name.toLowerCase().includes(q)).slice(0, SEARCH_MAX)
  }, [search, map.nodes])

  const pick = (ciId: string) => {
    setSearch('')
    setFocusedId(ciId)
    onSelect(ciId)
  }

  /** «Adatta»: la mappa intera nella larghezza disponibile, mai sotto 0,5 (illeggibile) né sopra 1. */
  const fit = () => {
    const available = scrollRef.current?.clientWidth ?? 0
    setScale(Math.min(SCALE_MAX, Math.max(SCALE_MIN, available / layout.width)))
  }

  const toggleFocus = () => {
    setExpanded(new Set<number>())
    setFocus((f) => !f)
  }

  // ── riassunto testuale (prima della mappa, per i lettori di schermo) ───────
  const downNodes = map.nodes.filter((n) => n.health === 'down').length
  const paths = map.explanation.map((c) => causeSequenceLabel(c, map.service.name))
  const summary = [
    t('monitoring.services.map.summary', { count: downNodes, total: map.nodes.length }),
    paths.length > 0 ? t('monitoring.services.map.summaryPath', { paths: paths.join('; ') }) : null,
  ].filter(Boolean).join(' ')

  // Percorso di un nodo fino al servizio, per `aria-describedby`.
  const nodeById = useMemo(() => new Map(map.nodes.map((n) => [n.ci.id, n])), [map.nodes])
  const pathOf = (id: string): string => {
    const names: string[] = []
    const seen = new Set<string>()
    let cur = nodeById.get(id)
    while (cur && !seen.has(cur.ci.id)) {
      seen.add(cur.ci.id)
      names.push(cur.ci.name)
      cur = cur.via === null ? undefined : nodeById.get(cur.via)
    }
    names.push(map.service.name)
    return names.join(' → ')
  }
  const descId = (id: string) => `${markerBase}-path-${encodeURIComponent(id)}`

  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) nodeRefs.current.set(id, el)
    else nodeRefs.current.delete(id)
  }

  return (
    <div>
      {map.nodes.length === 0 && (
        <p role="status" style={{ margin: '0 0 12px', fontSize: 'var(--font-size-body)', color: palette.warning.text }}>{t('monitoring.services.map.empty')}</p>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
          <Search size={13} aria-hidden="true" style={{ position: 'absolute', left: 8, color: colors.slateLight }} />
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('monitoring.services.map.searchLabel')}
            placeholder={t('monitoring.services.map.searchPlaceholder')}
            style={{ paddingLeft: 26, width: 200 }}
          />
        </span>
        {map.nodes.length > FOCUS_THRESHOLD && map.explanation.length > 0 && (
          <Button variant="secondary" size="xs" aria-pressed={focus} onClick={toggleFocus}>
            {focus ? t('monitoring.services.map.showAll') : t('monitoring.services.map.showPathOnly')}
          </Button>
        )}
        <Button variant="secondary" size="xs" icon={<Maximize2 size={13} aria-hidden="true" />} onClick={fit}>
          {t('monitoring.services.map.fit')}
        </Button>
        {scale !== 1 && (
          <Button variant="secondary" size="xs" icon={<X size={13} aria-hidden="true" />} onClick={() => setScale(1)}>
            {t('monitoring.services.map.actualSize')}
          </Button>
        )}
        {search.trim() !== '' && (
          <span role="status" data-testid="map-search-results" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 'var(--font-size-table)', color: colors.slate }}>
            {matches.length === 0
              ? t('monitoring.services.map.searchEmpty', { query: search.trim() })
              : matches.map((n) => (
                <button
                  key={n.ci.id}
                  type="button"
                  data-testid="map-search-hit"
                  onClick={() => pick(n.ci.id)}
                  style={{ font: 'inherit', cursor: 'pointer', padding: '2px 8px', borderRadius: 999, border: `1px solid ${colors.border}`, background: palette.neutral.surface1, color: colors.brand }}
                >
                  {n.ci.name}
                </button>
              ))}
          </span>
        )}
      </div>

      <p data-testid="map-summary" style={SR_ONLY}>{summary}</p>

      {/* La mappa scorre nel proprio contenitore, mai la pagina. */}
      <div
        ref={scrollRef}
        role="group"
        aria-label={t('monitoring.services.map.groupLabel', { name: map.service.name })}
        style={{ overflow: 'auto', maxHeight: 640, border: `1px solid ${colors.border}`, borderRadius: 10, background: palette.neutral.surface1 }}
      >
        <div
          data-testid="service-map"
          data-focus={focus ? 'true' : 'false'}
          data-scale={String(scale)}
          style={{ position: 'relative', width: layout.width * scale, height: layout.height * scale }}
        >
          {/* Strato zoomabile: solo archi e card; le etichette dei livelli restano fuori, ferme a sinistra. */}
          <div style={{ position: 'absolute', top: 0, left: 0, width: layout.width, height: layout.height, transform: `scale(${scale})`, transformOrigin: 'top left' }}>
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

            {layout.nodes.map((p) => p.node === null
              ? <RootCard key={p.id} placed={p} map={map} label={t('monitoring.services.map.levelService')} register={register(p.id)} />
              : (
                <NodeCard
                  key={p.id}
                  placed={p}
                  selected={p.id === selectedId}
                  typeLabel={typeLabel(p.node.ci.type)}
                  icon={getCIType(p.node.ci.type)}
                  tabIndex={p.id === rovingId ? 0 : -1}
                  describedBy={p.onPath ? descId(p.id) : undefined}
                  register={register(p.id)}
                  onSelect={onSelect}
                  onFocus={() => setFocusedId(p.id)}
                  onKeyDown={(e) => onNodeKeyDown(e, p.id)}
                />
              ))}

            {layout.collapsed.map((c) => (
              <button
                key={`chip-${c.level}`}
                type="button"
                data-testid="map-collapsed-chip"
                data-level={c.level}
                data-count={c.count}
                onClick={() => setExpanded((prev) => new Set([...prev, c.level]))}
                style={{
                  position: 'absolute', left: c.x, top: c.y, width: CHIP_W, height: CHIP_H, boxSizing: 'border-box',
                  font: 'inherit', fontSize: 'var(--font-size-table)', cursor: 'pointer', padding: '0 10px',
                  borderRadius: 999, border: `1px dashed ${colors.slateLight}`, background: palette.neutral.surface2, color: colors.slate,
                }}
              >
                {t('monitoring.services.map.collapsed', { count: c.count })}
              </button>
            ))}

            {/* Descrizioni del percorso: lette da `aria-describedby`, mai mostrate. */}
            {layout.nodes.filter((p) => p.onPath !== null && p.node !== null).map((p) => (
              <span key={`desc-${p.id}`} id={descId(p.id)} style={SR_ONLY}>
                {t('monitoring.services.map.onPath', { severity: serviceHealthLabel(t, p.onPath!), path: pathOf(p.id) })}
              </span>
            ))}
          </div>

          {/* Colonna delle etichette: ferma a sinistra mentre la mappa scorre (altezza 0, non occupa spazio). */}
          <div aria-hidden="true" style={{ position: 'sticky', left: 0, top: 0, width: LABEL_W * scale, height: 0, zIndex: 2 }}>
            {layout.levels.map((level, i) => (
              <div
                key={level}
                data-testid="map-level-label"
                style={{
                  position: 'absolute', left: PAD * scale, top: (PAD + i * (NODE_H + GAP_Y) + NODE_H / 2 - 8) * scale,
                  width: (LABEL_W - 8) * scale, fontSize: 'var(--font-size-label)', fontWeight: 600, letterSpacing: '0.05em',
                  textTransform: 'uppercase', color: colors.slateLight, lineHeight: 1.2, background: palette.neutral.surface1,
                }}
              >
                {levelLabel(level)}
              </div>
            ))}
          </div>
        </div>
      </div>
      <Legend />
    </div>
  )
}

function RootCard({ placed: p, map, label, register }: { placed: PlacedNode; map: ServiceMapDetail; label: string; register: (el: HTMLElement | null) => void }) {
  const { t } = useTranslation()
  const fam = serviceHealthFamily(map.health)
  const border = p.onPath ? PATH_COLOR[p.onPath] : fam.border
  return (
    <div
      ref={register}
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
  placed:      PlacedNode
  selected:    boolean
  typeLabel:   string
  icon:        { icon: string; color: string } | undefined
  tabIndex:    number
  describedBy: string | undefined
  register:    (el: HTMLElement | null) => void
  onSelect:    (id: string | null) => void
  onFocus:     () => void
  onKeyDown:   (e: KeyboardEvent<HTMLButtonElement>) => void
}

function NodeCard({ placed: p, selected, typeLabel, icon, tabIndex, describedBy, register, onSelect, onFocus, onKeyDown }: NodeCardProps) {
  const { t } = useTranslation()
  const node = p.node!
  const fam = nodeHealthFamily(node.health, node.inMaintenance)
  const border = p.onPath ? PATH_COLOR[p.onPath] : fam.border
  const healthText = node.inMaintenance ? t('monitoring.services.health.maintenance') : ciHealthLabel(t, node.health)
  return (
    <button
      ref={register}
      type="button"
      data-testid="service-map-node"
      data-ci-id={node.ci.id}
      data-level={node.level}
      data-health={node.health ?? 'unknown'}
      data-on-path={p.onPath ?? undefined}
      data-cause={p.isCause ? 'true' : undefined}
      tabIndex={tabIndex}
      aria-pressed={selected}
      aria-label={t('monitoring.services.map.nodeLabel', { name: node.ci.name, type: typeLabel, health: healthText })}
      aria-describedby={describedBy}
      onClick={() => onSelect(selected ? null : node.ci.id)}
      onFocus={onFocus}
      onKeyDown={onKeyDown}
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

/** Legenda: una lista vera (`<ul>`/`<li>`), così il nome del gruppo arriva anche ai lettori di schermo. */
function Legend() {
  const { t } = useTranslation()
  const swatch = (bg: string, border: string) => <span aria-hidden="true" style={{ width: 14, height: 14, borderRadius: 4, background: bg, border: `2px solid ${border}`, boxSizing: 'border-box', flexShrink: 0 }} />
  const line = (color: string, thick: boolean, dashed = false) => (
    <svg aria-hidden="true" width="26" height="8" style={{ flexShrink: 0 }}>
      <line x1="0" y1="4" x2="26" y2="4" stroke={color} strokeWidth={thick ? 3.5 : 1.5} strokeDasharray={dashed ? '4 3' : undefined} />
    </svg>
  )
  const item = (key: string, sample: React.ReactNode, label: string) => (
    <li key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-table)', color: colors.slate }}>{sample}{label}</li>
  )
  return (
    <ul aria-label={t('monitoring.services.map.legend.title')} style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', margin: '10px 0 0', padding: 0, listStyle: 'none' }}>
      {(['down', 'degraded', 'operational', 'maintenance', 'unknown'] as const).map((h) => item(h, swatch(SERVICE_HEALTH_FAMILY[h].bg, SERVICE_HEALTH_FAMILY[h].border), t(`monitoring.services.health.${h}`)))}
      {item('star', <Star size={12} aria-hidden="true" color={palette.orange.base} fill={palette.orange.base} />, t('monitoring.services.map.legend.critical'))}
      {item('path-down', line(PATH_COLOR.down, true), t('monitoring.services.map.legend.pathDown'))}
      {item('path-degraded', line(PATH_COLOR.degraded, true), t('monitoring.services.map.legend.pathDegraded'))}
      {item('edge', line(EDGE_COLOR, false), t('monitoring.services.map.legend.edge'))}
      {item('edge-missing', line(PATH_COLOR.down, true, true), t('monitoring.services.map.legend.edgeMissing'))}
    </ul>
  )
}
