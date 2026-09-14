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

import { appUrl } from './appUrl.js'
import { formatNotificationDate, notificationText, type NotificationLocale, type NotificationTextKey } from './texts.js'

/**
 * La riga di stato del messaggio. `headline` distingue ciò che il canale non
 * distingue: un incident appena creato viaggia sull'abbonamento `assigned` dei
 * canali, ma non è «Assegnato» (prima lo diceva).
 */
export type IncidentHeadline = NotificationEvent | 'created'

export function formatSlackIncident(event: NotificationEvent, incident: IncidentData, locale: NotificationLocale, headline: IncidentHeadline = event): SlackBlock[] {
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
          `*${notificationText(locale, 'severity')}:* ${sevLabel}`,
          `*${notificationText(locale, 'status')}:* ${incident.status ?? '—'}`,
          `*${notificationText(locale, 'ciAffected')}:* ${ciName}`,
          `*${notificationText(locale, 'assignedTo')}:* ${assignedTo}`,
        ].join('\n'),
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: notificationText(locale, 'open') },
        url: `${appUrl()}/incidents/${incident.id}`,
        action_id: 'open_incident',
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${notificationText(locale, headline as NotificationTextKey)}  ·  ${formatNotificationDate(locale)}`,
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
          text: { type: 'plain_text', text: notificationText(locale, 'assignToMe') },
          action_id: 'assign_me',
          value: JSON.stringify({ action: 'assign_me', incidentId: incident.id, tenantId: incident.tenantId }),
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: notificationText(locale, 'resolve') },
          action_id: 'resolve',
          value: JSON.stringify({ action: 'resolve', incidentId: incident.id, tenantId: incident.tenantId }),
        },
      ],
    })
  }

  return blocks
}

export function formatSlackChange(change: ChangeData, locale: NotificationLocale): SlackBlock[] {
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
          `*${notificationText(locale, 'type')}:* ${change.type}`,
          `*${notificationText(locale, 'status')}:* ${change.status}`,
          `*${notificationText(locale, 'ciAffected')}:* ${ciName}`,
          `*${notificationText(locale, 'assignedTo')}:* ${assignedTo}`,
        ].join('\n'),
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: notificationText(locale, 'open') },
        url: `${appUrl()}/changes/${change.id}`,
        action_id: 'open_change',
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${notificationText(locale, 'change_approved')}  ·  ${formatNotificationDate(locale)}` },
      ],
    },
  ]
}

export function formatSlackChangeTask(payload: ChangeTaskPayload, locale: NotificationLocale): SlackBlock[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: notificationText(locale, 'newAssessmentTask') },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: [
          `*Change:* ${payload.changeTitle}`,
          `*CI:* ${payload.ciName}`,
          `*${notificationText(locale, 'assignedTo')}:* ${payload.teamName}`,
        ].join('\n'),
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: notificationText(locale, 'open') },
        url: `${appUrl()}/changes/${payload.changeId}`,
        action_id: 'open_change',
      },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `${notificationText(locale, 'change_task_assigned')}  ·  ${formatNotificationDate(locale)}` },
      ],
    },
  ]
}

export function formatTeamsIncident(event: NotificationEvent, incident: IncidentData, locale: NotificationLocale): TeamsAdaptiveCard {
  const emoji = SEV_EMOJI[incident.severity] ?? '⚪'
  const facts = [
    { title: notificationText(locale, 'severity'),   value: (incident.severity ?? '—').toUpperCase() },
    { title: notificationText(locale, 'status'),     value: incident.status ?? '—' },
    { title: notificationText(locale, 'ciAffected'), value: incident.ciNames?.join(', ') ?? '—' },
    { title: notificationText(locale, 'assignedTo'), value: incident.assigneeName ?? '—' },
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
        title: notificationText(locale, 'assignToMe'),
        url: `${appUrl()}/incidents/${incident.id}`,
      },
      {
        type: 'Action.OpenUrl',
        title: notificationText(locale, 'resolve'),
        url: `${appUrl()}/incidents/${incident.id}`,
      },
    ]
  }

  return card
}
