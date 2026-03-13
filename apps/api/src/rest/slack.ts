import { createHmac, timingSafeEqual, randomUUID } from 'crypto'
import type { Request, Response } from 'express'
import { getSession } from '@opengraphity/neo4j'

function verifySlackSignature(req: Request): boolean {
  const signingSecret = process.env['SLACK_SIGNING_SECRET'] ?? ''
  const timestamp = req.headers['x-slack-request-timestamp'] as string
  const slackSig = req.headers['x-slack-signature'] as string
  if (!timestamp || !slackSig) return false
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const rawBody = (req as Request & { rawBody?: string }).rawBody ?? ''
  const sigBase = `v0:${timestamp}:${rawBody}`
  const hmac = createHmac('sha256', signingSecret).update(sigBase).digest('hex')
  const computed = `v0=${hmac}`
  try {
    return timingSafeEqual(Buffer.from(computed), Buffer.from(slackSig))
  } catch {
    return false
  }
}

export async function handleSlackCommands(req: Request, res: Response): Promise<void> {
  if (!verifySlackSignature(req)) { res.status(401).json({ error: 'Unauthorized' }); return }

  const { text, user_id: slackUserId } = req.body as Record<string, string>
  const parts = (text ?? '').trim().split(/\s+/)

  if (parts[0] === 'incident' && parts[1] === 'apri') {
    const severity = parts[parts.length - 1]
    const validSev = ['critical', 'high', 'medium', 'low']
    const sev = validSev.includes(severity) ? severity : 'medium'
    const title = parts.slice(2, validSev.includes(severity) ? -1 : undefined).join(' ') || 'Incident da Slack'

    const session = getSession(undefined, 'WRITE')
    try {
      // Resolve Slack user → tenant
      const userResult = await session.executeRead((tx) =>
        tx.run('MATCH (u:User {slack_id: $slackUserId}) RETURN u LIMIT 1', { slackUserId }),
      )
      if (!userResult.records.length) {
        res.json({ response_type: 'ephemeral', text: '⚠️ Collega il tuo account Slack nelle impostazioni profilo.' })
        return
      }
      const u = userResult.records[0]!.get('u').properties as Record<string, unknown>
      const tenantId = u['tenant_id'] as string
      const userId   = u['id']        as string
      const now      = new Date().toISOString()
      const id       = randomUUID()
      await session.executeWrite((tx) =>
        tx.run(
          `CREATE (i:Incident {
            id: $id, tenant_id: $tenantId, title: $title,
            severity: $sev, status: 'new', created_at: $now, updated_at: $now,
            created_by: $userId
          })`,
          { id, tenantId, title, sev, now, userId },
        ),
      )
      res.json({ response_type: 'in_channel', text: `✅ Incident *${title}* creato con severity *${sev}*. ID: \`${id}\`` })
    } finally {
      await session.close()
    }
    return
  }

  res.json({ response_type: 'ephemeral', text: 'Comando non riconosciuto. Usa: `/og incident apri <titolo> <severity>`' })
}

export async function handleSlackActions(req: Request, res: Response): Promise<void> {
  if (!verifySlackSignature(req)) { res.status(401).json({ error: 'Unauthorized' }); return }

  const payload = JSON.parse((req.body as Record<string, string>)['payload'] ?? '{}') as {
    actions?: Array<{ action_id: string; value: string }>
    user?: { id: string }
    response_url?: string
  }

  const action      = payload.actions?.[0]
  const slackUserId = payload.user?.id
  const responseUrl = payload.response_url

  if (!action || !slackUserId) { res.sendStatus(200); return }

  const { action: actionType, incidentId, tenantId } = JSON.parse(action.value ?? '{}') as {
    action: string; incidentId: string; tenantId: string
  }

  const session = getSession(undefined, 'WRITE')
  try {
    const userResult = await session.executeRead((tx) =>
      tx.run(
        'MATCH (u:User {slack_id: $slackUserId, tenant_id: $tenantId}) RETURN u LIMIT 1',
        { slackUserId, tenantId },
      ),
    )
    if (!userResult.records.length) {
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
    const u      = userResult.records[0]!.get('u').properties as Record<string, unknown>
    const userId = u['id'] as string
    const now    = new Date().toISOString()

    if (actionType === 'assign_me') {
      await session.executeWrite((tx) =>
        tx.run(
          'MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId}) SET i.assignee_id = $userId, i.updated_at = $now',
          { incidentId, tenantId, userId, now },
        ),
      )
    } else if (actionType === 'resolve') {
      await session.executeWrite((tx) =>
        tx.run(
          "MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId}) SET i.status = 'resolved', i.updated_at = $now",
          { incidentId, tenantId, now },
        ),
      )
    } else if (actionType === 'escalate') {
      await session.executeWrite((tx) =>
        tx.run(
          "MATCH (i:Incident {id: $incidentId, tenant_id: $tenantId}) SET i.status = 'escalated', i.updated_at = $now",
          { incidentId, tenantId, now },
        ),
      )
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
}
