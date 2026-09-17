/**
 * IL CICLO DI VITA DI UN TENANT, per la console di piattaforma (17 set 2026).
 *
 * Fino a oggi un tenant nasceva da uno script (`onboard-tenant`) e **non
 * moriva**: non esisteva nemmeno un modo per cancellarlo. Qui c'è l'elenco, la
 * rinomina, la sospensione e le due fasi della cancellazione.
 *
 * ## La cancellazione è in DUE PASSI (scelta del proprietario)
 * Prima SOSPESO — nessuno entra più, i dati restano, si annulla; poi, con un
 * comando esplicito e separato, la cancellazione definitiva. È lo stesso
 * schema che il prodotto usa già per le change, e qui vale il doppio: dietro
 * uno slug ci sono tutti i ticket, i CI e gli utenti di un cliente.
 *
 * Il passo definitivo si rifiuta se il tenant non è sospeso: non c'è una
 * scorciatoia da «attivo» a «cancellato», perché la prima metà della
 * protezione è proprio l'attesa.
 *
 * ## Quello che si cancella davvero
 * Ogni nodo con quel `tenant_id`, il nodo `:Tenant`, e il realm Keycloak.
 * L'ordine conta: prima il realm (nessuno entra più, nemmeno con un token
 * ancora valido), poi i dati. A rovescio, una cancellazione interrotta a metà
 * lascerebbe un realm che dà accesso a un tenant svuotato.
 *
 * ## Niente conteggi inventati
 * L'elenco porta quanti utenti e quanti ticket ha ogni tenant, perché chi
 * decide di cancellare deve vedere cosa sta cancellando. Se il conteggio non
 * si può fare, la riga lo dice con `null` — non con uno zero, che si legge
 * come «è vuoto, procedi».
 */
import type { Session } from 'neo4j-driver'
import { runQuery, runQueryOne, toNumber } from '@opengraphity/neo4j'
import { ValidationError, NotFoundError } from './errors.js'
import { logger } from './logger.js'
import { config } from './config.js'

const log = logger.child({ module: 'tenant-lifecycle' })

/** Lo stato di un tenant nella console. */
export type StatoTenant = 'active' | 'suspended'

export interface TenantRow {
  id:        string
  slug:      string
  name:      string
  plan:      string | null
  timezone:  string | null
  stato:     StatoTenant
  suspendedAt: string | null
  createdAt: string | null
  /** `null` quando il conteggio non si è potuto fare: non è uno zero. */
  utenti:    number | null
  ticket:    number | null
  /**
   * Gli indirizzi delle due app del tenant, dai modelli configurati
   * (`TENANT_URL_TEMPLATE`, `PORTAL_URL_TEMPLATE`). `null` quando il modello non
   * c'è: si scrive che non è configurato, non si indovina un link che potrebbe
   * essere rotto.
   */
  appUrl:    string | null
  portalUrl: string | null
}

/** `{slug}` sostituito, e nient'altro: un modello non è un linguaggio. */
function daModello(modello: string | undefined, slug: string): string | null {
  if (!modello || modello.trim() === '') return null
  return modello.trim().split('{slug}').join(slug)
}

/**
 * Lo slug è l'identità del tenant: è il realm Keycloak, il sottodominio e il
 * `tenant_id` di ogni nodo. Le regole sono quelle di un'etichetta DNS, più il
 * divieto di collidere con i nomi che il prodotto si è riservato.
 *
 * `portal` perché `portal.<tenant>` è l'host del portale; l'host della console
 * lo passa chi chiama, perché sta nella configurazione e non qui.
 */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/
const SLUG_RISERVATI = ['portal', 'www', 'api', 'admin', 'localhost', 'keycloak']

export function assertSlugValido(slug: string, slugRiservatiExtra: readonly string[] = []): void {
  if (!SLUG_RE.test(slug)) {
    throw new ValidationError(
      `"${slug}" is not a valid tenant slug: 3 to 32 characters, lowercase letters, digits and hyphens, not starting or ending with a hyphen.`,
      { key: 'errors.tenant.slugShape', params: { slug } })
  }
  const riservati = [...SLUG_RISERVATI, ...slugRiservatiExtra]
  if (riservati.includes(slug)) {
    throw new ValidationError(`"${slug}" is a reserved name and cannot be a tenant.`,
      { key: 'errors.tenant.slugReserved', params: { slug } })
  }
}

/**
 * I tenant, coi loro conteggi. Due query e non una: contare utenti e ticket
 * con un `OPTIONAL MATCH` sullo stesso giro moltiplicherebbe le righe, e un
 * `count(DISTINCT …)` su tutti i ticket di tutti i tenant è la scansione che
 * questa pagina non deve fare a ogni apertura.
 */
export async function listTenants(session: Session): Promise<TenantRow[]> {
  const righe = await runQuery<{
    id: string; slug: string | null; name: string | null; plan: string | null
    timezone: string | null; suspendedAt: string | null; createdAt: string | null
  }>(session, `
    MATCH (t:Tenant)
    WHERE t.id IS NOT NULL
    RETURN t.id AS id, t.slug AS slug, t.name AS name, t.plan AS plan,
           t.timezone AS timezone, t.suspended_at AS suspendedAt, t.created_at AS createdAt
    ORDER BY t.id
  `, {})

  const conteggi = new Map<string, { utenti: number | null; ticket: number | null }>()
  for (const r of righe) {
    try {
      const c = await runQueryOne<{ utenti: unknown; ticket: unknown }>(session, `
        OPTIONAL MATCH (u:User {tenant_id: $tenantId})
        WITH count(u) AS utenti
        OPTIONAL MATCH (n {tenant_id: $tenantId})
        WHERE n:Incident OR n:Problem OR n:Change OR n:ServiceRequest
        RETURN utenti, count(n) AS ticket
      `, { tenantId: r.id })
      conteggi.set(r.id, { utenti: toNumber(c?.utenti), ticket: toNumber(c?.ticket) })
    } catch (err) {
      // Un conteggio che non si fa non diventa uno zero: chi legge «0 ticket»
      // conclude che il tenant è vuoto e lo cancella.
      log.warn({ tenantId: r.id, err }, 'tenant counts unavailable')
      conteggi.set(r.id, { utenti: null, ticket: null })
    }
  }

  return righe.map((r) => ({
    id:          r.id,
    slug:        r.slug ?? r.id,
    name:        r.name ?? r.id,
    plan:        r.plan,
    timezone:    r.timezone,
    stato:       r.suspendedAt ? 'suspended' : 'active',
    suspendedAt: r.suspendedAt,
    createdAt:   r.createdAt,
    utenti:      conteggi.get(r.id)?.utenti ?? null,
    ticket:      conteggi.get(r.id)?.ticket ?? null,
    appUrl:      daModello(config.tenantUrlTemplate, r.slug ?? r.id),
    portalUrl:   daModello(config.portalUrlTemplate, r.slug ?? r.id),
  }))
}

async function tenantEsistente(session: Session, id: string): Promise<{ suspendedAt: string | null }> {
  const row = await runQueryOne<{ suspendedAt: string | null }>(session, `
    MATCH (t:Tenant {id: $id}) RETURN t.suspended_at AS suspendedAt
  `, { id })
  if (!row) throw new NotFoundError('Tenant', id)
  return row
}

/**
 * IL NOME si cambia, lo SLUG no.
 *
 * Il nome è un'etichetta: si legge nelle intestazioni e nelle notifiche.
 * Lo slug invece è l'identità — il realm Keycloak, il sottodominio, il
 * `tenant_id` di ogni nodo del grafo e di ogni allegato su MinIO: rinominarlo
 * vorrebbe dire riscrivere tutto quello, più un realm che non si rinomina.
 * Chi vuole un altro slug crea un tenant nuovo.
 */
export async function renameTenant(session: Session, id: string, nome: string): Promise<void> {
  const pulito = nome.trim()
  if (pulito === '') {
    throw new ValidationError('The tenant name cannot be empty.', { key: 'errors.tenant.nameEmpty', params: {} })
  }
  if (pulito.length > 120) {
    throw new ValidationError('The tenant name is too long: 120 characters at most.',
      { key: 'errors.tenant.nameTooLong', params: { max: '120' } })
  }
  await tenantEsistente(session, id)
  await runQuery(session, `
    MATCH (t:Tenant {id: $id})
    SET t.name = $nome, t.updated_at = $now
  `, { id, nome: pulito, now: new Date().toISOString() })
  log.info({ tenantId: id, nome: pulito }, 'tenant renamed')
}

/**
 * SOSPENDE un tenant: `suspended_at` sul nodo. I dati restano tutti.
 *
 * Il blocco vero dell'accesso lo fa `resolveAuth`, che rifiuta un token di un
 * tenant sospeso: qui si scrive solo il fatto. Sono due punti perché la
 * console non deve poter *decidere* chi entra — quello lo decide il cammino di
 * autenticazione, sempre, per ogni richiesta.
 */
export async function suspendTenant(session: Session, id: string): Promise<void> {
  const t = await tenantEsistente(session, id)
  if (t.suspendedAt) return // idempotente: già sospeso
  await runQuery(session, `
    MATCH (t:Tenant {id: $id})
    SET t.suspended_at = $now, t.updated_at = $now
  `, { id, now: new Date().toISOString() })
  log.warn({ tenantId: id }, 'tenant SUSPENDED: no access, data untouched')
}

/** Riattiva un tenant sospeso. */
export async function resumeTenant(session: Session, id: string): Promise<void> {
  await tenantEsistente(session, id)
  await runQuery(session, `
    MATCH (t:Tenant {id: $id})
    REMOVE t.suspended_at
    SET t.updated_at = $now
  `, { id, now: new Date().toISOString() })
  log.info({ tenantId: id }, 'tenant resumed')
}

/**
 * Quanto c'è da cancellare, nodo per etichetta. Serve alla conferma: chi
 * cancella deve leggere i numeri, non fidarsi di una frase.
 */
export async function tenantFootprint(session: Session, id: string): Promise<Record<string, number>> {
  const righe = await runQuery<{ etichetta: string; quanti: unknown }>(session, `
    MATCH (n {tenant_id: $id})
    WITH labels(n)[0] AS etichetta, count(*) AS quanti
    WHERE etichetta IS NOT NULL
    RETURN etichetta, quanti
    ORDER BY quanti DESC
  `, { id })
  const out: Record<string, number> = {}
  for (const r of righe) out[r.etichetta] = toNumber(r.quanti)
  return out
}

/**
 * LA CANCELLAZIONE DEFINITIVA. Irreversibile, e per questo con tre sbarre.
 *
 *  1. il tenant deve esistere;
 *  2. deve essere SOSPESO — non c'è scorciatoia da «attivo» a «cancellato»,
 *     perché la prima metà della protezione è l'attesa;
 *  3. chi chiama deve ripetere lo slug (`conferma`): un clic solo non cancella
 *     un cliente.
 *
 * ## L'ordine: prima il realm, poi i dati
 * Si cancella il realm Keycloak per primo, così nessuno entra più nemmeno con
 * un token ancora valido in mano. A rovescio, un'interruzione a metà
 * lascerebbe un realm che dà accesso a un tenant svuotato — cioè un'app che si
 * apre su niente, con errori al posto dei dati.
 *
 * ## I nodi si cancellano A SCAGLIONI
 * `CALL … IN TRANSACTIONS` perché un tenant con centomila nodi non entra in
 * una transazione sola: senza, la cancellazione fallirebbe proprio sui tenant
 * grandi, cioè quelli che più probabilmente si vogliono cancellare.
 *
 * Il realm si cancella solo se `deleteRealm` è fornito: i test non parlano con
 * Keycloak, e un modulo che pretende una rete non si prova.
 */
export interface PurgeEsito {
  realmCancellato: boolean
  nodiCancellati:  number
}

export async function purgeTenant(
  session: Session,
  id: string,
  conferma: string,
  deleteRealm?: (realm: string) => Promise<void>,
): Promise<PurgeEsito> {
  const t = await tenantEsistente(session, id)
  if (!t.suspendedAt) {
    throw new ValidationError(
      `The tenant "${id}" is not suspended: suspend it first, then delete it. There is no shortcut from active to deleted.`,
      { key: 'errors.tenant.purgeNotSuspended', params: { slug: id } })
  }
  if (conferma !== id) {
    throw new ValidationError(
      `To delete the tenant "${id}" its slug must be typed again as confirmation.`,
      { key: 'errors.tenant.purgeConfirmMismatch', params: { slug: id } })
  }

  let realmCancellato = false
  if (deleteRealm) {
    // Prima di toccare i dati: se questo fallisce, non si è cancellato niente.
    await deleteRealm(id)
    realmCancellato = true
    log.warn({ tenantId: id }, 'tenant Keycloak realm deleted')
  }

  const conta = await runQueryOne<{ quanti: unknown }>(session, `
    MATCH (n {tenant_id: $id}) RETURN count(n) AS quanti
  `, { id })
  const nodiCancellati = toNumber(conta?.quanti)

  await runQuery(session, `
    MATCH (n {tenant_id: $id})
    CALL (n) {
      DETACH DELETE n
    } IN TRANSACTIONS OF 1000 ROWS
  `, { id })

  // Il nodo del tenant per ultimo: finché c'è, la console sa che quel tenant
  // esisteva e che la cancellazione era in corso.
  await runQuery(session, `MATCH (t:Tenant {id: $id}) DETACH DELETE t`, { id })

  log.warn({ tenantId: id, nodiCancellati, realmCancellato }, 'tenant PERMANENTLY DELETED')
  return { realmCancellato, nodiCancellati }
}
