/**
 * Registro UNICO delle icone dei tipi CI (path lucide v0.577, viewBox 24×24).
 *
 * Prima esistevano quattro registri paralleli (ICON_NODES in TopologyGraph,
 * MINI_ICONS in MiniPathGraph, iconMap React in ciIcon.tsx, TYPE_ICON emoji in
 * CIGraph): aggiungere un'icona voleva dire quattro modifiche e CIGraph
 * ignorava del tutto `ciType.icon` del metamodello. Ora la chiave icona viene
 * SEMPRE dal metamodello (`ciType.icon`) e i tre grafi D3 + il componente React
 * leggono da qui.
 *
 * Fail-visible: una chiave sconosciuta non diventa un "box" qualunque né un
 * emoji ❌ silenzioso — viene disegnato un "?" rosso e loggato l'errore.
 */
import { lookupOrError } from '@/lib/tokens'

export type IconNode = [tag: string, attrs: Record<string, string>]

export const CI_ICON_PATHS: Record<string, IconNode[]> = {
  box: [
    ['path', { d: 'M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z' }],
    ['path', { d: 'm3.3 7 8.7 5 8.7-5' }],
    ['path', { d: 'M12 22V12' }],
  ],
  boxes: [
    ['path', { d: 'M2.97 12.92A2 2 0 0 0 2 14.63v3.24a2 2 0 0 0 .97 1.71l3 1.8a2 2 0 0 0 2.06 0L12 19v-5.5l-5-3-4.03 2.42Z' }],
    ['path', { d: 'm7 16.5-4.74-2.85' }],
    ['path', { d: 'm7 16.5 5-3' }],
    ['path', { d: 'M7 16.5v5.17' }],
    ['path', { d: 'M12 13.5V19l3.97 2.38a2 2 0 0 0 2.06 0l3-1.8a2 2 0 0 0 .97-1.71v-3.24a2 2 0 0 0-.97-1.71L17 10.5l-5 3Z' }],
    ['path', { d: 'm17 16.5-5-3' }],
    ['path', { d: 'm17 16.5 4.74-2.85' }],
    ['path', { d: 'M17 16.5v5.17' }],
    ['path', { d: 'M7.97 4.42A2 2 0 0 0 7 6.13v4.37l5 3 5-3V6.13a2 2 0 0 0-.97-1.71l-3-1.8a2 2 0 0 0-2.06 0l-3 1.8Z' }],
    ['path', { d: 'M12 8 7.26 5.15' }],
    ['path', { d: 'm12 8 4.74-2.85' }],
    ['path', { d: 'M12 13.5V8' }],
  ],
  database: [
    ['ellipse', { cx: '12', cy: '5', rx: '9', ry: '3' }],
    ['path', { d: 'M3 5V19A9 3 0 0 0 21 19V5' }],
    ['path', { d: 'M3 12A9 3 0 0 0 21 12' }],
  ],
  server: [
    ['rect', { width: '20', height: '8', x: '2', y: '2', rx: '2', ry: '2' }],
    ['rect', { width: '20', height: '8', x: '2', y: '14', rx: '2', ry: '2' }],
    ['line', { x1: '6', x2: '6.01', y1: '6', y2: '6' }],
    ['line', { x1: '6', x2: '6.01', y1: '18', y2: '18' }],
  ],
  shield: [
    ['path', { d: 'M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z' }],
  ],
  'hard-drive': [
    ['path', { d: 'M10 16h.01' }],
    ['path', { d: 'M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z' }],
    ['path', { d: 'M21.946 12.013H2.054' }],
    ['path', { d: 'M6 16h.01' }],
  ],
  cloud: [
    ['path', { d: 'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z' }],
  ],
  globe: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['path', { d: 'M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20' }],
    ['path', { d: 'M2 12h20' }],
  ],
  cpu: [
    ['path', { d: 'M12 20v2' }], ['path', { d: 'M12 2v2' }],
    ['path', { d: 'M17 20v2' }], ['path', { d: 'M17 2v2' }],
    ['path', { d: 'M2 12h2' }],  ['path', { d: 'M2 17h2' }], ['path', { d: 'M2 7h2' }],
    ['path', { d: 'M20 12h2' }], ['path', { d: 'M20 17h2' }], ['path', { d: 'M20 7h2' }],
    ['path', { d: 'M7 20v2' }],  ['path', { d: 'M7 2v2' }],
    ['rect', { x: '4', y: '4', width: '16', height: '16', rx: '2' }],
    ['rect', { x: '8', y: '8', width: '8', height: '8', rx: '1' }],
  ],
  network: [
    ['rect', { x: '16', y: '16', width: '6', height: '6', rx: '1' }],
    ['rect', { x: '2', y: '16', width: '6', height: '6', rx: '1' }],
    ['rect', { x: '9', y: '2', width: '6', height: '6', rx: '1' }],
    ['path', { d: 'M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3' }],
    ['path', { d: 'M12 12V8' }],
  ],
  monitor: [
    ['rect', { width: '20', height: '14', x: '2', y: '3', rx: '2' }],
    ['line', { x1: '8', x2: '16', y1: '21', y2: '21' }],
    ['line', { x1: '12', x2: '12', y1: '17', y2: '21' }],
  ],
  lock: [
    ['rect', { width: '18', height: '11', x: '3', y: '11', rx: '2', ry: '2' }],
    ['path', { d: 'M7 11V7a5 5 0 0 1 10 0v4' }],
  ],
  target: [
    ['circle', { cx: '12', cy: '12', r: '10' }],
    ['circle', { cx: '12', cy: '12', r: '6' }],
    ['circle', { cx: '12', cy: '12', r: '2' }],
  ],
  briefcase: [
    ['path', { d: 'M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16' }],
    ['rect', { width: '20', height: '14', x: '2', y: '6', rx: '2' }],
  ],
}

/** Chiave riservata: "?" rosso, usata quando l'icona richiesta non esiste. */
export const BROKEN_ICON_KEY = '__broken__'

/** lucide `circle-help`: cerchio + punto interrogativo. */
export const BROKEN_ICON_PATHS: IconNode[] = [
  ['circle', { cx: '12', cy: '12', r: '10' }],
  ['path', { d: 'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3' }],
  ['path', { d: 'M12 17h.01' }],
]

/** Colore con cui viene disegnata l'icona rotta, qualunque colore chieda il chiamante. */
export const BROKEN_ICON_COLOR = 'var(--color-danger)'

export function isBrokenIconKey(key: string): boolean {
  return key === BROKEN_ICON_KEY
}

/**
 * Path per una chiave icona. Chiave sconosciuta → console.error + "?" rosso
 * (lookupOrError), mai un'icona plausibile al posto di quella mancante.
 */
export function iconPathsOrError(iconKey: string): IconNode[] {
  if (isBrokenIconKey(iconKey)) return BROKEN_ICON_PATHS
  return lookupOrError(CI_ICON_PATHS, iconKey, 'CI_ICON_PATHS', BROKEN_ICON_PATHS)
}

/** "DatabaseInstance" / "database_instance" / "Database Instance" → "databaseinstance" */
export function normalizeTypeName(s: string): string {
  return s.toLowerCase().replace(/[_\s]/g, '')
}

/**
 * Mappa tipo CI (normalizzato) → chiave icona, a partire dai tipi del
 * metamodello. Un tipo senza `icon` NON eredita "box": resta assente e il
 * lookup successivo lo segnala.
 */
export function buildTypeIconMap(ciTypes: ReadonlyArray<{ name: string; icon?: string | null }>): Map<string, string> {
  const m = new Map<string, string>()
  for (const ct of ciTypes) {
    if (ct.icon) m.set(normalizeTypeName(ct.name), ct.icon)
  }
  return m
}

/**
 * Chiave icona per un tipo CI. Tipo assente dalla mappa → console.error e
 * BROKEN_ICON_KEY (visibile in rosso), non "box".
 */
export function iconKeyForType(typeIconMap: ReadonlyMap<string, string>, ciType: string): string {
  const key = typeIconMap.get(normalizeTypeName(ciType))
  if (key === undefined) {
    console.error(`[CI_ICON] tipo CI senza icona nel metamodello: "${ciType}"`)
    return BROKEN_ICON_KEY
  }
  return key
}
