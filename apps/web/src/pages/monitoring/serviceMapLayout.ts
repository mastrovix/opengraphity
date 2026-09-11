/**
 * Layout a livelli della mappa del servizio (funzione pura, senza React):
 * il servizio in cima (livello 0), poi una riga per livello (1, 2, …) con i
 * nodi affiancati; x = indice nella riga, y = riga. Le righe sono compattate
 * (un livello senza nodi non lascia un buco) ma etichettate col livello vero.
 *
 * Le righe sono ALLINEATE A SINISTRA (revisione 2 · C-9): prima ogni riga era
 * centrata sulla più larga, così con otto componenti su un livello il servizio
 * finiva a ~800 px e la pagina si apriva su una tela vuota. Ora il servizio è
 * sempre in alto a sinistra, al primo schermo, qualunque sia la larghezza
 * della riga più lunga.
 *
 * Ordine nella riga: per posizione del predecessore (`via`) nella riga sopra,
 * poi per nome — riduce gli incroci senza un algoritmo di ordinamento pesante
 * (la mappa è congelata e al più 500 nodi).
 *
 * Modalità «solo percorso d'impatto» (`options.focus`, C-9): sopra
 * FOCUS_THRESHOLD nodi la riga diventa un nastro illeggibile. In questa
 * modalità ogni riga tiene i nodi del percorso d'impatto (le cause e i loro
 * antenati), i loro fratelli diretti (stesso `via`) fino a FOCUS_ROW_MAX e i
 * nodi che il chiamante chiede di tenere (`options.keep`: il selezionato non
 * deve sparire sotto le mani); gli altri finiscono in `collapsed`, un chip per
 * livello che il chiamante espande (`options.expanded`).
 *
 * Percorso d'impatto: i nodi e i segmenti delle `causes[].path` (dal nodo
 * malato risalendo `via` fino al livello 1, più il tratto livello 1 →
 * servizio) sono marcati con la severità peggiore che li attraversa
 * (giù > degradato). Un segmento del percorso senza un arco vivo
 * corrispondente (mappa non più allineata alla CMDB) viene comunque disegnato,
 * marcato `live: false`: il percorso è il dato della valutazione, non va
 * taciuto perché la topologia è cambiata.
 */
import type { CIHealth } from '@/types/events'
import type { ImpactCause, ServiceMapEdge, ServiceMapNode } from '@/types/services'

export const NODE_W  = 176
export const NODE_H  = 66
export const GAP_X   = 22
export const GAP_Y   = 70
export const PAD     = 16
/** Colonna a sinistra con l'etichetta della riga («Livello 2»). */
export const LABEL_W = 88
/** Chip «+N componenti fuori dal percorso» in coda alla riga (modalità percorso). */
export const CHIP_W  = 190
export const CHIP_H  = 30

/** Sopra questi nodi la mappa si apre sul solo percorso d'impatto (C-9). */
export const FOCUS_THRESHOLD = 40
/** Quanti nodi al più in una riga in modalità percorso (i nodi del percorso ci stanno sempre). */
export const FOCUS_ROW_MAX   = 12

/** Severità del percorso d'impatto che passa da un nodo o da un arco. */
export type PathSeverity = 'down' | 'degraded'

export interface PlacedNode {
  id:      string
  level:   number
  x:       number
  y:       number
  /** null per la radice (il servizio). */
  node:    ServiceMapNode | null
  onPath:  PathSeverity | null
  /** È una delle cause (nodo malato che ha pesato). */
  isCause: boolean
}

export interface PlacedEdge {
  key:       string
  source:    string
  target:    string
  relType:   string
  x1:        number
  y1:        number
  x2:        number
  y2:        number
  /** Percorso SVG (cubica verticale). */
  d:         string
  highlight: PathSeverity | null
  /** false = segmento del percorso d'impatto senza arco vivo. */
  live:      boolean
}

/** I nodi di un livello lasciati fuori dalla modalità percorso: un chip in coda alla riga. */
export interface CollapsedRow {
  level: number
  /** Quanti nodi sono nascosti su questo livello. */
  count: number
  x:     number
  y:     number
  /** Gli id nascosti: servono al chiamante per dire se il nodo cercato è dentro un chip. */
  ids:   string[]
}

export interface ServiceMapLayout {
  width:  number
  height: number
  /** Livelli presenti, in ordine (0 compreso). */
  levels: number[]
  nodes:  PlacedNode[]
  edges:  PlacedEdge[]
  /** Chip dei nodi nascosti, uno per livello (vuoto se non c'è nulla di nascosto). */
  collapsed: CollapsedRow[]
}

export interface LayoutOptions {
  /** Solo il percorso d'impatto: il resto della riga va nel chip. */
  focus?:    boolean
  /** Livelli che l'utente ha espanso dal chip: mostrati per intero anche in modalità percorso. */
  expanded?: ReadonlySet<number>
  /** Nodi da tenere visibili comunque (il selezionato, il nodo appena cercato). */
  keep?:     ReadonlySet<string>
}

const NO_NUMBERS = new Set<number>()
const NO_IDS     = new Set<string>()

/** Relazione sintetica fra il servizio e le applicazioni di livello 1. */
export const ROOT_REL = 'REALIZES'

const worse = (a: PathSeverity | null, b: PathSeverity): PathSeverity => (a === 'down' || b === 'down' ? 'down' : 'degraded')

/** Chiave non orientata di una coppia di nodi: un arco vivo può andare in una direzione o nell'altra rispetto al percorso. */
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

/** Severità della causa sul percorso: solo giù/degradato pesano; un'altra salute (fuori vocabolario) è trattata come degradato, mai ignorata. */
function causeSeverity(health: CIHealth): PathSeverity {
  return health === 'down' ? 'down' : 'degraded'
}

/**
 * Sequenza di id del percorso di una causa: dal nodo malato (incluso una volta
 * sola, che il server lo metta o no in `path`) fino al livello 1.
 */
export function causeSequence(cause: ImpactCause): string[] {
  const seq = [cause.ci.id]
  for (const p of cause.path) if (p.id !== seq[seq.length - 1]) seq.push(p.id)
  return seq
}

export function layoutServiceMap(
  rootId: string,
  nodes: ServiceMapNode[],
  edges: ServiceMapEdge[],
  causes: ImpactCause[],
  options: LayoutOptions = {},
): ServiceMapLayout {
  // ── percorso d'impatto ────────────────────────────────────────────────────
  const nodeSeverity = new Map<string, PathSeverity>()
  const segSeverity  = new Map<string, PathSeverity>()
  const causeIds     = new Set<string>()
  const byId         = new Map(nodes.map((n) => [n.ci.id, n]))
  for (const c of causes) {
    const sev = causeSeverity(c.health)
    causeIds.add(c.ci.id)
    const seq = causeSequence(c)
    for (const id of seq) nodeSeverity.set(id, worse(nodeSeverity.get(id) ?? null, sev))
    for (let i = 0; i + 1 < seq.length; i++) {
      const k = pairKey(seq[i]!, seq[i + 1]!)
      segSeverity.set(k, worse(segSeverity.get(k) ?? null, sev))
    }
    // Una causa impatta il servizio per definizione: il servizio è sempre sul
    // percorso. Il TRATTO fino al servizio si disegna solo se il capo del
    // percorso è a livello 1 (sotto, non c'è nessuna adiacenza da disegnare:
    // il percorso arriva dov'è arrivato, non si inventa un arco).
    const head = seq[seq.length - 1]!
    nodeSeverity.set(rootId, worse(nodeSeverity.get(rootId) ?? null, sev))
    if (byId.get(head)?.level === 1) {
      const k = pairKey(rootId, head)
      segSeverity.set(k, worse(segSeverity.get(k) ?? null, sev))
    }
  }

  // ── righe ────────────────────────────────────────────────────────────────
  const levelSet = new Set<number>([0])
  for (const n of nodes) levelSet.add(n.level)
  const levels = [...levelSet].sort((a, b) => a - b)
  const rowIndex = new Map(levels.map((l, i) => [l, i]))

  const rows: ServiceMapNode[][] = levels.map(() => [])
  for (const n of nodes) rows[rowIndex.get(n.level)!]!.push(n)

  const orderIndex = new Map<string, number>([[rootId, 0]])
  for (const row of rows) {
    row.sort((a, b) => {
      const pa = a.via !== null ? (orderIndex.get(a.via) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
      const pb = b.via !== null ? (orderIndex.get(b.via) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER
      return pa - pb || a.ci.name.localeCompare(b.ci.name)
    })
    row.forEach((n, i) => orderIndex.set(n.ci.id, i))
  }

  // ── modalità «solo percorso d'impatto» ───────────────────────────────────
  const focus    = options.focus === true
  const expanded = options.expanded ?? NO_NUMBERS
  const keepIds  = options.keep ?? NO_IDS
  const shown:  ServiceMapNode[][] = []
  const hidden: ServiceMapNode[][] = []
  rows.forEach((row, i) => {
    const level = levels[i]!
    if (!focus || level === 0 || expanded.has(level) || row.length === 0) { shown.push(row); hidden.push([]); return }
    // Fratelli diretti = stesso predecessore di un nodo del percorso.
    const pathVias = new Set(row.filter((n) => nodeSeverity.has(n.ci.id)).map((n) => n.via))
    const keep: ServiceMapNode[] = []
    const rest: ServiceMapNode[] = []
    for (const n of row) {
      const onPath  = nodeSeverity.has(n.ci.id) || keepIds.has(n.ci.id)
      const sibling = n.via !== null && pathVias.has(n.via)
      if (onPath || (sibling && keep.length < FOCUS_ROW_MAX)) keep.push(n)
      else rest.push(n)
    }
    shown.push(keep); hidden.push(rest)
  })

  /** Larghezza di una riga: i nodi affiancati più, se c'è, il chip dei nascosti. */
  const rowWidth = (count: number, chip: boolean) => {
    const nodesW = count === 0 ? 0 : count * NODE_W + (count - 1) * GAP_X
    const chipW  = chip ? (count === 0 ? CHIP_W : GAP_X + CHIP_W) : 0
    return Math.max(NODE_W, nodesW + chipW)
  }
  const maxRow = Math.max(rowWidth(1, false), ...shown.map((r, i) => rowWidth(r.length, hidden[i]!.length > 0)))
  const width  = PAD * 2 + LABEL_W + maxRow
  const height = PAD * 2 + levels.length * NODE_H + (levels.length - 1) * GAP_Y

  /** x del posto `index` di una riga: righe allineate a sinistra, il servizio è sempre in alto a sinistra (C-9). */
  const slotX = (index: number) => PAD + LABEL_W + index * (NODE_W + GAP_X)
  const rowY  = (level: number) => PAD + rowIndex.get(level)! * (NODE_H + GAP_Y)

  const placed: PlacedNode[] = []
  const pos = new Map<string, { x: number; y: number }>()
  const place = (id: string, level: number, index: number, node: ServiceMapNode | null) => {
    const x = slotX(index)
    const y = rowY(level)
    pos.set(id, { x, y })
    placed.push({ id, level, x, y, node, onPath: nodeSeverity.get(id) ?? null, isCause: causeIds.has(id) })
  }
  place(rootId, 0, 0, null)
  shown.forEach((row) => row.forEach((n, i) => place(n.ci.id, n.level, i, n)))

  const collapsed: CollapsedRow[] = []
  hidden.forEach((row, i) => {
    if (row.length === 0) return
    const level = levels[i]!
    collapsed.push({
      level,
      count: row.length,
      x:     slotX(shown[i]!.length),
      y:     rowY(level) + (NODE_H - CHIP_H) / 2,
      ids:   row.map((n) => n.ci.id),
    })
  })

  // ── archi ────────────────────────────────────────────────────────────────
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const ax = a.x + NODE_W / 2, bx = b.x + NODE_W / 2
    let x1: number, y1: number, x2: number, y2: number
    if (b.y > a.y)      { x1 = ax; y1 = a.y + NODE_H; x2 = bx; y2 = b.y }              // verso il basso (fornitore)
    else if (b.y < a.y) { x1 = ax; y1 = a.y;          x2 = bx; y2 = b.y + NODE_H }     // verso l'alto
    else                { x1 = a.x + NODE_W; y1 = a.y + NODE_H / 2; x2 = b.x; y2 = b.y + NODE_H / 2 } // stessa riga
    const dy = (y2 - y1) / 2
    const d = y1 === y2
      ? `M ${x1} ${y1} L ${x2} ${y2}`
      : `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`
    return { x1, y1, x2, y2, d }
  }

  const out: PlacedEdge[] = []
  const seenPairs = new Set<string>()
  const push = (source: string, target: string, relType: string, live: boolean) => {
    const a = pos.get(source), b = pos.get(target)
    if (!a || !b) return
    const k = pairKey(source, target)
    seenPairs.add(k)
    out.push({ key: `${source}→${target}:${relType}`, source, target, relType, ...curve(a, b), highlight: segSeverity.get(k) ?? null, live })
  }
  // livello 1 ← servizio
  for (const n of rows[rowIndex.get(1) ?? -1] ?? []) if (n.level === 1) push(rootId, n.ci.id, ROOT_REL, true)
  // archi vivi fra i nodi inclusi (un arco verso un nodo non incluso è scartato: non è sulla mappa)
  for (const e of edges) push(e.source, e.target, e.relType, true)
  // segmenti del percorso senza arco vivo: disegnati lo stesso, marcati non vivi
  for (const c of causes) {
    const seq = causeSequence(c)
    for (let i = 0; i + 1 < seq.length; i++) {
      const k = pairKey(seq[i]!, seq[i + 1]!)
      if (!seenPairs.has(k)) push(seq[i + 1]!, seq[i]!, 'via', false)
    }
  }

  return { width, height, levels, nodes: placed, edges: out, collapsed }
}
