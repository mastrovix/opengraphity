import { createHmac, timingSafeEqual } from 'crypto'
import type { Request, Response } from 'express'
import { getSession } from '@opengraphity/neo4j'
import { GraphQLError } from 'graphql'
import { logger } from '../lib/logger.js'
import { ciLabelPredicate } from '../lib/ciLabels.js'

const VALID_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const
const USAGE = '`/og incident apri <titolo> ci=<id-o-nome-CI> <' + VALID_SEVERITIES.join('|') + '>`'

function verifySlackSignature(req: Request): boolean {
  const signingSecret = process.env['SLACK_SIGNING_SECRET']
  if (!signingSecret) {
    logger.error('[slack] SLACK_SIGNING_SECRET not configured — rejecting request')
    return false
  }
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
  if (!verifySlackSignature(req)) { res.status(401).json({ error: 'Unauthorized' }); return }

  const params     = parseUrlEncoded(req)
  const text       = params.get('text') ?? ''
  const slackUserId = params.get('user_id') ?? ''
  const parts = text.trim().split(/\s+/)

  if (parts[0] === 'incident' && parts[1] === 'apri') {
    // Strict command parsing: no defaulted severity, no fabricated title, no
    // incident without its impacted CI (ITIL: mandatory, enforced by
    // incidentService) — a malformed command gets the usage back, not a
    // plausible incident.
    const severity = parts[parts.length - 1] ?? ''
    if (!(VALID_SEVERITIES as readonly string[]).includes(severity)) {
      res.json({ response_type: 'ephemeral', text: `⚠️ Severity mancante o non valida. Usa: ${USAGE}` })
      return
    }
    const words   = parts.slice(2, -1)
    const ciToken = words.find((w) => w.startsWith('ci='))
    const ciRef   = ciToken?.slice(3) ?? ''
    if (!ciRef) {
      res.json({ response_type: 'ephemeral', text: `⚠️ CI impattato mancante (obbligatorio). Usa: ${USAGE}` })
      return
    }
    const title = words.filter((w) => w !== ciToken).join(' ')
    if (!title) {
      res.json({ response_type: 'ephemeral', text: `⚠️ Titolo mancante. Usa: ${USAGE}` })
      return
    }

    const session = getSession(undefined, 'READ')
    let tenantId: string, userId: string, ciId: string | null
    try {
      // Resolve Slack user → tenant
      const userResult = await session.executeRead((tx) =>
        tx.run('MATCH (u:User {slack_id: $slackUserId}) RETURN u LIMIT 1', { slackUserId }), // tenant-ok: pre-auth, il tenant è quello dell'utente Slack collegato
      )
      if (!userResult.records.length) {
        res.json({ response_type: 'ephemeral', text: '⚠️ Collega il tuo account Slack nelle impostazioni profilo.' })
        return
      }
      const u  = userResult.records[0]!.get('u').properties as Record<string, unknown>
      tenantId = u['tenant_id'] as string
      userId   = u['id']        as string

      // Resolve the CI by id or (case-insensitive) exact name, tenant-scoped.
      const ciResult = await session.executeRead((tx) =>
        tx.run(`
          MATCH (ci {tenant_id: $tenantId})
          WHERE ${ciLabelPredicate('ci')} AND (ci.id = $ref OR toLower(ci.name) = toLower($ref))
          RETURN ci.id AS id LIMIT 2
        `, { tenantId, ref: ciRef }),
      )
      if (ciResult.records.length !== 1) {
        const reason = ciResult.records.length === 0 ? 'non trovato' : 'ambiguo (più CI con questo nome: usa l\'id)'
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

    res.json({ response_type: 'in_channel', text: `✅ Incident *${created.number}* — *${title}* creato con severity *${severity}*. ID: \`${created.id}\`` })
    return
  }

  res.json({ response_type: 'ephemeral', text: `Comando non riconosciuto. Usa: ${USAGE}` })
}

export async function handleSlackActions(req: Request, res: Response): Promise<void> {
  try {
    if (!verifySlackSignature(req)) { res.status(401).json({ error: 'Unauthorized' }); return }

    const params  = parseUrlEncoded(req)
    const payload = JSON.parse(params.get('payload') ?? '{}') as {
      actions?: Array<{ action_id: string; value: string }>
      user?: { id: string }
      response_url?: string
    }

    const action      = payload.actions?.[0]
    const slackUserId = payload.user?.id
    const responseUrl = payload.response_url

    if (!action || !slackUserId) { res.sendStatus(200); return }

    const { action: actionType, incidentId } = JSON.parse(action.value ?? '{}') as {
      action: string; incidentId: string
    }

    const session = getSession(undefined, 'WRITE')
    try {
      // Look up by slack_id only — tenantId derived from the user node (slack_id is unique)
      const userResult = await session.executeRead((tx) =>
        tx.run(
          'MATCH (u:User {slack_id: $slackUserId}) RETURN u LIMIT 1', // tenant-ok: pre-auth, tenant derivato dall'utente Slack collegato
          { slackUserId },
        ),
      )
      if (!userResult.records.length) {
        logger.warn({ slackUserId }, 'No user found for slack_id')
        if (responseUrl) {
          await fetch(responseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ response_type: 'ephemeral', text: '⚠️ Collega il tuo account Slack nelle impostazioni profilo.' }),
          })
        }
        res.sendStatus(200)
        return
      }
      const u        = userResult.records[0]!.get('u').properties as Record<string, unknown>
      const userId   = u['id']        as string
      const tenantId = u['tenant_id'] as string
      const now      = new Date().toISOString()
      if (actionType === 'assign_me') {
        await session.executeWrite((tx) =>
          tx.run(
            'MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId}) SET i.assignee_id = $userId, i.updated_at = $now',
            { incidentId, tenantId, userId, now },
          ),
        )
      } else if (actionType === 'resolve') {
        const { resolveIncident } = await import('../services/incidentService.js')
        await resolveIncident(incidentId, { tenantId, userId })
      } else if (actionType === 'escalate') {
        const { escalateIncident } = await import('../services/incidentService.js')
        await escalateIncident(incidentId, { tenantId, userId })
      }

      if (responseUrl) {
        await fetch(responseUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `✅ Azione *${actionType}* eseguita sull'incident \`${incidentId}\`.` }),
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
