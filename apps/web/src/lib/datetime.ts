/**
 * Formattazione date/durate — unica sorgente.
 *
 * Prima esistevano sette copie (IncidentCard, ProblemCard, le due Timeline,
 * changes/shared, AuditTimeline, ServiceRequestDetailPage) con soglie e stringhe
 * diverse: lo stesso timestamp diventava "adesso" in una pagina e "ora" in
 * un'altra. Le funzioni qui sotto sono quelle usate dalle pagine ITSM; i nomi
 * storici (fmtDate/formatDate) restano come alias per non toccare
 * ogni call site in un colpo solo.
 *
 * Lingua: le date seguono la lingua attiva di i18next (`resolvedLanguage`,
 * fallback `en`), le etichette relative ("adesso", "5 min fa") le chiavi
 * `time.*`. Modulo puro (niente React): usa `i18n.t` direttamente.
 *
 * PERCHE' PASSARE SEMPRE DA QUI. `new Date(x).toLocaleDateString()` senza
 * locale usa quello del BROWSER: su una macchina italiana l'interfaccia in
 * inglese mostrava «13/09/2026» invece di «13/09/2026» in formato inglese —
 * la stessa colonna, due formati, a seconda del computer di chi guarda. E' lo
 * stesso difetto per cui `navigator` e' stato togliere dal rilevamento della
 * lingua: il browser non decide la lingua di questo prodotto. Il guardiano
 * `check-i18n` ora rifiuta un `toLocale*String()` senza locale.
 */
import i18n from '@/i18n/i18n'

const DATETIME: Intl.DateTimeFormatOptions = {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}

/** Locale BCP-47 per Intl, coerente con la lingua scelta dall'utente. */
export function currentLocale(): string {
  const lng = i18n.resolvedLanguage ?? i18n.language
  if (!lng) return 'en'
  return lng === 'it' ? 'it-IT' : lng === 'en' ? 'en-GB' : lng
}

/** "08 set 2026, 14:05" (lingua attiva). '—' se assente. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(currentLocale(), DATETIME)
}

const DATE: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' }

/**
 * "08 set 2026" (lingua attiva). '—' se assente. Lo stesso giorno-mese-anno di
 * `formatDateTime`: giro nel browser del 14 set 2026 (#27), il dettaglio del CI
 * diceva «14/09/2026» accanto a «14 Sept 2026, 10:05».
 */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(currentLocale(), DATE)
}

/**
 * Solo ora, lingua attiva. '—' se assente.
 *
 * Esiste per la stessa ragione delle altre: `toLocaleTimeString()` SENZA
 * locale prende quello del browser, e il browser non decide la lingua di
 * questo prodotto.
 */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(currentLocale())
}

const ORA_MINUTO: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' }

/**
 * Solo ore e minuti: «06:57», non «06:57:00».
 *
 * `formatTime` lascia decidere al locale, e in italiano il locale mette anche i
 * SECONDI. Su una finestra di rilascio sono rumore — si scrivono col controllo
 * `datetime-local`, quindi sono sempre `:00` — e in una casella di calendario
 * rubano lo spazio al codice della change (17 set 2026). Il locale resta
 * esplicito: il browser non decide la lingua di questo prodotto.
 */
export function formatHourMinute(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString(currentLocale(), ORA_MINUTO)
}

/** "adesso", "5 min fa", "3 ore fa", "2 giorni fa", poi la data completa. */
export function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const sec  = Math.floor(diff / 1000)
  if (sec < 60)  return i18n.t('time.justNow')
  const min = Math.floor(sec / 60)
  if (min < 60)  return i18n.t('time.minutesAgo', { count: min })
  const hrs = Math.floor(min / 60)
  if (hrs < 24)  return i18n.t('time.hoursAgo', { count: hrs })
  const days = Math.floor(hrs / 24)
  if (days < 7)  return i18n.t('time.daysAgo', { count: days })
  return formatDateTime(iso)
}

/** "< 1 min", "12 min", "3 ore", "2 giorni". */
export function formatDuration(ms: number): string {
  if (ms < 60_000)     return i18n.t('time.lessThanMinute')
  if (ms < 3_600_000)  return i18n.t('time.minutes', { count: Math.floor(ms / 60_000) })
  if (ms < 86_400_000) return i18n.t('time.hours',   { count: Math.floor(ms / 3_600_000) })
  return i18n.t('time.days', { count: Math.floor(ms / 86_400_000) })
}

// Alias storici (call site delle change).
export const fmtDate  = formatDate
