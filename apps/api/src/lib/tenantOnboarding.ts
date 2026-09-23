/**
 * COME NASCE UN TENANT, in un posto solo (17 set 2026).
 *
 * Questa logica viveva dentro `scripts/onboard-tenant.ts`, e la console di
 * piattaforma avrebbe dovuto riscriverla per creare un tenant dalla pagina.
 * Due copie di «come nasce un cliente» sarebbero divergute al primo cambio —
 * un client Keycloak aggiunto da una parte e non dall'altra, e un tenant che
 * nasce a metà solo se creato dalla strada sbagliata. Quindi la logica sta qui
 * e i due chiamanti la usano: lo script (che stampa) e la console (che mostra).
 *
 * ## Il canale invece di `console.log`
 * Ogni passo racconta cosa ha fatto attraverso `onStep`. Lo script lo manda a
 * schermo con le sue icone, la console lo raccoglie e lo mostra nella pagina:
 * chi crea un tenant deve poter leggere che cosa è stato creato e che cosa era
 * già lì, perché l'operazione è IDEMPOTENTE e «già esistente» non è un errore.
 *
 * ## La password si consegna SUBITO
 * `onPassword` viene chiamato nell'istante dopo averla impostata su Keycloak,
 * prima di qualunque altro passo. È una lezione già pagata in questo progetto:
 * la password generata veniva mostrata alla fine, un passo successivo è
 * crollato, e il primo amministratore di un cliente vero è rimasto chiuso
 * fuori — irrecuperabile, perché un secondo giro salta la creazione e lascia la
 * password invariata. Fra l'impostare e il consegnare non ci deve stare niente
 * che possa fallire.
 *
 * ## Additiva e idempotente
 * Nessun passo riallinea quello che trova: un realm, un client, un workflow o
 * una matrice già presenti vengono LASCIATI COM'ERANO, perché potrebbero
 * essere personalizzazioni del cliente. Rilanciarla su un tenant esistente è
 * sicuro, e lo dice passo per passo.
 *
 * L'unica eccezione, e resta additiva: gli INDIRIZZI DI RITORNO dei due
 * client. Se mancano, il tenant non è raggiungibile affatto — quindi si
 * aggiungono quelli che servono, senza togliere niente di quello che c'era.
 * Vedi `assicuraRitorni` più sotto.
 */
import { v4 as uuidv4 } from 'uuid'
import { getSession, toNumber } from '@opengraphity/neo4j'
import { USERS_ADMIN_PERMISSION, type Tenant } from '@opengraphity/types'
import { seedSystemEnumTypes } from './seedEnumTypes.js'
import { provisionTenantData } from './provisionTenantData.js'
import { DEFAULT_EVENT_POLICY_JSON } from './eventPolicy.js'
import { INITIAL_PASSWORD_RULES, realmPasswordSettings } from './tenantLogin.js'
import { PLAN_SETTINGS } from './tenantPlans.js'
import { CATALOG_FORM_LIMIT_DEFAULTS } from './catalogFormLimits.js'
import type { KeycloakAdmin } from '../scripts/lib/keycloakAdmin.js'
import { findUserIdByEmail } from '../scripts/lib/keycloakAdmin.js'

/** Quello che serve per fare nascere un tenant. Gli stessi campi dello script. */
export interface TenantSpec {
  slug:       string
  tenantName: string
  plan:       Tenant['plan']
  timezone:   string
  email:      string
  firstName:  string
  lastName:   string
  adminRole:  string
  domain:     string
  /** Produzione: solo HTTPS e nessun jolly `*.localhost` nei redirect. */
  production: boolean
  piIp:       string | undefined
}

/** La password del primo amministratore: chi chiama la sceglie o la genera. */
export interface AdminPassword {
  value:     string
  /** `true` obbliga il cambio al primo accesso: è così per quelle generate. */
  temporary: boolean
}

export interface OnboardCallbacks {
  /** Un passo compiuto, in inglese: lo scrive lo script e lo mostra la console. */
  onStep?: (linea: string) => void
  /**
   * La password, CONSEGNATA SUBITO dopo averla impostata. Chiamata solo quando
   * l'utente è stato creato adesso: su un utente già esistente la password non
   * si tocca, e inventarne una da mostrare sarebbe una bugia.
   */
  onPassword?: (email: string, password: AdminPassword) => void
}

export interface OnboardResult {
  realmCreated:   boolean
  webClient:      'created' | 'existing'
  portalClient:   'created' | 'existing'
  adminCreated:   boolean
  tenantCreated:  boolean
  steps:          string[]
}

export async function onboardTenant(
  kc: KeycloakAdmin,
  spec: TenantSpec,
  password: AdminPassword,
  cb: OnboardCallbacks = {},
): Promise<OnboardResult> {
  const steps: string[] = []
  const passo = (linea: string): void => { steps.push(linea); cb.onStep?.(linea) }

  const token = await kc.getAdminToken()

  // ── Keycloak: realm ────────────────────────────────────────────────────────
  const realm = await kc.post(token, '/admin/realms', {
    realm:       spec.slug,
    enabled:     true,
    sslRequired: spec.production ? 'external' : 'none',
    displayName: spec.slug,
    // D70: a realm with no password rules accepts a one-character password and never locks an account.
    ...realmPasswordSettings(INITIAL_PASSWORD_RULES, null),
  })
  passo(realm.created ? `realm "${spec.slug}" created` : `realm "${spec.slug}" already existed — left as it was`)

  // ── Keycloak: i due client delle app ───────────────────────────────────────
  /*
   * IL CLIENT CHE C'ERA GIÀ (20 set 2026, trovato creando `opengrafo` su un
   * realm rimasto da una vecchia installazione).
   *
   * «Non riallinea quello che trova» è la regola giusta — un client può
   * portare personalizzazioni del cliente — ma ha una conseguenza che rende
   * il tenant INUTILIZZABILE: se il client esisteva con altri indirizzi di
   * ritorno, l'onboarding scrive «already existed — left as it was», dichiara
   * il tenant creato, e chi ci entra riceve da Keycloak «Invalid parameter:
   * redirect_uri». Il tenant in Neo4j c'è, l'utente c'è, e non si accede.
   *
   * La correzione resta ADDITIVA, che è il punto della regola: non si
   * sostituisce niente, si AGGIUNGONO gli indirizzi mancanti. Aggiungere non
   * può togliere una personalizzazione. E si dice nel passo, perché un
   * onboarding che tocca qualcosa in silenzio è peggio di uno che non tocca.
   */
  const assicuraRitorni = async (
    clientId: string,
    redirectUris: readonly string[],
    webOrigins: readonly string[],
  ): Promise<void> => {
    const trovati = await kc.get<Array<{ id: string; redirectUris?: string[]; webOrigins?: string[] }>>(
      token, `/admin/realms/${spec.slug}/clients?clientId=${encodeURIComponent(clientId)}`,
    )
    const cliente = trovati[0]
    if (cliente == null) {
      passo(`client "${clientId}" not found after creation — nothing to reconcile`)
      return
    }
    const mancanti = redirectUris.filter((u) => !(cliente.redirectUris ?? []).includes(u))
    const originiMancanti = webOrigins.filter((o) => !(cliente.webOrigins ?? []).includes(o))
    if (mancanti.length === 0 && originiMancanti.length === 0) {
      passo(`client "${clientId}": redirect URIs already complete`)
      return
    }
    await kc.put(token, `/admin/realms/${spec.slug}/clients/${cliente.id}`, {
      redirectUris: [...(cliente.redirectUris ?? []), ...mancanti],
      webOrigins:   [...(cliente.webOrigins ?? []), ...originiMancanti],
    })
    passo(`client "${clientId}": ${mancanti.length} redirect URI(s) added — it existed with a different configuration and the tenant would not have been reachable`)
  }

  const ritorniWeb = [
    `https://${spec.slug}.${spec.domain}/*`,
    ...(spec.piIp ? [`https://${spec.slug}.${spec.piIp}.nip.io/*`] : []),
    ...(spec.production ? [] : [
      `http://${spec.slug}.localhost/*`,
      `http://${spec.slug}.localhost:5173/*`,
      'http://*.localhost/*',
      'http://*.localhost:5173/*',
      'http://*.localhost:8080/*',
    ]),
  ]
  const originiWeb = spec.production ? [`https://${spec.slug}.${spec.domain}`] : ['+']

  const web = await kc.post(token, `/admin/realms/${spec.slug}/clients`, {
    clientId:     'opengrafo-web',
    publicClient: true,
    enabled:      true,
    redirectUris: ritorniWeb,
    webOrigins:   originiWeb,
  })
  passo(web.created ? 'client "opengrafo-web" created' : 'client "opengrafo-web" already existed — left as it was')
  if (!web.created) await assicuraRitorni('opengrafo-web', ritorniWeb, originiWeb)

  const ritorniPortale = [
    `https://portal.${spec.slug}.${spec.domain}/*`,
    ...(spec.piIp ? [`https://portal.${spec.slug}.${spec.piIp}.nip.io/*`] : []),
    ...(spec.production ? [] : [
      `http://portal.${spec.slug}.localhost/*`,
      `http://portal.${spec.slug}.localhost:5174/*`,
      'http://*.localhost/*',
      'http://*.localhost:5174/*',
      'http://localhost:5174/*',
    ]),
  ]
  const originiPortale = spec.production ? [`https://portal.${spec.slug}.${spec.domain}`] : ['+']

  const portal = await kc.post(token, `/admin/realms/${spec.slug}/clients`, {
    clientId:     'opengrafo-portal',
    publicClient: true,
    enabled:      true,
    redirectUris: ritorniPortale,
    webOrigins:   originiPortale,
  })
  passo(portal.created ? 'client "opengrafo-portal" created' : 'client "opengrafo-portal" already existed — left as it was')
  if (!portal.created) await assicuraRitorni('opengrafo-portal', ritorniPortale, originiPortale)

  // ── Keycloak: il primo amministratore ──────────────────────────────────────
  const utente = await kc.post(token, `/admin/realms/${spec.slug}/users`, {
    username:      spec.email,
    email:         spec.email,
    emailVerified: true,
    enabled:       true,
    firstName:     spec.firstName,
    lastName:      spec.lastName,
  })
  const keycloakUserId = utente.created && utente.id
    ? utente.id
    : await findUserIdByEmail(kc, token, spec.slug, spec.email)

  if (utente.created) {
    await kc.setPassword(token, spec.slug, keycloakUserId, password.value, password.temporary)
    /*
     * QUI, e non alla fine. Vedi il commento in testa: fra l'impostare e il
     * consegnare non ci deve stare niente che possa fallire, altrimenti il
     * primo amministratore di un cliente resta chiuso fuori senza rimedio.
     */
    cb.onPassword?.(spec.email, password)
    passo(`admin user "${spec.email}" created in Keycloak, with a ${password.temporary ? 'temporary' : 'permanent'} password`)
  } else {
    passo(`admin user "${spec.email}" already existed in Keycloak — password left untouched`)
  }

  // ── Neo4j ──────────────────────────────────────────────────────────────────
  const session = getSession(undefined, 'WRITE')
  const now = new Date().toISOString()
  try {
    const settings = PLAN_SETTINGS[spec.plan]
    const tenantResult = await session.executeWrite((tx) =>
      tx.run(
        `MERGE (t:Tenant {id: $id})
         ON CREATE SET
           t.slug              = $slug,
           t.name              = $name,
           t.plan              = $plan,
           t.timezone          = $timezone,
           t.sla_enabled       = $slaEnabled,
           t.scripting_enabled = $scriptingEnabled,
           t.max_users         = $maxUsers,
           t.max_ci            = $maxCi,
           t.max_service_maps  = $maxServiceMaps,
           t.max_form_fields   = $maxFormFields,
           t.max_form_fields_per_form = $maxFormFieldsPerForm,
           t.max_form_table_rows = $maxFormTableRows,
           t.event_policy      = $eventPolicy,
           t.created_at        = $now
         RETURN (t.created_at = $now) AS wasCreated`,
        {
          id: spec.slug, slug: spec.slug, name: spec.tenantName, plan: spec.plan,
          timezone: spec.timezone, now,
          slaEnabled: settings.sla_enabled, scriptingEnabled: settings.scripting_enabled,
          maxUsers: settings.max_users, maxCi: settings.max_ci,
          maxServiceMaps: settings.max_service_maps,
          maxFormFields: CATALOG_FORM_LIMIT_DEFAULTS.maxLibraryFields,
          maxFormFieldsPerForm: CATALOG_FORM_LIMIT_DEFAULTS.maxFieldsPerForm,
          maxFormTableRows: CATALOG_FORM_LIMIT_DEFAULTS.maxTableRows,
          eventPolicy: DEFAULT_EVENT_POLICY_JSON,
        },
      ),
    )
    const tenantRow = tenantResult.records[0]
    if (!tenantRow) throw new Error(`MERGE (:Tenant {id: "${spec.slug}"}) returned no rows — unexpected state`)
    const tenantCreated = tenantRow.get('wasCreated') as boolean
    passo(tenantCreated
      ? `tenant node created: ${spec.slug} (plan ${spec.plan}, timezone ${spec.timezone})`
      : `tenant node already existed: ${spec.slug} — left as it was`)

    const userId = uuidv4()
    const userResult = await session.executeWrite((tx) =>
      tx.run(
        `MERGE (u:User {email: $email, tenant_id: $tenantId})
         ON CREATE SET
           u.id         = $id,
           u.name       = $name,
           u.role       = $role,
           u.active     = true,
           u.created_at = $now,
           u.updated_at = $now
         RETURN (u.created_at = $now) AS wasCreated`,
        { email: spec.email, tenantId: spec.slug, id: userId,
          name: `${spec.firstName} ${spec.lastName}`, role: spec.adminRole, now },
      ),
    )
    const userCreated = userResult.records[0]?.get('wasCreated') as boolean
    passo(userCreated ? `admin user node created: ${spec.email}` : `admin user node already existed: ${spec.email} — left as it was`)

    await seedSystemEnumTypes(session)
    passo("shipped vocabularies verified on tenant_id='system' (no per-tenant copy)")

    const provisioned = await provisionTenantData(session, spec.slug, { userId })
    passo(provisioned.rolesCreated.length
      ? `factory roles created: ${provisioned.rolesCreated.join(', ')}`
      : 'factory roles already present — left as they were')

    /*
     * Il ruolo del primo amministratore deve gestire persone e ruoli anche nel
     * DATO: su un tenant già esistente quel ruolo può essere stato modificato,
     * e un primo admin che non può creare utenti è un tenant inutilizzabile.
     */
    const adminRoleRes = await session.executeRead((tx) => tx.run(
      'MATCH (r:Role {tenant_id: $tenantId, key: $key}) RETURN $perm IN r.permissions AS ok',
      { tenantId: spec.slug, key: spec.adminRole, perm: USERS_ADMIN_PERMISSION },
    ))
    if (adminRoleRes.records[0]?.get('ok') !== true) {
      throw new Error(
        `The role "${spec.adminRole}" of "${spec.slug}" does not manage people and roles (${USERS_ADMIN_PERMISSION}): `
        + 'the first administrator could not do it. Fix the role on the Roles page, or pick another one.',
      )
    }

    passo(provisioned.dashboardCreated ? 'default dashboard created' : 'dashboard already existed — left as it was')
    passo(`notification rules: ${provisioned.notificationRulesCreated} created`)
    passo(provisioned.matricesCreated.length === 0
      ? 'domain matrices already present — left as they were'
      : `domain matrices created: ${provisioned.matricesCreated.join(', ')}`)
    for (const w of provisioned.workflows) {
      passo(`workflow "${w.name}"${w.created === false ? ' — already present, left as it was' : ''}`)
    }

    /*
     * Quello che resta a una PERSONA: team, change manager, domande di
     * assessment. Non è un fallimento — il provisioning crea i dati di
     * FABBRICA, e quelli sono configurazione del cliente — ma si dice, perché
     * un tenant senza team non permette di creare una change e chi lo ha appena
     * creato deve saperlo adesso, non al primo tentativo.
     */
    for (const gap of provisioned.gapsLeft) {
      passo(`still to configure by a person: ${gap.kind}${gap.params ? ` (${Object.values(gap.params).join(', ')})` : ''}`)
    }

    // I tipi di CI condivisi: non si creano qui, si VERIFICANO. Assenti, il
    // tenant nasce senza CMDB e nessuno lo direbbe.
    for (const [scope, seedScript] of [['base', 'seed-metamodel.ts'], ['itil', 'seed-itil-metamodel.ts']] as const) {
      const res = await session.executeRead((tx) =>
        tx.run(
          // I tipi di CI spediti col prodotto sono CONDIVISI fra i tenant
          // (`scope` 'base' e 'itil', nessun `tenant_id`): qui non si legge il
          // dato di un cliente, si CONTA se il metamodello comune esiste.
          // Filtrarli per tenant non troverebbe niente, e il tenant nascerebbe
          // senza CMDB con un messaggio che dice che è tutto a posto.
          `MATCH (t:CITypeDefinition)
           // tenant-ok(condivisi): i tipi spediti vivono su 'base'/'itil', senza tenant_id
           WHERE t.scope = $scope AND t.active = true RETURN count(t) AS total`,
          { scope },
        ),
      )
      const count = toNumber(res.records[0]?.get('total') ?? 0)
      passo(count === 0
        ? `WARNING: no CITypeDefinition with scope='${scope}' — run ${seedScript}, the CMDB would be empty`
        : `${count} CITypeDefinition ${scope} available`)
    }

    return {
      realmCreated:  realm.created,
      webClient:     web.created ? 'created' : 'existing',
      portalClient:  portal.created ? 'created' : 'existing',
      adminCreated:  utente.created,
      tenantCreated,
      steps,
    }
  } finally {
    await session.close()
  }
}
