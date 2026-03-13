import type { SlackBlock, TeamsAdaptiveCard } from './index.js'

export type NotificationEvent =
  | 'sla_breach' | 'escalation' | 'assigned' | 'resolved'
  | 'change_approved' | 'change_failed' | 'change_task_assigned'

export interface ChangeTaskPayload {
  changeId: string
  changeTitle: string
  taskId: string
  ciName: string
  teamName: string
  assignedTo: string
}

export interface ChangeData {
  id: string
  title: string
  type: string
  status: string
  ciName?: string | null
  assigneeName?: string | null
  tenantId: string
}

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

const STATUS_LABEL: Record<NotificationEvent, string> = {
  assigned:       '👤 Assegnato',
  escalation:     '⚠️ Escalato',
  resolved:       '✅ Risolto',
  sla_breach:     '⏱ SLA Breach',
  change_approved:      '✅ Change Approvata',
  change_failed:        '❌ Change Fallita',
  change_task_assigned: '🔵 Task assegnato',
}

const APP_URL = process.env['APP_URL'] ?? 'http://localhost:5173'

export function formatSlackIncident(event: NotificationEvent, incident: IncidentData): SlackBlock[] {
  const emoji      = SEV_EMOJI[incident.severity] ?? '⚪'
  const ciName     = incident.ciNames?.[0] ?? '—'
  const assignedTo = incident.assigneeName ?? '—'
  const sevLabel   = (incident.severity ?? '—').toUpperCase()

  const blocks: SlackBlock[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${emoji} ${incident.title}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Severity:* ${sevLabel}`,
          `*Status:* ${incident.status ?? '—'}`,
          `*CI Affected:* ${ciName}`,
          `*Assegnato a:* ${assignedTo}`,
        ].join('\n'),
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Apri →' },
        url: `${APP_URL}/incidents/${incident.id}`,
        action_id: 'open_incident',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${STATUS_LABEL[event]}  ·  ${new Date().toLocaleString('it-IT')}`,
        },
      ],
    },
  ]

  if (event === 'assigned' || event === 'escalation') {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Assegna a me' },
          action_id: 'assign_me',
          value: JSON.stringify({ action: 'assign_me', incidentId: incident.id, tenantId: incident.tenantId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Risolvi' },
          action_id: 'resolve',
          value: JSON.stringify({ action: 'resolve', incidentId: incident.id, tenantId: incident.tenantId }),
        },
      ],
    })
  }

  return blocks
}

export function formatSlackChange(change: ChangeData): SlackBlock[] {
  const ciName     = change.ciName ?? '—'
  const assignedTo = change.assigneeName ?? '—'

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `📋 ${change.title}` },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Type:* ${change.type}`,
          `*Status:* ${change.status}`,
          `*CI Affected:* ${ciName}`,
          `*Assegnato a:* ${assignedTo}`,
        ].join('\n'),
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Apri →' },
        url: `${APP_URL}/changes/${change.id}`,
        action_id: 'open_change',
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `✅ Change Approvato  ·  ${new Date().toLocaleString('it-IT')}` },
      ],
    },
  ]
}

export function formatSlackChangeTask(payload: ChangeTaskPayload): SlackBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: '📋 Nuovo task di assessment' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Change:* ${payload.changeTitle}`,
          `*CI:* ${payload.ciName}`,
          `*Assegnato a:* ${payload.teamName}`,
        ].join('\n'),
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: 'Apri →' },
        url: `${APP_URL}/changes/${payload.changeId}`,
        action_id: 'open_change',
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `🔵 Task assegnato  ·  ${new Date().toLocaleString('it-IT')}` },
      ],
    },
  ]
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
