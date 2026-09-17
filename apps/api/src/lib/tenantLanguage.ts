/**
 * LA LINGUA PREDEFINITA DEL CLIENTE — configurazione, non una riga di codice.
 *
 * ## Il difetto, che è stato scritto due volte
 * Il ripiego delle etichette era `const LINGUA_PREDEFINITA = 'it'`. Cambiarlo
 * in `'en'` non lo avrebbe corretto: avrebbe solo scelto un'altra costante. La
 * lingua in cui si legge un prodotto è una decisione del cliente — un'azienda
 * italiana la vuole italiana, la stessa installazione per un cliente irlandese
 * la vuole inglese — e una decisione del cliente si configura dall'interfaccia,
 * non si compila.
 *
 * ## Cosa decide, e cosa NON decide
 * Decide la lingua di chi **non ha scelto**: chi apre il prodotto per la prima
 * volta, e il ripiego di un'etichetta scritta in una lingua sola. NON decide la
 * lingua di chi ha scelto dal proprio Profilo — quella vince sempre, ed è
 * un'altra cosa (la preferenza di una persona, non il default di un'azienda).
 *
 * ## Cosa resta nel codice
 * L'ELENCO delle lingue (`LINGUE`), perché è l'elenco dei file di traduzione
 * spediti nel bundle: aggiungerne una vuol dire scrivere un file, ed è un atto
 * di sviluppo. Configurabile è la SCELTA fra quelle che ci sono.
 *
 * ## Se non è configurata
 * Non si indovina in silenzio. Si legge la prima lingua dell'elenco — bisogna
 * mostrare qualcosa — e la diagnostica lo DICE all'admin
 * (`default_language_not_set`), come per ogni altro pezzo di configurazione che
 * manca. Fra un ripiego muto e un ripiego che si annuncia, la differenza è chi
 * scopre il problema: noi o il cliente.
 */
import { getSession, runQuery, runQueryOne, type Queryable } from '@opengraphity/neo4j'
import { NotFoundError, ValidationError } from './errors.js'
import { registerMetamodelCacheClearer, invalidateSchema } from './schemaInvalidator.js'
import { LINGUE, type Lingua } from './enumValueLabels.js'
import { logger } from './logger.js'

const log = logger.child({ module: 'tenant-language' })

/** La lingua da mostrare finché non se ne configura una. Vedi l'intestazione: si annuncia. */
export const LINGUA_DI_ULTIMA_ISTANZA: Lingua = LINGUE[0]

/**
 * Cache in memoria, come per la policy degli allarmi: questa la si chiede a
 * OGNI risoluzione di etichette, cioè su ogni pagina. TTL corto perché il
 * cambio dal Profilo dell'azienda deve vedersi subito, e l'invalidazione
 * esplicita sulla scrittura copre il caso normale (una sola istanza).
 */
const TTL_MS = 30_000
const cache = new Map<string, { lingua: Lingua | null; scade: number }>()

export function invalidateTenantLanguageCache(tenantId?: string): void {
  if (tenantId === undefined) cache.clear()
  else cache.delete(tenantId)
}

/**
 * La lingua del cliente passa dal canale fra processi (revisione totale ·
 * A-15): l'invalidazione era locale, e un allarme arrivato subito dopo il
 * cambio generava incident e notifiche ancora nella lingua vecchia nel
 * processo `events-worker`.
 */
registerMetamodelCacheClearer('tenant-language', (tenantId: string) => { cache.delete(tenantId) })

/**
 * La lingua di chi guarda, come la manda il client (`language`). Vuota o assente
 * = quella del cliente (`undefined`). Una lingua che il prodotto non ha è un
 * errore, non un ripiego in silenzio (come le etichette del Dizionario).
 */
export function viewerLanguage(v: unknown): Lingua | undefined {
  if (v == null || v === '') return undefined
  if (isLingua(v)) return v
  throw new ValidationError(
    `Language "${String(v)}" not recognised: the product has ${LINGUE.join(', ')}.`,
    { key: 'errors.enum.unknownLanguage', params: { language: String(v), available: LINGUE.join(', ') } },
  )
}

/** Vero quando la stringa è una delle lingue del prodotto. */
export function isLingua(v: unknown): v is Lingua {
  return typeof v === 'string' && (LINGUE as readonly string[]).includes(v)
}

/**
 * La lingua configurata dal cliente, o `null` se non è configurata. Il `null`
 * non è un errore ed è deliberatamente diverso da «l'inglese»: chi legge deve
 * poter distinguere «ha scelto l'inglese» da «nessuno ha scelto», perché la
 * seconda è una cosa da dire all'admin.
 */
export async function tenantDefaultLanguage(tenantId: string): Promise<Lingua | null> {
  const ora = Date.now()
  const cached = cache.get(tenantId)
  if (cached && cached.scade > ora) return cached.lingua

  const session = getSession()
  try {
    const row = await runQueryOne<{ lingua: unknown }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      RETURN t.default_language AS lingua
    `, { tenantId })
    if (!row) throw new NotFoundError('Tenant', tenantId)
    let lingua: Lingua | null = null
    if (row.lingua != null && row.lingua !== '') {
      if (isLingua(row.lingua)) lingua = row.lingua
      else {
        /*
          Un valore che non è una lingua del prodotto non si applica in
          silenzio: sarebbe una pagina in una lingua inesistente, senza che
          nessuno sappia perché. Si tratta come «non configurata» — e quel caso
          la diagnostica lo dice — e il motivo vero finisce nei log.
        */
        log.error({ tenantId, valore: String(row.lingua), lingue: LINGUE },
          'Tenant.default_language non è una lingua del prodotto: trattata come non configurata')
      }
    }
    cache.set(tenantId, { lingua, scade: ora + TTL_MS })
    return lingua
  } finally {
    await session.close()
  }
}

/**
 * La lingua in cui RISOLVERE qualcosa per questo cliente, quando chi guarda non
 * ne ha chiesta una: la configurata, o quella di ultima istanza.
 */
export async function languageFor(tenantId: string): Promise<Lingua> {
  return (await tenantDefaultLanguage(tenantId)) ?? LINGUA_DI_ULTIMA_ISTANZA
}

/**
 * LA LINGUA DI CHI LEGGE IL MESSAGGIO, non quella dell'organizzazione.
 *
 * `languageFor` dà la lingua predefinita del cliente, e va bene per i testi
 * che non hanno un destinatario. Ma un RIFIUTO lo legge una persona, e quella
 * persona può avere scelto un'altra lingua (`setMyLanguage`, che scrive
 * `u.language`): su un tenant italiano un utente inglese leggeva metà frase
 * tradotta dal client e l'etichetta del campo nell'altra lingua — il difetto
 * che un commento dichiarava chiuso ed era chiuso a metà (revisione del 17 set
 * 2026).
 *
 * Senza utente (una chiave API, un worker) resta la lingua del cliente.
 */
export async function languageForUser(tenantId: string, userId: string | null | undefined): Promise<Lingua> {
  if (!userId) return languageFor(tenantId)
  const session = getSession(undefined, 'READ')
  try {
    const rows = await runQuery<{ language: string | null }>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      RETURN u.language AS language`, { userId, tenantId })
    const scelta = rows[0]?.language
    if (scelta && isLingua(scelta)) return scelta
  } finally { await session.close() }
  return languageFor(tenantId)
}

/** Configura la lingua predefinita del cliente. Rifiuta tutto ciò che non è una lingua del prodotto. */
/**
 * IL SEME: alla nascita di un tenant, la lingua del prodotto (17 set 2026).
 *
 * `LINGUA_DI_ULTIMA_ISTANZA` è già quello che il prodotto MOSTRA a chi non ha
 * scelto — inglese, la lingua del prodotto — ma mostrarla senza che nessuno
 * l'abbia scritta lascia addosso a ogni tenant nuovo il rilievo
 * `default_language_not_set`, e sposta la domanda «in che lingua parla questo
 * cliente?» dentro un ripiego. Scriverla alla nascita non cambia una riga di
 * quello che si legge a schermo: cambia che ora è una scelta, visibile in
 * Organizzazione, e cambiabile in italiano con un clic.
 *
 * Additiva e idempotente: scrive solo dove la proprietà è assente. Un cliente
 * che ha scelto l'italiano non torna all'inglese — sarebbe il difetto peggiore
 * che un seme può fare.
 */
export async function seedDefaultLanguage(
  session: Queryable, tenantId: string,
): Promise<{ seeded: Lingua | null }> {
  const row = await runQueryOne<{ id: string }>(session, `
    MATCH (t:Tenant {id: $tenantId})
    WHERE t.default_language IS NULL
    SET t.default_language = $lingua, t.updated_at = $now
    RETURN t.id AS id
  `, { tenantId, lingua: LINGUA_DI_ULTIMA_ISTANZA, now: new Date().toISOString() })

  if (!row) return { seeded: null }   // già scelta, o tenant inesistente
  // La cache tiene anche i «null»: senza questo, il tenant continuerebbe a
  // risultare senza lingua per la durata del TTL.
  invalidateTenantLanguageCache(tenantId)
  return { seeded: LINGUA_DI_ULTIMA_ISTANZA }
}

export async function setTenantDefaultLanguage(tenantId: string, lingua: string): Promise<Lingua> {
  if (!isLingua(lingua)) {
    throw new ValidationError(
      `Language "${lingua}" not recognised: the product is translated into ${LINGUE.join(', ')}.`,
      { key: 'errors.enum.unknownLanguage', params: { language: lingua, available: LINGUE.join(', ') } },
    )
  }
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ id: string }>(session, `
      MATCH (t:Tenant {id: $tenantId})
      SET t.default_language = $lingua, t.updated_at = $now
      RETURN t.id AS id
    `, { tenantId, lingua, now: new Date().toISOString() })
    if (!row) throw new NotFoundError('Tenant', tenantId)
  } finally {
    await session.close()
  }
  // Il canale avvisa TUTTI i processi (A-15), non solo questo.
  invalidateSchema(tenantId)
  // Le notifiche che escono (e-mail, Slack, Teams) tengono la loro copia: anche
  // lei. Import differito: questo modulo è letto ovunque, il dispatcher no.
  const { invalidateNotificationLocale } = await import('@opengraphity/notifications')
  invalidateNotificationLocale(tenantId)
  return lingua
}
