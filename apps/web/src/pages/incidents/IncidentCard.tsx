// Utility storiche della pagina incident: ora vivono in lib/datetime (unica
// implementazione condivisa). Card/DetailRow non erano più usati e sono stati
// rimossi.
export { formatDateTime as formatDate, timeAgo } from '@/lib/datetime'
