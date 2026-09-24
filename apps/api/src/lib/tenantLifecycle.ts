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
import path from 'node:path'
import fs from 'node:fs/promises'
import type { Session } from 'neo4j-driver'
import { runQuery, runQueryOne, toNumber } from '@opengraphity/neo4j'
import { countTenantNodesByLabel, deleteTenantNodes } from './tenantNodes.js'
import { ValidationError, NotFoundError } from './errors.js'
import { logger } from './logger.js'
import { config } from './config.js'
import { SYSTEM_TENANT } from './enumScope.js'

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
  /**
   * Gli amministratori del tenant (e-mail, in ordine). Servono a una cosa
   * sola: poter reimpostare la password di chi entra, dalla console, senza
   * passare a mano da Keycloak. Vuota = nessun admin attivo, ed è un tenant in
   * cui NESSUNO può entrare: la console lo dice invece di offrire un pulsante
   * che non ha su chi agire.
   */
  admins:    string[]
}

/** `{slug}` sostituito, e nient'altro: un modello non è un linguaggio. */
/**
 * The domain the tenants live under, from the installation's
 * `TENANT_URL_TEMPLATE` (`https://{slug}.example.com` → `example.com`).
 *
 * Review of 23 Sep 2026: a tenant created from the console always got
 * `opengrafo.com`, written in the code, so on any other installation its
 * sign-in failed (redirect URI mismatch). A template missing, or not of the
 * form `<scheme>://{slug}.<domain>`, is an error that says so: a guessed
 * domain would create a realm nobody can sign in to.
 */
export function tenantDomainFromTemplate(template: string | undefined): string {
  const t = template?.trim() ?? ''
  const m = /^https?:\/\/\{slug\}\.([a-z0-9.-]+?)(?::\d+)?\/?$/i.exec(t)
  if (!m) {
    throw new Error(t === ''
      ? 'TENANT_URL_TEMPLATE is not configured: the domain of a new tenant cannot be known'
      : `TENANT_URL_TEMPLATE "${t}" is not of the form <scheme>://{slug}.<domain>: the domain of a new tenant cannot be known`)
  }
  return m[1]!.toLowerCase()
}

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
 *
 * Reserved since 23 Sep 2026: `system` (SYSTEM_TENANT), the tenant_id of the
 * rows every tenant shares — a tenant with that id would read and change them
 * as its own; and `master`, Keycloak's own realm — onboarding leaves a realm
 * that already exists as it was and creates its first administrator in it.
 */
const SLUG_RE = /^[a-z0-9]([a-z0-9-]{1,30}[a-z0-9])$/
const SLUG_RISERVATI = ['portal', 'www', 'api', 'admin', 'localhost', 'keycloak', SYSTEM_TENANT, 'master']

/**
 * The names this installation reserves in its configuration: the subdomain of
 * the platform console, and the platform realm. A tenant named like the
 * platform realm would get its first administrator created IN that realm
 * (onboarding leaves an existing realm as it was): a login to the platform
 * console, handed to a customer.
 */
export function configuredReservedSlugs(): string[] {
  const consoleHost = config.platformHost?.split('.')[0]?.toLowerCase()
  const platformRealm = config.platformRealm?.toLowerCase()
  return [consoleHost, platformRealm].filter((n): n is string => typeof n === 'string' && n !== '')
}

/**
 * Every reserved name, the configured ones included. A tenant row with one of
 * these ids is not a customer: `system` holds the rows every tenant shares.
 */
export function reservedTenantIds(): string[] {
  return [...SLUG_RISERVATI, ...configuredReservedSlugs()]
}

/**
 * The platform console does not suspend, resume or delete a reserved tenant
 * (review of 23 Sep 2026): purging `system` ran a DETACH DELETE on the shared
 * metamodel and vocabularies of every customer.
 */
function assertNotReserved(id: string): void {
  if (reservedTenantIds().includes(id)) {
    throw new ValidationError(`"${id}" is reserved: it is not a customer's tenant and cannot be suspended, resumed or deleted.`,
      { key: 'errors.tenant.reservedNotManaged', params: { slug: id } })
  }
}

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
    WHERE t.id IS NOT NULL AND NOT t.id IN $reserved
    RETURN t.id AS id, t.slug AS slug, t.name AS name, t.plan AS plan,
           t.timezone AS timezone, t.suspended_at AS suspendedAt, t.created_at AS createdAt
    ORDER BY t.id
  `, { reserved: reservedTenantIds() })

  /*
   * Gli admin in UNA query per tutti i tenant: sono pochi per tenant (uno,
   * di solito) e una query per riga avrebbe aggiunto un giro a ogni apertura
   * della pagina. Il filtro sul ruolo è quello dell'API, non un'idea nuova.
   */
  const admins = new Map<string, string[]>()
  try {
    // tenant-ok(piattaforma): la console di piattaforma guarda TUTTI i tenant, per definizione.
    const righeAdmin = await runQuery<{ tenantId: string; email: string }>(session, `
      MATCH (u:User)
      WHERE u.role = 'admin' AND coalesce(u.active, true) = true
        AND u.email IS NOT NULL AND u.tenant_id IS NOT NULL
      RETURN u.tenant_id AS tenantId, u.email AS email
      ORDER BY tenantId, email
    `, {})
    for (const a of righeAdmin) {
      const elenco = admins.get(a.tenantId) ?? []
      elenco.push(a.email)
      admins.set(a.tenantId, elenco)
    }
  } catch (err) {
    // Come i conteggi: non si finge che non ce ne siano.
    log.warn({ err }, 'tenant admins unavailable')
  }

  const conteggi = new Map<string, { utenti: number | null; ticket: number | null }>()
  for (const r of righe) {
    try {
      const c = await runQueryOne<{ utenti: unknown; ticket: unknown }>(session, `
        OPTIONAL MATCH (u:User {tenant_id: $tenantId})
        WITH count(u) AS utenti
        // One index count per ticket label (D25): the pattern without a label read every node.
        CALL () {
          MATCH (n:Incident {tenant_id: $tenantId}) RETURN count(n) AS c
          UNION ALL MATCH (n:Problem {tenant_id: $tenantId}) RETURN count(n) AS c
          UNION ALL MATCH (n:Change {tenant_id: $tenantId}) RETURN count(n) AS c
          UNION ALL MATCH (n:ServiceRequest {tenant_id: $tenantId}) RETURN count(n) AS c
        }
        RETURN utenti, sum(c) AS ticket
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
    admins:      admins.get(r.id) ?? [],
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
  assertNotReserved(id)
  const t = await tenantEsistente(session, id)
  if (t.suspendedAt) return // idempotente: già sospeso
  await runQuery(session, `
    MATCH (t:Tenant {id: $id})
    SET t.suspended_at = $now, t.updated_at = $now
  `, { id, now: new Date().toISOString() })
  log.warn({ tenantId: id }, 'tenant SUSPENDED: no access, data untouched')
}

/**
 * REIMPOSTARE LA PASSWORD DI UN AMMINISTRATORE (17 set 2026).
 *
 * Nasce da un vicolo cieco vero: la console creava un tenant e mostrava la
 * password temporanea UNA volta — se la si perdeva, in quel tenant non
 * entrava più nessuno, e la sola via d'uscita era Keycloak a mano. Un prodotto
 * che ti porta in uno stato da cui non ti tira fuori ha un pezzo mancante, non
 * una password dimenticata.
 *
 * Tre cose che questa funzione NON fa, di proposito:
 *
 *  - **non sceglie l'utente**: l'e-mail arriva da chi chiama e deve essere di
 *    un amministratore ATTIVO di QUEL tenant. Indovinare «il primo admin»
 *    reimposterebbe, prima o poi, la password della persona sbagliata.
 *  - **non tocca il database**: la password vive solo in Keycloak. Qui si
 *    legge chi può averla, e il resto lo fa `impostaInKeycloak`, che arriva da
 *    fuori — così la funzione si prova senza rete, come `purgeTenant`.
 *  - **non ritorna la password se impostarla è FALLITO**: consegnare una
 *    password che non è quella vera è peggio di un errore, perché manda a
 *    cercare il guasto dall'altra parte.
 */
export interface EsitoResetPassword {
  email: string
  /** Temporanea: Keycloak obbliga il cambio al primo accesso. Mostrata una volta. */
  temporaryPassword: string
  /** Vero se il tenant è sospeso: la password è valida, ma nessuno entra finché non si riattiva. */
  tenantSospeso: boolean
}

export async function resetAdminPassword(
  session: Session,
  id: string,
  email: string,
  generaPassword: () => string,
  impostaInKeycloak: (realm: string, email: string, password: string) => Promise<void>,
): Promise<EsitoResetPassword> {
  const t = await tenantEsistente(session, id)

  const pulita = email.trim().toLowerCase()
  const row = await runQueryOne<{ email: string }>(session, `
    MATCH (u:User {tenant_id: $id, email: $email})
    WHERE u.role = 'admin' AND coalesce(u.active, true) = true
    RETURN u.email AS email
  `, { id, email: pulita })
  if (!row) {
    // La frase dice cosa cercare, non solo che è andata male: l'e-mail può
    // essere di un altro tenant, di un utente disattivato o di un non-admin.
    throw new ValidationError(
      `"${pulita}" is not an active administrator of tenant "${id}": the password can only be reset for an administrator who can actually sign in.`,
      { key: 'errors.tenant.notAnAdmin', params: { email: pulita, tenant: id } })
  }

  const password = generaPassword()
  await impostaInKeycloak(id, pulita, password)
  log.warn({ tenantId: id, email: pulita }, 'admin password reset from the platform console')

  return { email: pulita, temporaryPassword: password, tenantSospeso: t.suspendedAt != null }
}

/** Riattiva un tenant sospeso. */
export async function resumeTenant(session: Session, id: string): Promise<void> {
  assertNotReserved(id)
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
  // Label by label (lib/tenantNodes.ts): the count without a label scanned every customer's nodes.
  const perLabel = await countTenantNodesByLabel(session, id)
  return Object.fromEntries(Object.entries(perLabel).sort((a, b) => b[1] - a[1]))
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
  /** The tenant's attachment directory was there and was removed. */
  allegatiCancellati: boolean
}

/**
 * The attachment files of the tenant, `<ATTACHMENT_DIR>/<tenant>/…` (review of
 * 23 Sep 2026: a deleted tenant left them on the disk). True when a directory
 * was there. The path is checked to stay inside the storage directory.
 */
async function deleteTenantAttachments(tenantId: string): Promise<boolean> {
  const base = path.resolve(config.attachmentDir)
  const dir = path.resolve(base, tenantId)
  if (!dir.startsWith(base + path.sep)) throw new Error(`purgeTenant: the attachment directory of "${tenantId}" escapes the storage directory`)
  const there = await fs.stat(dir).then(() => true, () => false)
  if (there) await fs.rm(dir, { recursive: true, force: true })
  return there
}

export async function purgeTenant(
  session: Session,
  id: string,
  conferma: string,
  deleteRealm?: (realm: string) => Promise<void>,
): Promise<PurgeEsito> {
  assertNotReserved(id)
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

  // Label by label, in transactions of a thousand rows (lib/tenantNodes.ts):
  // the unlabelled delete is the query that made Neo4j fall on the demo.
  const nodiCancellati = await deleteTenantNodes(session, id)
  // The files go with the nodes: the attachments were left on the disk.
  const allegatiCancellati = await deleteTenantAttachments(id)

  // Il nodo del tenant per ultimo: finché c'è, la console sa che quel tenant
  // esisteva e che la cancellazione era in corso.
  await runQuery(session, `MATCH (t:Tenant {id: $id}) DETACH DELETE t`, { id })

  log.warn({ tenantId: id, nodiCancellati, realmCancellato, allegatiCancellati }, 'tenant PERMANENTLY DELETED')
  return { realmCancellato, nodiCancellati, allegatiCancellati }
}
