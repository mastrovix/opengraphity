import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { colors, palette } from '@/lib/tokens'
import { LabelledField } from '@/components/ui/FormControls'

// ── Panel styles ──────────────────────────────────────────────────────────────

export const panelStyle: React.CSSProperties = {
  // 360: quattro schede (Proprietà, Metadati, Notifiche, Scadenza) e l'editor
  // della scadenza con i campi da impostare stanno senza tagli.
  width:           360,
  maxWidth:        'calc(100vw - 48px)',
  // Il pannello galleggia sul disegno: se il contenuto è lungo scorre dentro, non esce dallo schermo.
  maxHeight:       'calc(var(--vh-app) - 220px)',
  overflowY:       'auto',
  backgroundColor: colors.white,
  border:          '1px solid var(--color-border)',
  borderRadius:    10,
  padding:         20,
  boxShadow:       '0 4px 24px var(--color-black-a10)',
  display:         'flex',
  flexDirection:   'column',
  gap:             14,
}

// Overrides on top of the shared FormControls base style (see ui/FormControls).
export const panelInputStyle: React.CSSProperties = {
  padding:         '7px 10px',
  border:          '1px solid var(--color-border)',
  fontSize:        13,
  color:           'var(--color-slate-dark)',
  backgroundColor: palette.neutral.surface1,
}

export function saveButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding:         '8px 0',
    backgroundColor: disabled ? colors.border : colors.brand,
    color:           disabled ? colors.slateLight : colors.white,
    border:          'none',
    borderRadius:    6,
    fontSize:        13,
    fontWeight:      600,
    cursor:          disabled ? 'not-allowed' : 'pointer',
    width:           '100%',
  }
}

export function PanelHeader({ title, onClose }: { title: string; onClose: () => void }) {
  const { t } = useTranslation()
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>{title}</span>
      <button type="button" onClick={onClose} aria-label={t('common.close')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 0 }}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  )
}

export function PanelField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <LabelledField
      label={label}
      style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
      labelStyle={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }}
    >
      {children}
    </LabelledField>
  )
}

// ── Action descriptions (i18n: workflow.actions.*) ───────────────────────────

export function actionLabel(t: (key: string) => string, type: string, params?: Record<string, unknown>): string {
  const base = t(`workflow.actions.${type}`)

  if (type === 'sla_start' || type === 'sla_stop') {
    const slaType = params?.['sla_type'] as string | undefined
    if (slaType === 'response') return `${base} ${t('workflow.actions.sla_response')}`
    if (slaType === 'resolve')  return `${base} ${t('workflow.actions.sla_resolve')}`
    return base
  }

  if (type === 'create_entity') {
    const et = params?.['entity_type'] as string | undefined
    return et ? `${base}: ${et}` : base
  }

  if (type === 'assign_to') {
    const tt  = params?.['target_type'] as string | undefined
    const tid = (params?.['target_id'] ?? params?.['target_name']) as string | undefined
    return tid ? `${base} → ${tt ?? ''} ${tid.slice(0, 8)}` : base
  }

  if (type === 'update_field') {
    const f = params?.['field'] as string | undefined
    const v = params?.['value'] as string | undefined
    return f ? `${base}: ${f}=${v ?? '?'}` : base
  }

  if (type === 'call_webhook') {
    const url = params?.['url'] as string | undefined
    if (url) {
      try { return `${base}: ${new URL(url).hostname}` } catch { return base }
    }
    return base
  }

  return base
}

export function paramsToRaw(type: string, params?: Record<string, unknown>): Record<string, string> {
  if (!params) return {}
  if (type === 'sla_start' || type === 'sla_stop') return { sla_type: String(params['sla_type'] ?? 'response') }
  if (type === 'create_entity') return {
    entity_type:     String(params['entity_type']     ?? 'incident'),
    title_template:  String(params['title_template']  ?? ''),
    link_to_current: String(params['link_to_current'] ?? 'true'),
    copy_fields:     Array.isArray(params['copy_fields']) ? (params['copy_fields'] as string[]).join(',') : String(params['copy_fields'] ?? ''),
  }
  if (type === 'assign_to') return {
    target_type: String(params['target_type'] ?? 'team'),
    target_id:   String(params['target_id']   ?? ''),
    target_name: String(params['target_name'] ?? ''),
  }
  if (type === 'update_field') return {
    field: String(params['field'] ?? ''),
    value: String(params['value'] ?? ''),
  }
  if (type === 'call_webhook') return {
    url:              String(params['url']              ?? ''),
    method:           String(params['method']           ?? 'POST'),
    payload_template: String(params['payload_template'] ?? ''),
  }
  if (type === 'create_approval_request') return {
    title_template: String(params['title_template'] ?? ''),
    approver_role:  String(params['approver_role']  ?? 'admin'),
    approval_type:  String(params['approval_type']  ?? 'any'),
    /**
     * Persone e squadre che approvano (moduli del catalogo, ondata 3). Gli id
     * arrivano come lista JSON o come stringa: qui diventano una stringa,
     * perché l'editor tiene i parametri come testo. Li rilegge un solo posto,
     * `approverIdList` in packages/workflow.
     */
    approver_user_ids: listaIdComeTesto(params['approver_user_ids']),
    approver_team_ids: listaIdComeTesto(params['approver_team_ids']),
  }
  if (type === 'create_task') return {
    title_template: String(params['title_template'] ?? ''),
    team_id:        String(params['team_id']        ?? ''),
    description:    String(params['description']    ?? ''),
    due_in_days:    params['due_in_days'] == null ? '' : String(params['due_in_days']),
    after:          String(params['after']          ?? ''),
    team_from_field: String(params['team_from_field'] ?? ''),
  }
  /**
   * Un tipo senza un ramo suo NON perde i suoi parametri: si leggono come
   * testo, che è come li tiene l'editor. Prima qui c'era `return {}`, e
   * aprire un'azione di un tipo non previsto la mostrava vuota — pronta a
   * essere risalvata senza niente dentro. Vedi il gemello in
   * `buildActionParams`.
   */
  return Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v == null ? '' : String(v)]))
}

/** Una lista di id (JSON o stringa) come stringa separata da virgola, per l'editor. */
function listaIdComeTesto(raw: unknown): string {
  if (raw == null) return ''
  const parti = Array.isArray(raw) ? raw : String(raw).split(',')
  return parti.map((x) => String(x).trim()).filter(Boolean).join(',')
}

export function buildActionParams(type: string, raw: Record<string, string>): Record<string, unknown> {
  if (type === 'sla_start' || type === 'sla_stop') {
    return { sla_type: raw['sla_type'] ?? 'response' }
  }
  if (type === 'create_entity') {
    const copyFields = raw['copy_fields'] ? raw['copy_fields'].split(',').map((s) => s.trim()).filter(Boolean) : []
    return {
      entity_type:     raw['entity_type']    ?? 'incident',
      title_template:  raw['title_template'] ?? '',
      link_to_current: raw['link_to_current'] !== 'false',
      ...(copyFields.length > 0 ? { copy_fields: copyFields } : {}),
    }
  }
  if (type === 'assign_to') {
    return {
      target_type: raw['target_type'] ?? 'team',
      ...(raw['target_id']   ? { target_id:   raw['target_id']   } : {}),
      ...(raw['target_name'] ? { target_name: raw['target_name'] } : {}),
    }
  }
  if (type === 'update_field') {
    return { field: raw['field'] ?? '', value: raw['value'] ?? '' }
  }
  if (type === 'call_webhook') {
    return {
      url:              raw['url']              ?? '',
      method:           raw['method']           ?? 'POST',
      payload_template: raw['payload_template'] ?? '',
    }
  }
  if (type === 'create_approval_request') {
    // packages/workflow CreateApprovalRequestParams: prima questo ramo mancava
    // e l'azione veniva salvata con params {} (titolo/approvatori persi). Le
    // due chiavi nuove (ondata 3) si scrivono solo se hanno qualcosa: un
    // parametro vuoto salvato è un parametro che sembra configurato.
    const persone = (raw['approver_user_ids'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    const squadre = (raw['approver_team_ids'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    return {
      title_template: raw['title_template'] ?? '',
      approver_role:  raw['approver_role']  ?? 'admin',
      approval_type:  raw['approval_type']  ?? 'any',
      ...(persone.length > 0 ? { approver_user_ids: persone } : {}),
      ...(squadre.length > 0 ? { approver_team_ids: squadre } : {}),
    }
  }
  if (type === 'create_task') {
    // packages/workflow CreateTaskParams. Si scrive solo quello che ha un
    // valore: un parametro vuoto salvato è un parametro che sembra
    // configurato, e in «I miei compiti» diventa una squadra che non c'è.
    const giorni = (raw['due_in_days'] ?? '').trim()
    return {
      title_template: raw['title_template'] ?? '',
      ...(raw['team_id']?.trim()     ? { team_id:     raw['team_id'].trim() }     : {}),
      ...(raw['description']?.trim() ? { description: raw['description'].trim() } : {}),
      ...(giorni ? { due_in_days: Number(giorni) } : {}),
      ...(raw['after']?.trim() ? { after: raw['after'].trim() } : {}),
      ...(raw['team_from_field']?.trim() ? { team_from_field: raw['team_from_field'].trim() } : {}),
    }
  }
  /**
   * NIENTE `return {}` (20 set 2026). Era un fallback silenzioso, e la stessa
   * trappola è scattata due volte: la prima con `create_approval_request`
   * (titolo e approvatori persi), la seconda con `create_task`, trovata
   * provando nel browser — l'azione si salvava con `params: {}` e il compito
   * nasceva senza titolo né squadra, senza che niente lo dicesse.
   *
   * I rami qui sopra esistono per dare valori di default e convertire i tipi.
   * Un'azione che non ne ha bisogno tiene i suoi parametri come sono: si
   * perde al massimo una conversione, non il contenuto. Il guardiano
   * `__tests__/parametriAzioni.test.ts` verifica che nessun tipo offerto dal
   * disegnatore perda quello che ci si scrive dentro.
   */
  return { ...raw }
}

export function ActionBadge({ type, params }: { type: string; params?: Record<string, unknown> }) {
  const { t } = useTranslation()
  return (
    <span
      title={type}
      style={{
        fontSize:        10,
        padding:         '2px 6px',
        borderRadius:    4,
        backgroundColor: colors.brandLight,
        color:           colors.brand,
        fontWeight:      500,
        cursor:          'default',
      }}
    >
      {actionLabel(t, type, params)}
    </span>
  )
}

/**
 * QUALI COMPITI DEL PASSO SI POSSONO ASPETTARE (rimedio, 20 set 2026).
 *
 * La tendina «parte quando è chiuso» escludeva solo sé stessi, quindi «A
 * dopo B» **e** «B dopo A» erano entrambi scrivibili. Non dà errore: nascono
 * tutti e due in attesa, si aprono solo alla chiusura di un altro, e la
 * guardia conta anche le attese — il passo resta bloccato per sempre. Il
 * rilievo in Diagnostica non lo vede: cerca il titolo MANCANTE, non il
 * cerchio.
 *
 * Si tolgono sé stessi e chiunque, direttamente o per catena, aspetti già me.
 */
export function titoliCompitiOffribili(
  compiti: readonly { titolo: string; dopo: string }[],
  mio: string,
): string[] {
  const aspettaMe = new Set<string>()
  let cresciuta = true
  while (cresciuta) {
    cresciuta = false
    for (const c of compiti) {
      if (!c.titolo || aspettaMe.has(c.titolo)) continue
      if (c.dopo === mio || aspettaMe.has(c.dopo)) { aspettaMe.add(c.titolo); cresciuta = true }
    }
  }
  return [...new Set(compiti.map((c) => c.titolo))]
    .filter((t) => t && t !== mio && !aspettaMe.has(t))
}
