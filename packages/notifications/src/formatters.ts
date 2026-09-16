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

/**
 * `occurredAt` è l'istante DELL'EVENTO, non quello della consegna (revisione
 * totale · E-16): la riga di contesto diceva quando il job è stato lavorato,
 * quindi con una coda in ritardo di venti minuti Slack riportava un orario
 * sbagliato di venti minuti. Omesso = adesso (chi non ha un istante, come un
 * messaggio di prova).
 */
export function formatSlackIncident(event: NotificationEvent, incident: IncidentData, locale: NotificationLocale, headline: IncidentHeadline = event, occurredAt?: Date): SlackBlock[] {
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
          text: `${notificationText(locale, headline as NotificationTextKey)}  ·  ${formatNotificationDate(locale, occurredAt)}`,
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

export function formatSlackChange(change: ChangeData, locale: NotificationLocale, occurredAt?: Date): SlackBlock[] {
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
        { type: 'mrkdwn', text: `${notificationText(locale, 'change_approved')}  ·  ${formatNotificationDate(locale, occurredAt)}` },
      ],
    },
  ]
}

export function formatSlackChangeTask(payload: ChangeTaskPayload, locale: NotificationLocale, occurredAt?: Date): SlackBlock[] {
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
        { type: 'mrkdwn', text: `${notificationText(locale, 'change_task_assigned')}  ·  ${formatNotificationDate(locale, occurredAt)}` },
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

/**
 * Change approvata, per un canale Teams (revisione totale · E-18): la pagina
 * Canali offre l'evento «Change approvata» anche a un canale Teams, ma il
 * dispatcher gestiva SOLO Slack e scartava quel canale in silenzio — l'admin
 * non riceveva niente e nessun avviso lo diceva.
 */
export function formatTeamsChange(change: ChangeData, locale: NotificationLocale, occurredAt?: Date): TeamsAdaptiveCard {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: `📋 ${change.title}`, weight: 'Bolder', size: 'Large', wrap: true },
      { type: 'FactSet', facts: [
        { title: notificationText(locale, 'type'),       value: change.type },
        { title: notificationText(locale, 'status'),     value: change.status },
        { title: notificationText(locale, 'ciAffected'), value: change.ciName ?? '—' },
        { title: notificationText(locale, 'assignedTo'), value: change.assigneeName ?? '—' },
      ] },
      { type: 'TextBlock', text: `${notificationText(locale, 'change_approved')}  ·  ${formatNotificationDate(locale, occurredAt)}`, wrap: true, isSubtle: true },
    ],
    actions: [
      { type: 'Action.OpenUrl', title: notificationText(locale, 'open'), url: `${appUrl()}/changes/${change.id}` },
    ],
  }
}

/** Attività di change assegnata, per un canale Teams (E-18). */
export function formatTeamsChangeTask(payload: ChangeTaskPayload, locale: NotificationLocale, occurredAt?: Date): TeamsAdaptiveCard {
  return {
    type: 'AdaptiveCard',
    version: '1.4',
    body: [
      { type: 'TextBlock', text: notificationText(locale, 'newAssessmentTask'), weight: 'Bolder', size: 'Large', wrap: true },
      { type: 'FactSet', facts: [
        { title: notificationText(locale, 'entity'),     value: payload.changeTitle },
        { title: notificationText(locale, 'ciAffected'), value: payload.ciName },
        { title: notificationText(locale, 'assignedTo'), value: payload.assignedTo },
      ] },
      { type: 'TextBlock', text: `${notificationText(locale, 'change_task_assigned')}  ·  ${formatNotificationDate(locale, occurredAt)}`, wrap: true, isSubtle: true },
    ],
    actions: [
      { type: 'Action.OpenUrl', title: notificationText(locale, 'open'), url: `${appUrl()}/changes/${payload.changeId}` },
    ],
  }
}
