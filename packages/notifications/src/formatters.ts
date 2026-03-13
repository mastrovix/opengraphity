import type { SlackBlock, TeamsAdaptiveCard } from './index.js'

export type NotificationEvent =
  | 'sla_breach' | 'escalation' | 'assigned' | 'resolved'
  | 'change_approved' | 'change_failed'

export interface IncidentData {
  id: string
  title: string
  description?: string | null
  severity: string
  status: string
  ciNames?: string[]
  assigneeName?: string | null
  tenantId: string
}

const SEV_EMOJI: Record<string, string> = {
  critical: '🔴', high: '🟠', medium: '🟡', low: '🟢',
}

const APP_URL = process.env['APP_URL'] ?? 'http://localhost:5173'

export function formatSlackIncident(event: NotificationEvent, incident: IncidentData): SlackBlock[] {
  const emoji = SEV_EMOJI[incident.severity] ?? '⚪'
  const desc = incident.description
    ? incident.description.slice(0, 150) + (incident.description.length > 150 ? '…' : '')
    : '_Nessuna descrizione_'

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} ${incident.title}`, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: desc },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Severity:*\n${(incident.severity ?? '—').toUpperCase()}` },
        { type: 'mrkdwn', text: `*Status:*\n${incident.status ?? '—'}` },
        { type: 'mrkdwn', text: `*CI Affected:*\n${incident.ciNames?.join(', ') ?? '—'}` },
        { type: 'mrkdwn', text: `*Assegnato a:*\n${incident.assigneeName ?? '—'}` },
      ],
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `ID: \`${incident.id}\` · ${new Date().toLocaleString('it-IT')}` },
      ],
    },
  ]

  if (event === 'assigned' || event === 'escalation') {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button', text: { type: 'plain_text', text: '✅ Assegna a me', emoji: true },
          value: JSON.stringify({ action: 'assign_me', incidentId: incident.id, tenantId: incident.tenantId }),
          action_id: 'assign_me',
        },
        {
          type: 'button', text: { type: 'plain_text', text: '🔺 Escalate', emoji: true },
          style: 'danger',
          value: JSON.stringify({ action: 'escalate', incidentId: incident.id, tenantId: incident.tenantId }),
          action_id: 'escalate',
        },
        {
          type: 'button', text: { type: 'plain_text', text: '✔ Risolvi', emoji: true },
          style: 'primary',
          value: JSON.stringify({ action: 'resolve', incidentId: incident.id, tenantId: incident.tenantId }),
          action_id: 'resolve',
        },
      ],
    })
  }

  return blocks
}

export function formatTeamsIncident(event: NotificationEvent, incident: IncidentData): TeamsAdaptiveCard {
  const emoji = SEV_EMOJI[incident.severity] ?? '⚪'
  const facts = [
    { title: 'Severity', value: (incident.severity ?? '—').toUpperCase() },
    { title: 'Status', value: incident.status ?? '—' },
    { title: 'CI Affected', value: incident.ciNames?.join(', ') ?? '—' },
    { title: 'Assegnato a', value: incident.assigneeName ?? '—' },
  ]

  const card: TeamsAdaptiveCard = {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: `${emoji} ${incident.title}`, weight: 'Bolder', size: 'Large', wrap: true },
      { type: 'FactSet', facts },
    ],
  }

  if (event === 'assigned' || event === 'escalation') {
    card.actions = [
      {
        type: 'Action.OpenUrl',
        title: 'Assegna a me',
        url: `${APP_URL}/incidents/${incident.id}`,
      },
      {
        type: 'Action.OpenUrl',
        title: 'Risolvi',
        url: `${APP_URL}/incidents/${incident.id}`,
      },
    ]
  }

  return card
}
