/**
 * Circular in-memory log buffer.
 * Pino pushes entries here; the `logs` GraphQL resolver reads from it.
 */

export interface LogEntry {
  id:        string
  timestamp: string
  level:     string
  module:    string
  message:   string
  data:      string | null
  /**
   * Di chi è la riga (20 set 2026). `null` = riga di PIATTAFORMA (avvio,
   * code, bus del metamodello): non appartiene a nessun cliente e non si
   * mostra nella pagina Log di nessuno.
   */
  tenantId:  string | null
}

const MAX_SIZE = 2000
const buffer: LogEntry[] = []
let seq = 0

export function pushLog(entry: LogEntry): void {
  if (buffer.length >= MAX_SIZE) {
    buffer[seq % MAX_SIZE] = entry
  } else {
    buffer.push(entry)
  }
  seq++
}

/**
 * Le righe di UN cliente, dalla più recente.
 *
 * Prima tornava il buffer intero: un amministratore vedeva le righe di ogni
 * altro cliente servito dallo stesso processo, e fra quelle ci sono nomi di
 * CI e numeri di ticket. Le righe di piattaforma (`tenantId: null`) non sono
 * di nessun cliente e restano fuori: si leggono da «Monitoraggio della
 * piattaforma».
 */
export function getLogs(tenantId: string): LogEntry[] {
  return tutteLeRighe().filter((e) => e.tenantId === tenantId)
}

/** Il buffer intero, dalla più recente: per la piattaforma e per i test. */
export function tutteLeRighe(): LogEntry[] {
  // Reconstruct ordered array from the circular buffer
  if (buffer.length < MAX_SIZE) {
    // Buffer hasn't wrapped yet — entries are in insertion order
    return [...buffer].reverse()
  }
  // Buffer has wrapped: head is at `seq % MAX_SIZE`
  const head = seq % MAX_SIZE
  const ordered: LogEntry[] = []
  // From newest (head-1, wrapping) backwards
  for (let i = 0; i < MAX_SIZE; i++) {
    const idx = (head - 1 - i + MAX_SIZE) % MAX_SIZE
    ordered.push(buffer[idx]!)
  }
  return ordered
}
