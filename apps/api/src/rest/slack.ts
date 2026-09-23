import { createHmac, timingSafeEqual } from 'crypto'
import { config } from '../lib/config.js'
import type { Request, Response } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { GraphQLError } from 'graphql'
import { logger } from '../lib/logger.js'
import { ciLabelPredicateForTenant } from '../lib/ciLabelsForTenant.js'
import { domainVocabulary } from '../lib/domainMatrix.js'
import { loadSlackInstallationByTeam, type SlackInstallationWithSecrets } from '@opengraphity/notifications'

/**
 * La sintassi del comando. Le severità sono quelle del vocabolario `severity`
 * DEL CLIENTE, e si elencano quando il tenant è noto; la parola chiave è
 * inglese per tutti. Prima: `apri` e `critical|high|medium|low` scritti qui,
 * quindi una severità aggiunta o rinominata dal cliente veniva rifiutata da
 * Slack (verifica «Cosa resta cablato», ondata 1).
 */
function usage(severities?: readonly string[]): string {
  return '`/og incident open <title> ci=<CI id or name> <' + (severities ? severities.join('|') : 'severity') + '>`'
}

/**
 * DI QUALE ORGANIZZAZIONE È LA RICHIESTA (ondata 8 di «Nulla cablato»).
 *
 * Il workspace (`team_id`) dice l'organizzazione che lo ha collegato; la firma
 * si verifica con il segreto di QUEL collegamento — l'app dell'organizzazione
 * (modo `token`) o l'app OpenGrafo della piattaforma (modo `app`). Prima c'era
 * un segreto unico e l'organizzazione si deduceva dall'utente Slack.
 * Un workspace non collegato, o una firma sbagliata: 401, e non si legge altro.
 */
async function authenticateSlackRequest(req: Request, teamId: string | undefined): Promise<SlackInstallationWithSecrets | null> {
  if (!teamId) return null
  const installation = await loadSlackInstallationByTeam(teamId)
  if (!installation) {
    logger.warn({ teamId }, '[slack] request from a Slack workspace that no organization has connected')
    return null
  }
  const signingSecret = installation.mode === 'token' ? installation.signingSecret : config.slackSigningSecret
  if (!signingSecret) {
    logger.error({ teamId, mode: installation.mode }, '[slack] no signing secret for this installation — rejecting request')
    return null
  }
  return verifySlackSignature(req, signingSecret) ? installation : null
}

export function verifySlackSignature(req: Request, signingSecret: string): boolean {
  const timestamp     = req.headers['x-slack-request-timestamp'] as string
  const slackSig      = req.headers['x-slack-signature'] as string

  if (!timestamp || !slackSig) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false

  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString() : ''
  const sigBase = `v0:${timestamp}:${rawBody}`
  const hmac    = createHmac('sha256', signingSecret).update(sigBase).digest('hex')
  const computed = `v0=${hmac}`

  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig))
  } catch {
    return false
  }
}

function parseUrlEncoded(req: Request): URLSearchParams {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString() : ''
  return new URLSearchParams(raw)
}

export async function handleSlackCommands(req: Request, res: Response): Promise<void> {
  const params     = parseUrlEncoded(req)
  const installation = await authenticateSlackRequest(req, params.get('team_id') ?? undefined)
  if (!installation) { res.status(401).json({ error: 'Unauthorized' }); return }

  const text       = params.get('text') ?? ''
  const slackUserId = params.get('user_id') ?? ''
  const parts = text.trim().split(/\s+/)

  if (parts[0] === 'incident' && parts[1] === 'open') {
    // Strict command parsing: no defaulted severity, no fabricated title, no
    // incident without its impacted CI (ITIL: mandatory, enforced by
    // incidentService) — a malformed command gets the usage back, not a
    // plausible incident.
    const severity = parts.length > 2 ? (parts[parts.length - 1] ?? '') : ''
    const words   = parts.slice(2, -1)
    const ciToken = words.find((w) => w.startsWith('ci='))
    const ciRef   = ciToken?.slice(3) ?? ''
    if (!ciRef) {
      res.json({ response_type: 'ephemeral', text: `⚠️ Impacted CI missing (required). Usage: ${usage()}` })
      return
    }
    const title = words.filter((w) => w !== ciToken).join(' ')
    if (!title) {
      res.json({ response_type: 'ephemeral', text: `⚠️ Title missing. Usage: ${usage()}` })
      return
    }

    const session = getSession(undefined, 'READ')
    let tenantId: string, userId: string, ciId: string | null
    try {
      // L'organizzazione è quella del workspace; la persona è quella con quel profilo Slack, in quell'organizzazione.
      const userResult = await session.executeRead((tx) =>
        tx.run('MATCH (u:User {slack_id: $slackUserId, tenant_id: $tenantId}) RETURN u LIMIT 1', { slackUserId, tenantId: installation.tenantId }),
      )
      if (!userResult.records.length) {
        res.json({ response_type: 'ephemeral', text: '⚠️ Link your Slack account in your profile settings.' })
        return
      }
      const u  = userResult.records[0]!.get('u').properties as Record<string, unknown>
      tenantId = installation.tenantId
      userId   = u['id']        as string

      // La severità è un valore del vocabolario del cliente.
      const severities = await domainVocabulary(tenantId, 'severity')
      if (!severities.includes(severity)) {
        res.json({ response_type: 'ephemeral', text: `⚠️ Severity missing or not valid. Usage: ${usage(severities)}` })
        return
      }

      // Resolve the CI by id or (case-insensitive) exact name, tenant-scoped.
      // Etichette dal metamodello del tenant: con la lista fissa un CI di un
      // tipo del cliente rispondeva «CI non trovato» in Slack (A-9).
      const ciPredicate = await ciLabelPredicateForTenant('ci', tenantId)
      const ciResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (ci:ConfigurationItem {tenant_id: $tenantId})
          WHERE ${ciPredicate} AND (ci.id = $ref OR toLower(ci.name) = toLower($ref))
          RETURN ci.id AS id LIMIT 2
        `, { tenantId, ref: ciRef }),
      )
      if (ciResult.records.length !== 1) {
        const reason = ciResult.records.length === 0 ? 'not found' : 'ambiguous (more CIs have this name: use the id)'
        res.json({ response_type: 'ephemeral', text: `⚠️ CI "${ciRef}" ${reason}.` })
        return
      }
      ciId = ciResult.records[0]!.get('id') as string
    } finally {
      await session.close()
    }

    // Same path as GraphQL/REST: number, workflow instance, SLA, watchers,
    // domain event, triggers — never a bare CREATE (:Incident).
    const { createIncident } = await import('../services/incidentService.js')
    let created: { id: string; number: string }
    try {
      created = await createIncident({ title, severity, affectedCIIds: [ciId] }, { tenantId, userId })
    } catch (err) {
      if (err instanceof GraphQLError && err.extensions['code'] === 'BAD_USER_INPUT') {
        res.json({ response_type: 'ephemeral', text: `⚠️ ${err.message}` })
        return
      }
      throw err
    }

    // The portal lists tickets by created_by; keep the Slack requester as the
    // reporter, exactly as before (incidentService records the watcher only).
    const wsession = getSession(undefined, 'WRITE')
    try {
      await wsession.executeWrite((tx) =>
        tx.run('MATCH (i:Incident {id: $id, tenant_id: $tenantId}) SET i.created_by = $userId', { id: created.id, tenantId, userId }),
      )
    } finally {
      await wsession.close()
    }

    res.json({ response_type: 'in_channel', text: `✅ Incident *${created.number}* — *${title}* created with severity *${severity}*. ID: \`${created.id}\`` })
    return
  }

  res.json({ response_type: 'ephemeral', text: `Command not recognised. Usage: ${usage()}` })
}

export async function handleSlackActions(req: Request, res: Response): Promise<void> {
  try {
    const params  = parseUrlEncoded(req)
    const payload = JSON.parse(params.get('payload') ?? '{}') as {
      actions?: Array<{ action_id: string; value: string }>
      user?: { id: string }
      team?: { id: string }
      response_url?: string
    }
    const installation = await authenticateSlackRequest(req, payload.team?.id)
    if (!installation) { res.status(401).json({ error: 'Unauthorized' }); return }

    const action      = payload.actions?.[0]
    const slackUserId = payload.user?.id
    const responseUrl = payload.response_url

    if (!action || !slackUserId) { res.sendStatus(200); return }

    const { action: actionType, incidentId } = JSON.parse(action.value ?? '{}') as {
      action: string; incidentId: string
    }

    const session = getSession(undefined, 'WRITE')
    try {
      // L'organizzazione è quella del workspace che ha firmato la richiesta.
      const userResult = await session.executeRead((tx) =>
        tx.run(
          'MATCH (u:User {slack_id: $slackUserId, tenant_id: $tenantId}) RETURN u LIMIT 1',
          { slackUserId, tenantId: installation.tenantId },
        ),
      )
      if (!userResult.records.length) {
        logger.warn({ slackUserId }, 'No user found for slack_id')
        if (responseUrl) {
          await fetch(responseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response_type: 'ephemeral', text: '⚠️ Link your Slack account in your profile settings.' }),
          })
        }
        res.sendStatus(200)
        return
      }
      const u        = userResult.records[0]!.get('u').properties as Record<string, unknown>
      const userId   = u['id']        as string
      const tenantId = installation.tenantId
      // Revisione totale · D-13: le azioni di Slack passano dalle stesse
      // strade dell'app. Prima «Assegnami» scriveva la proprietà
      // `i.assignee_id`, che nessuna pagina legge (l'assegnatario è la
      // relazione ASSIGNED_TO): l'operatore leggeva «✅ fatto» e l'incident
      // restava non assegnato, senza audit, evento né regola del team. E
      // «Risolvi» senza causa veniva rifiutato dalla guardia del workflow, con
      // un 200 muto.
      let outcome = `✅ Action *${actionType}* done on incident \`${incidentId}\`.`
      try {
        if (actionType === 'assign_me') {
          const { assignIncidentToUser } = await import('../services/incidentService.js')
          await assignIncidentToUser(incidentId, userId, { tenantId, userId })
        } else if (actionType === 'resolve') {
          const { resolveIncident } = await import('../services/incidentService.js')
          await resolveIncident(incidentId, { tenantId, userId })
        } else if (actionType === 'escalate') {
          const { escalateIncident } = await import('../services/incidentService.js')
          await escalateIncident(incidentId, { tenantId, userId })
        } else {
          outcome = `⚠️ Action *${actionType}* is not one this app performs.`
        }
      } catch (err) {
        // Il motivo del rifiuto arriva a chi ha premuto il pulsante: una
        // guardia del workflow («serve la causa»), l'assegnatario fuori dal
        // team, un ticket già chiuso.
        const reason = err instanceof Error ? err.message : String(err)
        logger.warn({ err, incidentId, tenantId, actionType }, '[slack] action refused')
        outcome = `⚠️ ${reason}`
      }

      if (responseUrl) {
        await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response_type: 'ephemeral', text: outcome }),
        })
      }
    } finally {
      await session.close()
    }
    res.sendStatus(200)
  } catch (err) {
    logger.error({ err }, 'slack actions error')
    if (!res.headersSent) res.sendStatus(200)
  }
}

/**
 * Ritorno da Slack dopo «Aggiungi a Slack» (ondata 8). Pubblico: lo `state`
 * firmato dice organizzazione, persona e pagina di ritorno. La pagina di ritorno
 * deve essere dell'organizzazione dello state, altrimenti non si reindirizza.
 */
export async function handleSlackOAuthCallback(req: Request, res: Response): Promise<void> {
  const code  = typeof req.query['code'] === 'string' ? req.query['code'] : ''
  const state = typeof req.query['state'] === 'string' ? req.query['state'] : ''
  const denied = typeof req.query['error'] === 'string' ? req.query['error'] : ''
  const { completeSlackOAuth, verifyInstallState } = await import('../lib/slackConnect.js')
  const { extractTenantFromHost } = await import('../auth/resolveAuth.js')

  let returnTo: URL | null = null
  try {
    const s = verifyInstallState(state)
    const url = new URL(s.r)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && extractTenantFromHost(url.host) === s.t) returnTo = url
  } catch { /* state illeggibile o scaduto: si risponde senza reindirizzare */ }
  if (!returnTo) {
    res.status(400).type('text/plain').send('Slack installation link is invalid or expired: start again from Integrations.')
    return
  }
  const back = (params: Record<string, string>) => {
    for (const [k, v] of Object.entries(params)) returnTo.searchParams.set(k, v)
    res.redirect(302, returnTo.toString())
  }
  if (denied || !code) { back({ slack: 'error', reason: denied || 'no_code' }); return }
  try {
    const { state: s, installation } = await completeSlackOAuth(code, state)
    const { audit } = await import('../lib/audit.js')
    void audit({ tenantId: s.t, userId: s.u, userEmail: s.name, role: '', permissions: new Set() }, 'slack.connected', 'SlackInstallation', installation.teamId, { mode: 'app', team: installation.teamName })
    back({ slack: 'connected' })
  } catch (err) {
    const key = (err as { extensions?: { i18n?: { key?: string } } }).extensions?.i18n?.key
    logger.error({ err }, '[slack] OAuth installation failed')
    back({ slack: 'error', reason: key ?? 'failed' })
  }
}
