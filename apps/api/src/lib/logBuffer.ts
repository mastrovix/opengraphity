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

/** Return entries newest-first. */
export function getLogs(): LogEntry[] {
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
