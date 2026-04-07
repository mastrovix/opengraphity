/**
 * Email templates for OpenGrafo notifications.
 * All HTML uses inline styles + tables for email client compatibility.
 */

const BRAND     = '#0EA5E9'
const BRAND_BG  = '#E0F2FE'
const SLATE     = '#64748B'
const DARK      = '#0F172A'
const BG        = '#F8FAFC'
const WHITE     = '#FFFFFF'
const DANGER    = '#EF4444'
const WARNING   = '#F59E0B'
const SUCCESS   = '#10B981'

const SEV_COLORS: Record<string, string> = { critical: DANGER, high: '#F97316', medium: WARNING, low: SUCCESS }

function baseUrl(): string { return process.env['APP_URL'] ?? 'http://localhost:5173' }

function layout(tenant: string, content: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${BG};font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:24px 0;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:${WHITE};border-radius:8px;border:1px solid #E2E8F0;overflow:hidden;">
<!-- Header -->
<tr><td style="background:${DARK};padding:16px 24px;">
<span style="color:${BRAND};font-size:20px;font-weight:700;">open</span><span style="color:${WHITE};font-size:20px;font-weight:700;">grafo</span>
<span style="color:${SLATE};font-size:12px;margin-left:12px;">${tenant}</span>
</td></tr>
<!-- Body -->
<tr><td style="padding:24px;">${content}</td></tr>
<!-- Footer -->
<tr><td style="padding:16px 24px;border-top:1px solid #E2E8F0;text-align:center;">
<span style="font-size:11px;color:${SLATE};">Powered by OpenGrafo &copy; ${new Date().getFullYear()}</span>
</td></tr>
</table>
</td></tr></table>
</body></html>`
}

function sevBadge(severity: string): string {
  const c = SEV_COLORS[severity] ?? SLATE
  return `<span style="display:inline-block;padding:2px 10px;border-radius:4px;font-size:12px;font-weight:600;color:${WHITE};background:${c};">${severity}</span>`
}

function btn(label: string, url: string, color = BRAND): string {
  return `<table cellpadding="0" cellspacing="0" style="margin:16px 0;"><tr><td style="background:${color};border-radius:6px;padding:10px 24px;">
<a href="${url}" style="color:${WHITE};text-decoration:none;font-size:14px;font-weight:600;">${label}</a>
</td></tr></table>`
}

function label(l: string, v: string): string {
  return `<tr><td style="padding:4px 0;font-size:13px;color:${SLATE};width:120px;vertical-align:top;">${l}</td><td style="padding:4px 0;font-size:13px;color:${DARK};">${v}</td></tr>`
}

// ── Templates ────────────────────────────────────────────────────────────────

export function incidentCreated(p: { title: string; severity: string; category?: string; description?: string; id: string }, tenant: string) {
  return {
    subject: `[${tenant}] Nuovo incident: ${p.title}`,
    html: layout(tenant, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${DARK};">Nuovo incident</h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${label('Titolo', `<strong>${p.title}</strong>`)}
        ${label('Severità', sevBadge(p.severity))}
        ${p.category ? label('Categoria', p.category) : ''}
        ${p.description ? label('Descrizione', p.description.slice(0, 200) + (p.description.length > 200 ? '…' : '')) : ''}
      </table>
      ${btn('Vedi incident', `${baseUrl()}/incidents/${p.id}`)}
    `),
  }
}

export function incidentAssigned(p: { title: string; severity: string; id: string; assignedBy?: string }, tenant: string) {
  return {
    subject: `[${tenant}] Incident assegnato a te: ${p.title}`,
    html: layout(tenant, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${DARK};">Incident assegnato a te</h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${label('Titolo', `<strong>${p.title}</strong>`)}
        ${label('Severità', sevBadge(p.severity))}
        ${p.assignedBy ? label('Assegnato da', p.assignedBy) : ''}
      </table>
      ${btn('Vedi incident', `${baseUrl()}/incidents/${p.id}`)}
    `),
  }
}

export function incidentResolved(p: { title: string; id: string; resolvedBy?: string; rootCause?: string }, tenant: string) {
  return {
    subject: `[${tenant}] Incident risolto: ${p.title}`,
    html: layout(tenant, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${SUCCESS};">Incident risolto</h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${label('Titolo', `<strong>${p.title}</strong>`)}
        ${p.resolvedBy ? label('Risolto da', p.resolvedBy) : ''}
        ${p.rootCause ? label('Root cause', p.rootCause.slice(0, 200)) : ''}
      </table>
      ${btn('Vedi incident', `${baseUrl()}/incidents/${p.id}`)}
    `),
  }
}

export function incidentEscalated(p: { title: string; severity: string; id: string }, tenant: string) {
  return {
    subject: `[${tenant}] ⚠ Incident escalato: ${p.title}`,
    html: layout(tenant, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${DANGER};">⚠ Incident escalato</h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${label('Titolo', `<strong>${p.title}</strong>`)}
        ${label('Severità', sevBadge(p.severity))}
      </table>
      ${btn('Vedi incident', `${baseUrl()}/incidents/${p.id}`)}
    `),
  }
}

export function commentAdded(p: { entityType: string; entityTitle: string; entityId: string; authorName: string; excerpt: string }, tenant: string) {
  const path = p.entityType === 'incident' ? 'incidents' : p.entityType === 'change' ? 'changes' : p.entityType === 'problem' ? 'problems' : 'requests'
  return {
    subject: `[${tenant}] Nuovo commento su ${p.entityType} ${p.entityTitle}`,
    html: layout(tenant, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${DARK};">Nuovo commento</h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${label('Entità', `${p.entityType}: <strong>${p.entityTitle}</strong>`)}
        ${label('Autore', p.authorName)}
      </table>
      <div style="margin:16px 0;padding:12px 16px;background:${BG};border-left:3px solid ${BRAND};border-radius:4px;font-size:13px;color:${DARK};line-height:1.6;">
        ${p.excerpt.slice(0, 300)}${p.excerpt.length > 300 ? '…' : ''}
      </div>
      ${btn('Vedi commento', `${baseUrl()}/${path}/${p.entityId}`)}
    `),
  }
}

export function mentionNotification(p: { entityType: string; entityTitle: string; entityId: string; mentionerName: string; excerpt: string }, tenant: string) {
  const path = p.entityType === 'incident' ? 'incidents' : p.entityType === 'change' ? 'changes' : p.entityType === 'problem' ? 'problems' : 'requests'
  return {
    subject: `[${tenant}] ${p.mentionerName} ti ha menzionato in ${p.entityType} ${p.entityTitle}`,
    html: layout(tenant, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${BRAND};">Sei stato menzionato</h2>
      <p style="font-size:14px;color:${DARK};margin:0 0 12px;">
        <strong>${p.mentionerName}</strong> ti ha menzionato in <strong>${p.entityType} "${p.entityTitle}"</strong>
      </p>
      <div style="margin:12px 0;padding:12px 16px;background:${BRAND_BG};border-radius:6px;font-size:13px;color:${DARK};line-height:1.6;">
        ${p.excerpt.slice(0, 300)}${p.excerpt.length > 300 ? '…' : ''}
      </div>
      ${btn('Vai al commento', `${baseUrl()}/${path}/${p.entityId}`)}
    `),
  }
}

export function changeApprovalRequested(p: { title: string; type: string; id: string; description?: string }, tenant: string) {
  return {
    subject: `[${tenant}] Approvazione richiesta: ${p.title}`,
    html: layout(tenant, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${WARNING};">Approvazione richiesta</h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${label('Titolo', `<strong>${p.title}</strong>`)}
        ${label('Tipo', p.type)}
        ${p.description ? label('Descrizione', p.description.slice(0, 200)) : ''}
      </table>
      ${btn('Vedi change', `${baseUrl()}/changes/${p.id}`)}
    `),
  }
}

export function slaBreach(p: { entityType: string; entityTitle: string; entityId: string; slaType: string }, tenant: string) {
  const path = p.entityType === 'incident' ? 'incidents' : p.entityType === 'problem' ? 'problems' : 'requests'
  return {
    subject: `[${tenant}] ⚠ SLA violato: ${p.entityType} ${p.entityTitle}`,
    html: layout(tenant, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${DANGER};">⚠ SLA violato</h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${label('Entità', `${p.entityType}: <strong>${p.entityTitle}</strong>`)}
        ${label('Tipo SLA', p.slaType)}
      </table>
      ${btn('Vedi dettagli', `${baseUrl()}/${path}/${p.entityId}`)}
    `),
  }
}

export function watcherNotification(p: { entityType: string; entityTitle: string; entityId: string; event: string }, tenant: string) {
  const path = p.entityType === 'incident' ? 'incidents' : p.entityType === 'change' ? 'changes' : p.entityType === 'problem' ? 'problems' : 'requests'
  return {
    subject: `[${tenant}] Aggiornamento su ${p.entityType} ${p.entityTitle}`,
    html: layout(tenant, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${DARK};">Aggiornamento</h2>
      <p style="font-size:14px;color:${DARK};margin:0 0 16px;">
        ${p.event}
      </p>
      <table cellpadding="0" cellspacing="0" style="width:100%;">
        ${label('Entità', `${p.entityType}: <strong>${p.entityTitle}</strong>`)}
      </table>
      ${btn('Vedi dettagli', `${baseUrl()}/${path}/${p.entityId}`)}
    `),
  }
}

export function digestDaily(p: { openIncidents: number; resolvedToday: number; ongoingChanges: number; slaBreaches: number; recentEvents: string[] }, tenant: string) {
  const eventsList = p.recentEvents.length > 0
    ? p.recentEvents.map(e => `<li style="padding:4px 0;font-size:13px;color:${DARK};">${e}</li>`).join('')
    : `<li style="padding:4px 0;font-size:13px;color:${SLATE};">Nessun evento recente</li>`

  return {
    subject: `[${tenant}] Riepilogo giornaliero IT`,
    html: layout(tenant, `
      <h2 style="margin:0 0 16px;font-size:18px;color:${DARK};">Riepilogo giornaliero</h2>
      <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:20px;">
        <tr>
          <td style="padding:12px;text-align:center;background:${DANGER}15;border-radius:6px;width:25%;">
            <div style="font-size:24px;font-weight:700;color:${DANGER};">${p.openIncidents}</div>
            <div style="font-size:11px;color:${SLATE};">Incident aperti</div>
          </td>
          <td style="width:8px;"></td>
          <td style="padding:12px;text-align:center;background:${SUCCESS}15;border-radius:6px;width:25%;">
            <div style="font-size:24px;font-weight:700;color:${SUCCESS};">${p.resolvedToday}</div>
            <div style="font-size:11px;color:${SLATE};">Risolti oggi</div>
          </td>
          <td style="width:8px;"></td>
          <td style="padding:12px;text-align:center;background:${BRAND}15;border-radius:6px;width:25%;">
            <div style="font-size:24px;font-weight:700;color:${BRAND};">${p.ongoingChanges}</div>
            <div style="font-size:11px;color:${SLATE};">Change in corso</div>
          </td>
          <td style="width:8px;"></td>
          <td style="padding:12px;text-align:center;background:${WARNING}15;border-radius:6px;width:25%;">
            <div style="font-size:24px;font-weight:700;color:${WARNING};">${p.slaBreaches}</div>
            <div style="font-size:11px;color:${SLATE};">SLA breach</div>
          </td>
        </tr>
      </table>
      <h3 style="font-size:14px;color:${DARK};margin:0 0 8px;">Ultimi eventi</h3>
      <ul style="margin:0;padding:0 0 0 16px;">${eventsList}</ul>
      ${btn('Vai alla dashboard', `${baseUrl()}/dashboard`)}
    `),
  }
}
