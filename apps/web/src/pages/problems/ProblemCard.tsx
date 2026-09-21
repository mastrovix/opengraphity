// ── Shared sub-components and utilities for ProblemDetailPage ─────────────────

// ── Utilities ─────────────────────────────────────────────────────────────────
// Date: unica implementazione in lib/datetime.
export { formatDateTime as formatDate, timeAgo } from '@/lib/datetime'

// ── Constants ─────────────────────────────────────────────────────────────────


/*
 * Ondata 7 · D-15: qui c'erano `STATUS_BG` e `STATUS_FG`, gli otto passi del
 * workflow problem di fabbrica elencati **tutti con lo stesso colore** — una
 * lista che non portava informazione ma che, letta con `lookupOrError`,
 * mandava in errore qualunque passo aggiunto o rinominato nel disegnatore.
 * Adesso lo stile viene dalla CATEGORIA del passo (`lib/workflowStepStyle`),
 * che è già il modo in cui il resto del web colora i passi: un passo nuovo
 * prende il colore della sua categoria, e una categoria sconosciuta il neutro.
 */
