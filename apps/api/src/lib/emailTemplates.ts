/**
 * Email templates for OpenGrafo notifications.
 * All HTML uses inline styles + tables for email client compatibility.
 *
 * Revisione del 14 set 2026 · CO-2: i testi sono nella lingua del cliente
 * (`NotificationLocale`, da `loadNotificationLocale`), e i sette template mai
 * chiamati da nessuno (incident creato/assegnato/risolto/in escalation,
 * commento, approvazione change, SLA violato: le e-mail delle regole le scrive
 * il dispatcher del pacchetto notifiche) sono stati tolti.
 *
 * Every user-controlled value (title, description, excerpt, author, event,
 * tenant, …) goes through escapeHtml before touching the markup (C-13): a
 * title like `<a href="https://evil">…` must render as text, not as a link.
 */

import { brandedEmailHtml, escapeHtml as e, notificationText, type NotificationLocale } from '@opengraphity/notifications'
import type { TenantBrand } from '@opengraphity/types'
import { config } from './config.js'

const BRAND     = '#0EA5E9'
const BRAND_BG  = '#E0F2FE'
const SLATE     = '#64748B'
const DARK      = '#0F172A'
const BG        = '#F8FAFC'
const WHITE     = '#FFFFFF'
const DANGER    = '#EF4444'
const WARNING   = '#F59E0B'
const SUCCESS   = '#10B981'

// Localhost default is dev-only: in production a missing APP_URL would put
// localhost links in every email (same guard as @opengraphity/notifications).
function baseUrl(): string {
  const url = config.appUrl
  if (!url && config.isProduction) {
    throw new Error('[emailTemplates] APP_URL is not set in production — email links would point to localhost')
  }
  return url ?? 'http://localhost:5173'
}

/**
 * Chi manda l'e-mail: l'organizzazione con il suo marchio (verifica «Cosa resta
 * cablato», ondata 6). L'impaginazione è quella unica del pacchetto notifiche
 * (`brandedEmailHtml`): logo e nome in testa, «Powered by OpenGrafo» in fondo.
 */
export interface EmailSender { tenantId: string; brand: TenantBrand }

function layout(sender: EmailSender, locale: NotificationLocale, content: string): string {
  return brandedEmailHtml(sender.tenantId, sender.brand, content, locale.language)
}

function btn(label: string, url: string, color = BRAND): string {
  return `<table cellpadding="0" cellspacing="0" style="margin:16px 0;"><tr><td style="background:${color};border-radius:6px;padding:10px 24px;">
<a href="${e(url)}" style="color:${WHITE};text-decoration:none;font-size:14px;font-weight:600;">${e(label)}</a>
</td></tr></table>`
}

function label(l: string, v: string): string {
  return `<tr><td style="padding:4px 0;font-size:13px;color:${SLATE};width:120px;vertical-align:top;">${e(l)}</td><td style="padding:4px 0;font-size:13px;color:${DARK};">${v}</td></tr>`
}

// ── Templates ────────────────────────────────────────────────────────────────

/** Il percorso del web per un tipo di ticket. */
function pathOf(entityType: string): string {
  return entityType === 'incident' ? 'incidents' : entityType === 'change' ? 'changes' : entityType === 'problem' ? 'problems' : 'requests'
}

export function mentionNotification(
  p: { entityType: string; entityTitle: string; entityId: string; mentionerName: string; excerpt: string },
  sender: EmailSender, locale: NotificationLocale,
) {
  const tx = (k: Parameters<typeof notificationText>[1], params: Record<string, string> = {}) => notificationText(locale, k, params)
  return {
    subject: tx('emailMentionSubject', { tenant: sender.brand.displayName, author: p.mentionerName, entity: p.entityType, title: p.entityTitle }),
    html: layout(sender, locale, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${BRAND};">${e(tx('emailMentionHeading'))}</h2>
      <p style="font-size:14px;color:${DARK};margin:0 0 12px;">
        ${e(tx('mentionMessage', { author: p.mentionerName, entity: p.entityType, title: p.entityTitle }))}
      </p>
      <div style="margin:12px 0;padding:12px 16px;background:${BRAND_BG};border-radius:6px;font-size:13px;color:${DARK};line-height:1.6;">
        ${e(p.excerpt.slice(0, 300))}${p.excerpt.length > 300 ? '…' : ''}
      </div>
      ${btn(tx('goToComment'), `${baseUrl()}/${pathOf(p.entityType)}/${encodeURIComponent(p.entityId)}`)}
    `),
  }
}

export function watcherNotification(
  p: { entityType: string; entityTitle: string; entityId: string; event: string },
  sender: EmailSender, locale: NotificationLocale,
) {
  const tx = (k: Parameters<typeof notificationText>[1], params: Record<string, string> = {}) => notificationText(locale, k, params)
  return {
    subject: tx('emailWatcherSubject', { tenant: sender.brand.displayName, entity: p.entityType, title: p.entityTitle }),
    html: layout(sender, locale, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${DARK};">${e(tx('update'))}</h2>
      <p style="font-size:14px;color:${DARK};margin:0 0 16px;">
        ${e(p.event)}
      </p>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${label(tx('entity'), `${e(p.entityType)}: <strong>${e(p.entityTitle)}</strong>`)}
      </table>
      ${btn(tx('viewDetails'), `${baseUrl()}/${pathOf(p.entityType)}/${encodeURIComponent(p.entityId)}`)}
    `),
  }
}

export function digestDaily(
  p: { openIncidents: number; resolvedToday: number; ongoingChanges: number; slaBreaches: number; recentEvents: string[] },
  sender: EmailSender, locale: NotificationLocale,
) {
  const tx = (k: Parameters<typeof notificationText>[1], params: Record<string, string> = {}) => notificationText(locale, k, params)
  const eventsList = p.recentEvents.length > 0
    ? p.recentEvents.map(ev => `<li style="padding:4px 0;font-size:13px;color:${DARK};">${e(ev)}</li>`).join('')
    : `<li style="padding:4px 0;font-size:13px;color:${SLATE};">${e(tx('digestNoEvents'))}</li>`
  const tile = (value: number, text: string, color: string) => `
          <td style="padding:12px;text-align:center;background:${color}15;border-radius:6px;width:25%;">
            <div style="font-size:24px;font-weight:700;color:${color};">${value}</div>
            <div style="font-size:11px;color:${SLATE};">${e(text)}</div>
          </td>`

  return {
    subject: tx('digestSubject', { tenant: sender.brand.displayName }),
    html: layout(sender, locale, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${DARK};">${e(tx('digestHeading'))}</h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;">
        <tr>
          ${tile(p.openIncidents, tx('digestOpenIncidents'), DANGER)}
          <td style="width:8px;"></td>
          ${tile(p.resolvedToday, tx('digestResolvedToday'), SUCCESS)}
          <td style="width:8px;"></td>
          ${tile(p.ongoingChanges, tx('digestOngoingChanges'), BRAND)}
          <td style="width:8px;"></td>
          ${tile(p.slaBreaches, tx('digestSlaBreaches'), WARNING)}
        </tr>
      </table>
      <h3 style="font-size:14px;color:${DARK};margin:0 0 8px;">${e(tx('digestRecentEvents'))}</h3>
      <ul style="margin:0;padding:0 0 0 16px;">${eventsList}</ul>
      ${btn(tx('goToDashboard'), `${baseUrl()}/dashboard`)}
    `),
  }
}
