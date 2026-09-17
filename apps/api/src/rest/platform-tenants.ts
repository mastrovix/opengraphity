/**
 * LA SUPERFICIE DELLA CONSOLE DI PIATTAFORMA (17 set 2026).
 *
 * REST e non GraphQL, e la ragione è un invariante che vale la pena non
 * rompere: **ogni resolver GraphQL di questo prodotto è legato a un tenant** —
 * c'è un lint (`tenantScoping`) che lo pretende su tutta l'API. La console non
 * ha un tenant: metterla nello stesso schema avrebbe voluto dire un contesto
 * con un `tenantId` finto, e da quel momento il lint avrebbe protetto una
 * bugia. Qui la scrittura è fuori, con la sua autenticazione
 * (`platformAuthMiddleware`, realm dedicato + host della console).
 *
 * Le rotte:
 *   GET    /platform/tenants                 elenco, coi conteggi
 *   GET    /platform/tenants/:slug/footprint quanti nodi si cancellerebbero
 *   PATCH  /platform/tenants/:slug           rinomina · sospendi · riattiva
 *   DELETE /platform/tenants/:slug           cancellazione definitiva
 *
 *   POST   /platform/tenants                 crea un tenant, dallo stesso
 *                                            codice dello script di onboarding
 *
 * ## Ogni azione lascia una traccia
 * Nei log, con l'email di chi l'ha fatta: sono le operazioni più potenti del
 * prodotto, e l'audit dei tenant non può stare dentro il tenant che si sta
 * cancellando.
 */
import { Router, type Router as ExpressRouter, type Request, type Response } from 'express'
import { getSession } from '@opengraphity/neo4j'
import type { Session } from 'neo4j-driver'
import { platformAuthMiddleware } from '../auth/platformAuth.js'
import { asyncHandler, restErrorHandler } from './errorHandler.js'
import { logger } from '../lib/logger.js'
import {
  listTenants, renameTenant, suspendTenant, resumeTenant, purgeTenant, tenantFootprint, assertSlugValido,
} from '../lib/tenantLifecycle.js'
import { config } from '../lib/config.js'
import { DEFAULT_TENANT_PLAN, DEFAULT_TENANT_TIMEZONE } from '../lib/tenantPlans.js'

const log = logger.child({ module: 'platform-console' })

const router: ExpressRouter = Router()

router.use('/platform', platformAuthMiddleware)

/** L'attore: c'è sempre, dopo il middleware. Assente = errore di cablaggio. */
function attore(req: Request): string {
  const a = req.platformActor
  if (!a) throw new Error('platform-tenants reached without platformAuthMiddleware — req.platformActor is missing')
  return a.email
}

/**
 * LA SESSIONE, con il suo MODO dichiarato.
 *
 * `getSession()` apre in SOLA LETTURA per default, e l'ho scoperto nel modo
 * peggiore: sospendere un tenant rispondeva 500 con «Writing in read access
 * mode not allowed» (17 set 2026). La creazione funzionava — passa da
 * `tenantOnboarding`, che apre la sua sessione in scrittura — quindi il
 * difetto colpiva solo rinomina, sospensione, riattivazione e cancellazione,
 * cioè tutto quello che la console fa DOPO che un tenant esiste.
 *
 * Perciò due funzioni con due nomi, e non un parametro con un default: un
 * default è esattamente ciò che ha nascosto il problema. Chi aggiunge una
 * rotta deve scegliere, e il nome della funzione che scrive lo dice.
 */
async function conSessioneDiLettura<T>(fn: (session: Session) => Promise<T>): Promise<T> {
  return await usa(getSession(), fn)
}

async function conSessioneDiScrittura<T>(fn: (session: Session) => Promise<T>): Promise<T> {
  return await usa(getSession(undefined, 'WRITE'), fn)
}

async function usa<T>(session: Session, fn: (session: Session) => Promise<T>): Promise<T> {
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

router.get('/platform/tenants', asyncHandler(async (req: Request, res: Response) => {
  const righe = await conSessioneDiLettura((s) => listTenants(s))
  res.json({ tenants: righe })
}))

router.get('/platform/tenants/:slug/footprint', asyncHandler(async (req: Request, res: Response) => {
  const slug = String(req.params['slug'])
  const nodi = await conSessioneDiLettura((s) => tenantFootprint(s, slug))
  res.json({ slug, nodes: nodi })
}))

/**
 * CREARE UN TENANT (17 set 2026).
 *
 * Passa dallo STESSO codice dello script `onboard-tenant`
 * (`lib/tenantOnboarding.ts`): realm, i due client delle app, il primo
 * amministratore, il nodo del tenant, i ruoli, la dashboard, le regole di
 * notifica, le matrici e i cinque workflow. Due copie di «come nasce un
 * cliente» sarebbero divergute, e un tenant creato da qui sarebbe nato a metà.
 *
 * ## La password si consegna UNA volta
 * Keycloak riceve una password generata e TEMPORANEA (cambio obbligatorio al
 * primo accesso), e la risposta la porta una volta sola: non è scritta da
 * nessuna parte e non si può richiedere. Se chi crea il tenant la perde, si
 * reimposta da Keycloak — non si recupera.
 *
 * `onPassword` la raccoglie nell'istante in cui è stata impostata, prima di
 * ogni altro passo: così anche se il provisioning crolla a metà, la risposta la
 * contiene. Il tenant sarebbe da completare, ma il suo amministratore non
 * resterebbe chiuso fuori — è già capitato in questo progetto, con lo script.
 *
 * ## Lo slug non si cambia dopo
 * È il realm, il sottodominio e il `tenant_id` di ogni nodo: si valida QUI, coi
 * nomi riservati del prodotto più l'host della console, che è configurazione e
 * non una costante.
 */
router.post('/platform/tenants', asyncHandler(async (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown>
  const chi = attore(req)

  const testo = (nome: string): string => {
    const v = body[nome]
    return typeof v === 'string' ? v.trim() : ''
  }

  const slug = testo('slug').toLowerCase()
  // Lo slug della console fra i riservati: sta nella configurazione, non in una
  // costante del modulo, perché ogni installazione ha il suo host.
  const hostConsole = config.platformHost?.split('.')[0]?.toLowerCase()
  assertSlugValido(slug, hostConsole ? [hostConsole] : [])

  const email = testo('adminEmail').toLowerCase()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    res.status(400).json({ error: 'adminEmail must be a valid email address: it is how the first administrator signs in' })
    return
  }

  const plan = testo('plan') || DEFAULT_TENANT_PLAN
  if (!(['starter', 'pro', 'enterprise'] as const).includes(plan as 'starter')) {
    res.status(400).json({ error: 'plan must be one of: starter, pro, enterprise' })
    return
  }

  /*
   * Il fuso si VALIDA: un fuso inventato non fallisce alla creazione, fallisce
   * mesi dopo sul primo calcolo di uno SLA, e nessuno collegherebbe le due cose.
   */
  const timezone = testo('timezone') || DEFAULT_TENANT_TIMEZONE
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone })
  } catch {
    res.status(400).json({ error: `timezone "${timezone}" is not a valid IANA zone (for example Europe/Rome)` })
    return
  }

  const spec = {
    slug,
    tenantName: testo('name') || slug,
    plan:       plan as 'starter' | 'pro' | 'enterprise',
    timezone,
    email,
    firstName:  testo('adminFirstName') || 'Admin',
    lastName:   testo('adminLastName') || slug,
    adminRole:  'admin',
    domain:     testo('domain') || 'opengrafo.com',
    production: body['production'] === true,
    piIp:       undefined,
  }

  const { createKeycloakAdmin, keycloakConfigFromEnv } = await import('../scripts/lib/keycloakAdmin.js')
  const { onboardTenant } = await import('../lib/tenantOnboarding.js')
  const { generateTemporaryPassword } = await import('../scripts/lib/password.js')
  const kc = createKeycloakAdmin(keycloakConfigFromEnv())

  const password = { value: generateTemporaryPassword(), temporary: true }
  let consegnata: string | null = null

  log.warn({ slug, chi, email }, 'console: tenant creation requested')
  try {
    const esito = await onboardTenant(kc, spec, password, {
      onStep: (linea) => log.info({ slug, linea }, 'console: onboarding step'),
      onPassword: () => { consegnata = password.value },
    })
    log.warn({ slug, chi }, 'console: tenant created')
    res.json({ slug, temporaryPassword: consegnata, steps: esito.steps, created: esito })
  } catch (err) {
    /*
     * Se l'onboarding crolla DOPO aver impostato la password, la risposta la
     * porta comunque: il tenant è da completare (basta rilanciare, è
     * idempotente) ma il suo amministratore non resta chiuso fuori.
     */
    const messaggio = err instanceof Error ? err.message : String(err)
    log.error({ slug, chi, err: messaggio }, 'console: tenant creation failed')
    res.status(500).json({
      error: messaggio,
      slug,
      ...(consegnata ? { temporaryPassword: consegnata, partial: true } : {}),
    })
  }
}))

/**
 * Rinomina, sospendi, riattiva. Un'azione per chiamata: `{ action: 'rename',
 * name: '…' }` oppure `{ action: 'suspend' }` / `{ action: 'resume' }`.
 *
 * Un corpo che porta due azioni insieme si rifiuta invece di indovinare quale
 * conta: su operazioni come queste, indovinare è la cosa peggiore.
 */
router.patch('/platform/tenants/:slug', asyncHandler(async (req: Request, res: Response) => {
  const slug = String(req.params['slug'])
  const body = req.body as { action?: unknown; name?: unknown }
  const chi = attore(req)

  switch (body.action) {
    case 'rename': {
      if (typeof body.name !== 'string') {
        res.status(400).json({ error: 'action "rename" requires a "name" string' })
        return
      }
      await conSessioneDiScrittura((s) => renameTenant(s, slug, body.name as string))
      log.warn({ slug, chi, nome: body.name }, 'console: tenant renamed')
      break
    }
    case 'suspend':
      await conSessioneDiScrittura((s) => suspendTenant(s, slug))
      log.warn({ slug, chi }, 'console: tenant SUSPENDED')
      break
    case 'resume':
      await conSessioneDiScrittura((s) => resumeTenant(s, slug))
      log.warn({ slug, chi }, 'console: tenant resumed')
      break
    default:
      res.status(400).json({ error: 'action must be one of: rename, suspend, resume' })
      return
  }
  const righe = await conSessioneDiLettura((s) => listTenants(s))
  res.json({ tenants: righe })
}))

/**
 * LA CANCELLAZIONE DEFINITIVA. Il corpo deve ripetere lo slug (`confirm`), e
 * il tenant deve essere già sospeso: le tre sbarre stanno in `purgeTenant`,
 * qui c'è solo il passaggio del realm da cancellare.
 *
 * Il realm Keycloak si cancella solo se l'API sa parlare con Keycloak: la
 * funzione arriva da qui, così `purgeTenant` resta provabile senza rete.
 */
router.delete('/platform/tenants/:slug', asyncHandler(async (req: Request, res: Response) => {
  const slug = String(req.params['slug'])
  const body = req.body as { confirm?: unknown }
  const chi = attore(req)
  if (typeof body.confirm !== 'string') {
    res.status(400).json({ error: 'the body must carry "confirm" with the tenant slug' })
    return
  }

  const { createKeycloakAdmin, keycloakConfigFromEnv } = await import('../scripts/lib/keycloakAdmin.js')
  const kc = createKeycloakAdmin(keycloakConfigFromEnv())
  const deleteRealm = async (realm: string): Promise<void> => {
    const token = await kc.getAdminToken()
    await kc.delete(token, `/admin/realms/${realm}`)
  }

  log.warn({ slug, chi }, 'console: PERMANENT tenant deletion requested')
  const esito = await conSessioneDiScrittura((s) => purgeTenant(s, slug, body.confirm as string, deleteRealm))
  log.warn({ slug, chi, ...esito }, 'console: tenant deleted')
  res.json({ slug, ...esito })
}))

router.use(restErrorHandler)

export { router as platformTenantsRouter }
