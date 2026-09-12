import { assertSafeOutboundUrl } from '@opengraphity/events'

export * from './sse.js'
export * from './email.js'
export * from './webhook.js'
export * from './dispatcher.js'
export * from './escapeHtml.js'
export * from './routing.js'
export * from './recipients.js'
export { loadChannels, dispatchIncidentNotification, dispatchChangeNotification, dispatchChangeTaskNotification } from './consumer.js'

export interface NotificationChannelData {
  id: string
  platform: string
  name: string
  webhookUrl: string | null
  channelId: string | null
  eventTypes: string[]
  active: boolean
  createdAt: string
}

export interface SlackBlock {
  type: string
  [key: string]: unknown
}

export interface TeamsAdaptiveCard {
  type: string
  version: string
  body: unknown[]
  actions?: unknown[]
}

const OUTBOUND_TIMEOUT_MS = 10_000

/** `fetch` with a hard 10 s timeout — a hung Slack/Teams endpoint must not block the consumer. */
async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Sends a Slack message. Returns true on success and THROWS on any failure
 * (network error, non-2xx, Slack API ok:false, missing config, unsafe URL) —
 * a lost notification must fail the calling job, never dissolve into a
 * `false` nobody reads.
 */
export async function sendSlackMessage(
  webhookUrl: string | null,
  channelId: string | null,
  blocks: SlackBlock[],
): Promise<boolean> {
  if (webhookUrl) {
    // Tenant-configured URL → SSRF guard (scheme, private IPs, DNS).
    await assertSafeOutboundUrl(webhookUrl)
    const res = await fetchWithTimeout(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ blocks }),
    })
    if (!res.ok) throw new Error(`Slack webhook rejected the message: HTTP ${res.status}`)
    return true
  }
  if (channelId) {
    const token = process.env['SLACK_BOT_TOKEN']
    if (!token) throw new Error('SLACK_BOT_TOKEN non configurato')
    const res = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel: channelId, blocks }),
    })
    if (!res.ok) throw new Error(`Slack API error: HTTP ${res.status}`)
    const data = (await res.json()) as { ok: boolean; error?: string }
    if (!data.ok) throw new Error(`Slack API refused the message: ${data.error ?? 'unknown error'}`)
    return true
  }
  throw new Error('sendSlackMessage: neither webhookUrl nor channelId configured')
}

/**
 * Sends a Teams adaptive card. Returns true on success, THROWS on failure
 * (including an unsafe tenant-configured webhook URL).
 */
export async function sendTeamsAdaptiveMessage(
  webhookUrl: string,
  card: TeamsAdaptiveCard,
): Promise<boolean> {
  await assertSafeOutboundUrl(webhookUrl)
  const res = await fetchWithTimeout(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'message',
      attachments: [
        { contentType: 'application/vnd.microsoft.card.adaptive', content: card },
      ],
    }),
  })
  if (!res.ok) throw new Error(`Teams webhook rejected the message: HTTP ${res.status}`)
  return true
}

export async function sendTestMessage(channel: NotificationChannelData): Promise<boolean> {
  if (channel.platform === 'slack') {
    const blocks: SlackBlock[] = [
      { type: 'section', text: { type: 'mrkdwn', text: `✅ *Test notifica* — canale *${channel.name}* configurato correttamente su OpenGraphity.` } },
    ]
    return sendSlackMessage(channel.webhookUrl, channel.channelId, blocks)
  }
  if (channel.platform === 'teams') {
    const card: TeamsAdaptiveCard = {
      type: 'AdaptiveCard',
      version: '1.4',
      body: [
        { type: 'TextBlock', text: `✅ Test notifica — ${channel.name}`, weight: 'Bolder', size: 'Medium' },
        { type: 'TextBlock', text: 'Canale configurato correttamente su OpenGraphity.', wrap: true },
      ],
    }
    return sendTeamsAdaptiveMessage(channel.webhookUrl!, card)
  }
  throw new Error(`sendTestMessage: unsupported platform "${channel.platform}"`)
}
