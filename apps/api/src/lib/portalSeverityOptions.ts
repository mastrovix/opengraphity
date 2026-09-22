/**
 * LE SEVERITÀ CHE L'UTENTE FINALE SCEGLIE NEL PORTALE — dato del cliente
 * (verifica «Cosa resta cablato», ondata 1).
 *
 * Il portale offriva `low / medium / high` scritti nel codice e li scriveva
 * nella severità dell'incident: una severità aggiunta dal cliente non si
 * poteva scegliere, e una rinominata veniva mandata comunque (rifiutata dal
 * servizio). Ora l'amministratore sceglie QUALI valori del vocabolario
 * `severity` mostrare e con che parole per chi apre un ticket («Mi blocca il
 * lavoro» invece di «critical»).
 *
 * Il dato: `Tenant.portal_severity_options`, una lista ordinata
 * `[{value, labels: {en?, it?}}]`. L'etichetta di una lingua non scritta è
 * quella del Dizionario per quel valore (regola dichiarata nella pagina).
 *
 * Non dichiarato (proprietà assente) NON è «lista vuota»: il portale non può
 * aprire un ticket e lo dice, invece di indovinare dei valori.
 */
import { getSession, runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import type { ValueColor } from '@opengraphity/types'
import { NotFoundError, ValidationError } from './errors.js'
import { domainVocabulary } from './domainMatrix.js'
import { LINGUE, labelFor, type Lingua } from './enumValueLabels.js'
import { loadVocabularyEntries } from './vocabularyEntries.js'
import { languageFor } from './tenantLanguage.js'

export const PORTAL_SEVERITY_VOCABULARY = 'severity'
export const PORTAL_SEVERITY_LABEL_MAX = 80

export interface PortalSeverityOption {
  value:  string
  labels: Partial<Record<Lingua, string>>
}

export interface PortalSeverityChoice {
  value: string
  label: string
  color: ValueColor | null
}

export interface PortalSeverityOptionInput {
  value:  string
  labels: readonly { language: string; label: string }[]
}

function isLingua(v: unknown): v is Lingua {
  return typeof v === 'string' && (LINGUE as readonly string[]).includes(v)
}

function parseStored(raw: unknown, tenantId: string): PortalSeverityOption[] {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw) } catch (e) {
      throw new Error(`Tenant ${tenantId}: portal_severity_options is not valid JSON (${e instanceof Error ? e.message : String(e)})`, { cause: e })
    }
  }
  if (!Array.isArray(parsed)) throw new Error(`Tenant ${tenantId}: portal_severity_options must be a list`)
  return parsed.map((entry, i) => {
    if (entry === null || typeof entry !== 'object') throw new Error(`Tenant ${tenantId}: portal_severity_options[${String(i)}] is not an object`)
    const e = entry as Record<string, unknown>
    if (typeof e['value'] !== 'string' || e['value'] === '') throw new Error(`Tenant ${tenantId}: portal_severity_options[${String(i)}] has no value`)
    const labels: Partial<Record<Lingua, string>> = {}
    const rawLabels = e['labels']
    if (rawLabels !== undefined && (rawLabels === null || typeof rawLabels !== 'object')) {
      throw new Error(`Tenant ${tenantId}: portal_severity_options[${String(i)}].labels is not an object`)
    }
    for (const [lang, label] of Object.entries((rawLabels ?? {}) as Record<string, unknown>)) {
      if (!isLingua(lang)) throw new Error(`Tenant ${tenantId}: portal_severity_options[${String(i)}] has a label in an unknown language "${lang}"`)
      if (typeof label !== 'string' || label.trim() === '') throw new Error(`Tenant ${tenantId}: portal_severity_options[${String(i)}] has an empty label for "${lang}"`)
      labels[lang] = label
    }
    return { value: e['value'], labels }
  })
}

/** Le severità del portale come le ha salvate il cliente, o `null` se non le ha dichiarate. */
export async function portalSeverityOptions(tenantId: string): Promise<PortalSeverityOption[] | null> {
  const session = getSession()
  try {
    const row = await runQueryOne<{ raw: unknown }>(session,
      'MATCH (t:Tenant {id: $tenantId}) RETURN t.portal_severity_options AS raw', { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    if (row.raw == null || row.raw === '') return null
    return parseStored(row.raw, tenantId)
  } finally {
    await session.close()
  }
}

/**
 * Le scelte da mostrare nel portale, nella lingua di chi guarda. Si ferma se il
 * cliente non le ha dichiarate, o se ne nomina una che il suo vocabolario non
 * ha più (rinominata o tolta nel Dizionario): mostrarla vorrebbe dire aprire un
 * ticket con un valore che il servizio rifiuta.
 */
export async function portalSeverityChoices(tenantId: string, language: Lingua): Promise<PortalSeverityChoice[]> {
  const [options, vocabulary, fallback] = await Promise.all([
    portalSeverityOptions(tenantId),
    loadVocabularyEntries(tenantId, PORTAL_SEVERITY_VOCABULARY),
    languageFor(tenantId),
  ])
  if (options === null || options.length === 0) {
    throw new ValidationError(
      `Tenant "${tenantId}": the severities offered in the self-service portal are not configured, so a portal ticket cannot be opened. Choose them in Settings → Organization.`,
      { key: 'errors.portal.severityNotConfigured' },
    )
  }
  const stale = options.filter((o) => !vocabulary.values.includes(o.value)).map((o) => o.value)
  if (stale.length > 0) {
    throw new ValidationError(
      `Tenant "${tenantId}": the portal offers ${stale.join(', ')}, which the "severity" dictionary no longer has (${vocabulary.values.join(', ')}). Fix the choice in Settings → Organization.`,
      { key: 'errors.portal.severityStale', params: { values: stale.join(', '), allowed: vocabulary.values.join(', ') } },
    )
  }
  return options.map((o) => ({
    value: o.value,
    label: o.labels[language] ?? labelFor(o.value, vocabulary.labels, language, fallback),
    color: vocabulary.colors[o.value] ?? null,
  }))
}

/** Valida e salva la scelta dell'amministratore. Restituisce ciò che è stato salvato. */
/**
 * IL SEME: alla nascita di un tenant, tutte le severità del vocabolario con
 * le parole del Dizionario (17 set 2026).
 *
 * ## Perché serve
 * Un tenant appena creato nasceva con un rilievo di gravità ERRORE addosso —
 * `portal_severities_not_set` — e il portale non poteva aprire un ticket
 * finché qualcuno non entrava in Organizzazione a scegliere. Un prodotto che
 * si crea un errore da solo alla nascita ha un seme mancante, non una
 * configurazione da fare.
 *
 * ## Perché NON è «indovinare», che questo file vieta
 * Il divieto è sul momento della LETTURA: proprietà assente non diventa una
 * lista inventata, perché il portale mostrerebbe valori che nessuno ha
 * scelto. Qui si scrive una DICHIARAZIONE alla nascita, ed è la più neutra
 * possibile: **tutti** i valori del vocabolario `severity`, nel suo ordine, e
 * **nessuna etichetta propria** — la parola per ogni valore resta quella del
 * Dizionario, che è la regola già dichiarata in questo file. Non aggiunge
 * un'opinione: rende esplicito il massimo, e l'amministratore restringe.
 *
 * ## Additiva e idempotente
 * Scrive solo dove la proprietà è ASSENTE: chi ha già scelto — anche una sola
 * severità — non viene toccato. Senza vocabolario `severity` non scrive
 * niente e lo dice, invece di scrivere una lista vuota (che il lettore
 * rifiuterebbe a voce alta, e giustamente).
 */
export async function seedPortalSeverityOptions(
  session: Queryable, tenantId: string,
): Promise<{ seeded: readonly string[] | null; reason?: string }> {
  const vocabolari = await runQuery<{ tenantId: string; values: unknown }>(session, `
    MATCH (e:EnumTypeDefinition {name: $nome})
    WHERE e.tenant_id IN [$tenantId, 'system']
    RETURN e.tenant_id AS tenantId, e.values AS values
  `, { nome: PORTAL_SEVERITY_VOCABULARY, tenantId })

  // La copia del tenant VINCE sul nodo spedito, come in lettura.
  const scelto = vocabolari.find((v) => v.tenantId === tenantId) ?? vocabolari.find((v) => v.tenantId === 'system')
  const valori = Array.isArray(scelto?.values) ? scelto.values.filter((v): v is string => typeof v === 'string') : []
  if (valori.length === 0) {
    return { seeded: null, reason: `no "${PORTAL_SEVERITY_VOCABULARY}" vocabulary with values for tenant ${tenantId}` }
  }

  const options: PortalSeverityOption[] = valori.map((value) => ({ value, labels: {} }))
  const row = await runQueryOne<{ id: string }>(session, `
    MATCH (t:Tenant {id: $tenantId})
    WHERE t.portal_severity_options IS NULL
    SET t.portal_severity_options = $options, t.updated_at = $now
    RETURN t.id AS id
  `, { tenantId, options: JSON.stringify(options), now: new Date().toISOString() })

  // Nessuna riga: la scelta c'era già (o il tenant non esiste, e lo dirà chi
  // lo cerca). In entrambi i casi non si è scritto niente.
  return row ? { seeded: valori } : { seeded: null, reason: 'already chosen' }
}

export async function setPortalSeverityOptions(
  tenantId: string, input: readonly PortalSeverityOptionInput[],
): Promise<PortalSeverityOption[]> {
  if (input.length === 0) {
    throw new ValidationError('Choose at least one severity for the portal: without it nobody can open a ticket there.', { key: 'errors.portal.severityAtLeastOne' })
  }
  const vocabulary = await domainVocabulary(tenantId, PORTAL_SEVERITY_VOCABULARY)
  const seen = new Set<string>()
  const options: PortalSeverityOption[] = []
  for (const entry of input) {
    if (!vocabulary.includes(entry.value)) {
      throw new ValidationError(
        `"${entry.value}" is not a value of the "severity" dictionary (${vocabulary.join(', ')}).`,
        { key: 'errors.portal.severityUnknown', params: { value: entry.value, allowed: vocabulary.join(', ') } },
      )
    }
    if (seen.has(entry.value)) {
      throw new ValidationError(`"${entry.value}" appears twice.`, { key: 'errors.portal.severityDuplicate', params: { value: entry.value } })
    }
    seen.add(entry.value)
    const labels: Partial<Record<Lingua, string>> = {}
    for (const { language, label } of entry.labels) {
      if (!isLingua(language)) {
        throw new ValidationError(`Unknown language "${language}".`, { key: 'errors.portal.severityLanguage', params: { language } })
      }
      const text = label.trim()
      if (text === '') continue // lingua non scritta: vale l'etichetta del Dizionario
      if (text.length > PORTAL_SEVERITY_LABEL_MAX) {
        throw new ValidationError(
          `The label of "${entry.value}" is longer than ${String(PORTAL_SEVERITY_LABEL_MAX)} characters.`,
          { key: 'errors.portal.severityLabelTooLong', params: { value: entry.value, max: PORTAL_SEVERITY_LABEL_MAX } },
        )
      }
      labels[language] = text
    }
    options.push({ value: entry.value, labels })
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      SET t.portal_severity_options = $options, t.updated_at = $now
      RETURN t.id AS id
    `, { tenantId, options: JSON.stringify(options), now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
  return options
}
