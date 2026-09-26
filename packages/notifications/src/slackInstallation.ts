/**
 * SLACK DI UN'ORGANIZZAZIONE (ondata 8 di «Nulla cablato»).
 *
 * Prima c'era un solo token Slack per tutta la piattaforma
 * (`SLACK_BOT_TOKEN`): i messaggi di ogni organizzazione partivano dallo
 * stesso bot, e il comando `/og` riconosceva l'organizzazione solo
 * dall'utente Slack collegato. Ora ogni organizzazione collega il proprio
 * workspace, in uno di due modi:
 *  - `app`: l'app OpenGrafo, installata con «Aggiungi a Slack» (OAuth);
 *    il segreto di firma è quello dell'app, della piattaforma;
 *  - `token`: un'app Slack dell'organizzazione, di cui l'admin incolla il
 *    token del bot e il segreto di firma.
 *
 * `(:SlackInstallation {tenant_id, team_id, team_name, mode, bot_token_enc,
 * signing_secret_enc, bot_user_id, installed_by, installed_by_name, installed_at})`,
 * una per organizzazione; un workspace appartiene a una sola organizzazione.
 * I segreti sono cifrati (`secretBox.ts`).
 */
import { getSession } from '@opengraphity/neo4j'
import { decryptSecret } from './secretBox.js'

export type SlackInstallMode = 'app' | 'token'

export interface SlackInstallation {
  tenantId:        string
  teamId:          string
  teamName:        string
  mode:            SlackInstallMode
  botUserId:       string | null
  installedAt:     string
  installedByName: string | null
}

export interface SlackInstallationWithSecrets extends SlackInstallation {
  botToken:      string
  /** Solo nel modo `token`: il segreto di firma dell'app dell'organizzazione. */
  signingSecret: string | null
}

type Row = { get: (k: string) => unknown }

function view(r: Row): SlackInstallation {
  const mode = r.get('mode')
  if (mode !== 'app' && mode !== 'token') throw new Error(`SlackInstallation of ${String(r.get('tenantId'))} has an unknown mode ${JSON.stringify(mode)}`)
  return {
    tenantId:        r.get('tenantId') as string,
    teamId:          r.get('teamId') as string,
    teamName:        (r.get('teamName') ?? '') as string,
    mode,
    botUserId:       (r.get('botUserId') ?? null) as string | null,
    installedAt:     r.get('installedAt') as string,
    installedByName: (r.get('installedByName') ?? null) as string | null,
  }
}

const RETURN = `RETURN s.tenant_id AS tenantId, s.team_id AS teamId, s.team_name AS teamName, s.mode AS mode,
  s.bot_user_id AS botUserId, s.installed_at AS installedAt, s.installed_by_name AS installedByName,
  s.bot_token_enc AS botTokenEnc, s.signing_secret_enc AS signingSecretEnc`

async function readOne(cypher: string, params: Record<string, unknown>): Promise<Row | null> {
  const session = getSession(undefined, 'READ')
  try {
    const res = await session.executeRead((tx) => tx.run(cypher, params))
    return res.records[0] ?? null
  } finally {
    await session.close()
  }
}

/** L'installazione dell'organizzazione, senza segreti; `null` se Slack non è collegato. */
export async function loadSlackInstallation(tenantId: string): Promise<SlackInstallation | null> {
  const r = await readOne(`MATCH (s:SlackInstallation {tenant_id: $tenantId}) ${RETURN}`, { tenantId })
  return r ? view(r) : null
}

function withSecrets(r: Row): SlackInstallationWithSecrets {
  const signing = r.get('signingSecretEnc') as string | null
  return { ...view(r), botToken: decryptSecret(r.get('botTokenEnc') as string), signingSecret: signing ? decryptSecret(signing) : null }
}

/** Il workspace da cui arriva un comando: dice di quale organizzazione è. */
export async function loadSlackInstallationByTeam(teamId: string): Promise<SlackInstallationWithSecrets | null> {
  // tenant-ok(pre-auth): pre-auth, l'organizzazione è quella che ha collegato il workspace
  const r = await readOne(`MATCH (s:SlackInstallation {team_id: $teamId}) ${RETURN}`, { teamId })
  return r ? withSecrets(r) : null
}

/** Il token del bot dell'organizzazione. Senza Slack collegato è un errore che lo dice. */
export async function slackBotToken(tenantId: string): Promise<string> {
  const r = await readOne(`MATCH (s:SlackInstallation {tenant_id: $tenantId}) ${RETURN}`, { tenantId })
  if (!r) throw new Error(`Slack is not connected for organization ${tenantId}: connect the workspace in External connections → Integrations`)
  return withSecrets(r).botToken
}
