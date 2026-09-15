/**
 * La persona collegata: chi è e le sue preferenze.
 *
 * `me` era uno stub che restituiva i campi del token (id, email, ruolo) e
 * nient'altro: `slackId` non arrivava mai, e il Profilo diceva «non collegato»
 * anche dopo aver collegato Slack. Ora legge il nodo `User`.
 *
 * Se il nodo non c'è (un'identità del token senza utente nel grafo) si
 * risponde con l'identità del token e nessuna preferenza: l'identità è quella
 * del token, e il nodo porta solo le preferenze.
 */
import { getSession, runQueryOne } from '@opengraphity/neo4j'
import type { GraphQLContext } from '../../context.js'
import { NotFoundError } from '../../lib/errors.js'
import { audit } from '../../lib/audit.js'
import { viewerLanguage } from '../../lib/tenantLanguage.js'

type Props = Record<string, unknown>

function mapMe(props: Props) {
  return {
    id:        props['id']        as string,
    tenantId:  props['tenant_id'] as string,
    email:     props['email']     as string,
    name:      (props['name'] ?? props['email']) as string,
    role:      props['role']      as string,
    slackId:   (props['slack_id'] ?? null) as string | null,
    // CO-1: assente = attive, come in dispatcher, digest e collaborazione.
    emailNotifications: props['notifications_enabled'] !== false,
    language:  (props['language'] ?? null) as string | null,
  }
}

async function me(_: unknown, __: unknown, ctx: GraphQLContext) {
  const session = getSession()
  try {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      RETURN properties(u) AS props
    `, { userId: ctx.userId, tenantId: ctx.tenantId })
    if (!row) {
      return { id: ctx.userId, tenantId: ctx.tenantId, email: ctx.userEmail, name: ctx.userEmail, role: ctx.role, slackId: null, emailNotifications: null, language: null }
    }
    // Il ruolo in vigore è quello del token, che è quello con cui l'API autorizza.
    return { ...mapMe(row.props), role: ctx.role }
  } finally {
    await session.close()
  }
}

/** Revisione del 14 set 2026 · CO-1: la persona sceglie se ricevere le e-mail di notifica. */
async function setMyEmailNotifications(_: unknown, args: { enabled: boolean }, ctx: GraphQLContext) {
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      SET u.notifications_enabled = $enabled
      RETURN properties(u) AS props
    `, { userId: ctx.userId, tenantId: ctx.tenantId, enabled: args.enabled })
    if (!row) throw new NotFoundError('User', ctx.userId)
    void audit(ctx, 'user.email_notifications.updated', 'User', ctx.userId, { enabled: args.enabled })
    return { ...mapMe(row.props), role: ctx.role }
  } finally {
    await session.close()
  }
}

/**
 * La lingua della persona (secondo giro UI del 15 set 2026). Stava solo nel
 * `localStorage` del web: il portale, un'altra applicazione, non la vedeva e
 * restava nella lingua dell'organizzazione. Ora è sul nodo `User`.
 */
async function setMyLanguage(_: unknown, args: { language?: string | null }, ctx: GraphQLContext) {
  const language = viewerLanguage(args.language) ?? null
  const session = getSession(undefined, 'WRITE')
  try {
    const row = await runQueryOne<{ props: Props }>(session, `
      MATCH (u:User {id: $userId, tenant_id: $tenantId})
      SET u.language = $language
      RETURN properties(u) AS props
    `, { userId: ctx.userId, tenantId: ctx.tenantId, language })
    if (!row) throw new NotFoundError('User', ctx.userId)
    return { ...mapMe(row.props), role: ctx.role }
  } finally {
    await session.close()
  }
}

export const meResolvers = {
  Query:    { me },
  Mutation: { setMyEmailNotifications, setMyLanguage },
}
