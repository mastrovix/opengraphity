/**
 * COLLEGARE SLACK A UN'ORGANIZZAZIONE (ondata 8 di «Nulla cablato»).
 *
 * Due modi, tutti e due nella pagina Integrazioni (scelta del proprietario):
 *  - «Aggiungi a Slack»: l'app OpenGrafo (SLACK_CLIENT_ID/SECRET/SIGNING_SECRET
 *    della piattaforma) viene installata nel workspace con OAuth. Lo `state`
 *    del giro porta organizzazione, persona, scadenza e pagina di ritorno,
 *    firmati: il ritorno da Slack non si può falsificare;
 *  - token: l'admin incolla il token del bot e il segreto di firma di un'app
 *    Slack della propria organizzazione. Il token si PROVA (`auth.test`) prima
 *    di salvarlo.
 *
 * In entrambi i casi il token sta nel grafo cifrato, e un workspace appartiene
 * a una sola organizzazione. Quello che Slack chiama (comandi, azioni, ritorno)
 * vive su PUBLIC_BASE_URL: senza, Slack non raggiunge OpenGrafo.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { v4 as uuidv4 } from 'uuid'
import { getSession } from '@opengraphity/neo4j'
import { encryptSecret, loadSlackInstallation, secretsKeyConfigured, type SlackInstallation, type SlackInstallMode } from '@opengraphity/notifications'
import { config } from './config.js'
import { ValidationError } from './errors.js'
import type { GraphQLContext } from '../context.js'

const SLACK_API = 'https://slack.com/api'
const STATE_TTL_MS = 10 * 60_000
/** Quello che serve all'app: il comando `/og` e i messaggi nei canali. */
export const SLACK_APP_SCOPES = ['commands', 'chat:write'] as const

export interface SlackRequestUrls { commands: string; actions: string; oauthCallback: string }

export function slackRequestUrls(): SlackRequestUrls | null {
  const base = config.publicBaseUrl
  if (!base) return null
  return { commands: `${base}/api/slack/commands`, actions: `${base}/api/slack/actions`, oauthCallback: `${base}/api/slack/oauth/callback` }
}

/** Il collegamento con un clic si offre solo se la piattaforma ha la sua app Slack e un indirizzo pubblico. */
export function slackAppAvailable(): boolean {
  return Boolean(config.slackClientId && config.slackClientSecret && config.slackSigningSecret && config.publicBaseUrl)
}

async function slackApi<T extends { ok: boolean; error?: string }>(method: string, init: { token?: string; form?: Record<string, string> }): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: new URLSearchParams(init.form ?? {}).toString(),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`Slack ${method}: HTTP ${String(res.status)}`)
    return await res.json() as T
  } finally {
    clearTimeout(timer)
  }
}

// ── Lo state del giro OAuth ─────────────────────────────────────────────────────

interface InstallState { t: string; u: string; name: string; r: string; exp: number; n: string }

function stateSecret(): string {
  const s = config.slackClientSecret
  if (!s) throw new Error('SLACK_CLIENT_SECRET is not set: the one-click Slack installation is not available')
  return s
}

export function signInstallState(state: Omit<InstallState, 'exp' | 'n'>, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...state, exp: now + STATE_TTL_MS, n: randomBytes(8).toString('hex') })).toString('base64url')
  const mac = createHmac('sha256', stateSecret()).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verifyInstallState(raw: string, now = Date.now()): InstallState {
  const [body, mac] = raw.split('.')
  if (!body || !mac) throw new ValidationError('Invalid Slack installation state', { key: 'errors.slack.badState', params: {} })
  const expected = createHmac('sha256', stateSecret()).update(body).digest('base64url')
  const a = Buffer.from(mac), b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new ValidationError('Invalid Slack installation state', { key: 'errors.slack.badState', params: {} })
  const state = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as InstallState
  if (state.exp < now) throw new ValidationError('The Slack installation took too long: start again', { key: 'errors.slack.stateExpired', params: {} })
  return state
}

/**
 * L'indirizzo di Slack a cui mandare l'admin. `returnTo` è la pagina Integrazioni
 * da cui è partito, dove torna dopo l'approvazione.
 */
export function slackAuthorizeUrl(ctx: Pick<GraphQLContext, 'tenantId' | 'userId' | 'userEmail'>, returnTo: string): string {
  const urls = slackRequestUrls()
  if (!slackAppAvailable() || !urls) {
    throw new ValidationError('The OpenGrafo Slack app is not configured on this platform', { key: 'errors.slack.appNotConfigured', params: {} })
  }
  const state = signInstallState({ t: ctx.tenantId, u: ctx.userId, name: ctx.userEmail, r: returnTo })
  const q = new URLSearchParams({ client_id: config.slackClientId!, scope: SLACK_APP_SCOPES.join(','), redirect_uri: urls.oauthCallback, state })
  return `https://slack.com/oauth/v2/authorize?${q.toString()}`
}

// ── Salvataggio ─────────────────────────────────────────────────────────────────

interface NewInstallation {
  tenantId: string; teamId: string; teamName: string; mode: SlackInstallMode
  botToken: string; signingSecret: string | null; botUserId: string | null
  installedBy: string; installedByName: string | null
}

async function saveInstallation(i: NewInstallation): Promise<SlackInstallation> {
  if (!secretsKeyConfigured()) {
    throw new ValidationError('SECRETS_ENCRYPTION_KEY is not set: Slack tokens cannot be stored', { key: 'errors.slack.noSecretsKey', params: {} })
  }
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite(async (tx) => {
      const other = await tx.run(
        // tenant-ok: un workspace appartiene a una sola organizzazione, il controllo guarda le altre
        'MATCH (s:SlackInstallation {team_id: $teamId}) WHERE s.tenant_id <> $tenantId RETURN s.tenant_id AS t LIMIT 1',
        { teamId: i.teamId, tenantId: i.tenantId },
      )
      if (other.records.length) {
        throw new ValidationError(`The Slack workspace "${i.teamName}" is already connected to another organization`, { key: 'errors.slack.teamTaken', params: { team: i.teamName } })
      }
      await tx.run(`
        MERGE (s:SlackInstallation {tenant_id: $tenantId})
        ON CREATE SET s.id = $id
        SET s.team_id = $teamId, s.team_name = $teamName, s.mode = $mode, s.bot_user_id = $botUserId,
            s.bot_token_enc = $botTokenEnc, s.signing_secret_enc = $signingSecretEnc,
            s.installed_by = $installedBy, s.installed_by_name = $installedByName, s.installed_at = $now
      `, {
        id: uuidv4(), tenantId: i.tenantId, teamId: i.teamId, teamName: i.teamName, mode: i.mode, botUserId: i.botUserId,
        botTokenEnc: encryptSecret(i.botToken), signingSecretEnc: i.signingSecret ? encryptSecret(i.signingSecret) : null,
        installedBy: i.installedBy, installedByName: i.installedByName, now: new Date().toISOString(),
      })
    })
  } finally {
    await session.close()
  }
  const saved = await loadSlackInstallation(i.tenantId)
  if (!saved) throw new Error(`SlackInstallation of ${i.tenantId} not found right after saving it`)
  return saved
}

/** Ritorno da Slack dopo «Aggiungi a Slack». Restituisce organizzazione, pagina di ritorno e installazione. */
export async function completeSlackOAuth(code: string, rawState: string): Promise<{ state: InstallState; installation: SlackInstallation }> {
  const state = verifyInstallState(rawState)
  const urls = slackRequestUrls()
  if (!slackAppAvailable() || !urls) {
    throw new ValidationError('The OpenGrafo Slack app is not configured on this platform', { key: 'errors.slack.appNotConfigured', params: {} })
  }
  const res = await slackApi<{ ok: boolean; error?: string; access_token?: string; bot_user_id?: string; team?: { id: string; name: string } }>('oauth.v2.access', {
    form: { client_id: config.slackClientId!, client_secret: config.slackClientSecret!, code, redirect_uri: urls.oauthCallback },
  })
  if (!res.ok || !res.access_token || !res.team) {
    throw new ValidationError(`Slack refused the installation: ${res.error ?? 'no token'}`, { key: 'errors.slack.oauthRefused', params: { error: res.error ?? '' } })
  }
  const installation = await saveInstallation({
    tenantId: state.t, teamId: res.team.id, teamName: res.team.name, mode: 'app',
    botToken: res.access_token, signingSecret: null, botUserId: res.bot_user_id ?? null,
    installedBy: state.u, installedByName: state.name,
  })
  return { state, installation }
}

/** Il collegamento con l'app dell'organizzazione: il token si prova prima di salvarlo. */
export async function connectSlackWithToken(ctx: Pick<GraphQLContext, 'tenantId' | 'userId' | 'userEmail'>, botToken: string, signingSecret: string): Promise<SlackInstallation> {
  const token = botToken.trim()
  const secret = signingSecret.trim()
  if (!token.startsWith('xoxb-')) {
    throw new ValidationError('The bot token of a Slack app starts with xoxb-', { key: 'errors.slack.badToken', params: {} })
  }
  if (!/^[0-9a-f]{32}$/i.test(secret)) {
    throw new ValidationError('The signing secret of a Slack app is 32 hexadecimal characters', { key: 'errors.slack.badSigningSecret', params: {} })
  }
  const test = await slackApi<{ ok: boolean; error?: string; team_id?: string; team?: string; user_id?: string }>('auth.test', { token })
  if (!test.ok || !test.team_id) {
    throw new ValidationError(`Slack did not accept the token: ${test.error ?? 'unknown error'}`, { key: 'errors.slack.tokenRefused', params: { error: test.error ?? '' } })
  }
  return saveInstallation({
    tenantId: ctx.tenantId, teamId: test.team_id, teamName: test.team ?? test.team_id, mode: 'token',
    botToken: token, signingSecret: secret, botUserId: test.user_id ?? null,
    installedBy: ctx.userId, installedByName: ctx.userEmail,
  })
}

export async function disconnectSlack(tenantId: string): Promise<SlackInstallation | null> {
  const current = await loadSlackInstallation(tenantId)
  if (!current) return null
  const session = getSession(undefined, 'WRITE')
  try {
    await session.executeWrite((tx) => tx.run('MATCH (s:SlackInstallation {tenant_id: $tenantId}) DETACH DELETE s', { tenantId }))
  } finally {
    await session.close()
  }
  return current
}
