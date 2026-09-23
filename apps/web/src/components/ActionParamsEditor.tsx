/**
 * Renders type-specific param inputs for automation actions.
 *
 * Due vocabolari (vedi lib/automationOperators.ts):
 *  - `automation` (default): auto-trigger e business rule (actionExecutor).
 *  - `workflow_step`: azioni enter/exit degli step di workflow
 *    (packages/workflow) — stessi controlli, parametri persistiti invariati.
 */
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useQuery } from '@apollo/client/react'
import { GET_TEAMS, GET_WORKFLOW_LIST, GET_USERS, GET_FORM_REFERENCE_FIELDS } from '@/graphql/queries'
import { useEnumValues } from '@/hooks/useEnumValues'
import { useEntityFieldMetas, useFormFieldMetas, type FieldMeta } from '@/hooks/useEntityFields'
import { isStepFieldWritable, AUTOMATION_NOTIFICATION_CHANNELS } from '@opengraphity/types'
import { useTargetOptions, withCurrent, CHANNEL_LABEL_KEY } from '@/pages/settings/NotificationRuleList'
import { fieldTypeKey } from '@/lib/automationOperators'
import { inputS, selectS } from '@/pages/settings/shared/designerStyles'
import { Input, Select } from '@/components/ui/FormControls'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { useRoles } from '@/hooks/useRoles'
import { humanizeValue } from '@opengraphity/web-core'

interface Props {
  actionType: string
  params:     Record<string, string>
  entityType: string
  onChange:   (key: string, value: string) => void
  vocabulary?: 'automation' | 'workflow_step'
  /**
   * I titoli degli ALTRI compiti dello stesso passo: `create_task` li offre
   * in tendina per dire «parte quando quello è chiuso». Li conosce solo chi
   * ha in mano il passo intero (il pannello), non questo editor.
   */
  compitiFratelli?: readonly string[]
}

const textareaS: React.CSSProperties = { ...inputS, minHeight: 60, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }
const monoS: React.CSSProperties     = { ...inputS, minHeight: 80, resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-body)', lineHeight: 1.5 }
const labelS: React.CSSProperties    = { fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.06em' }

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 120 }}>
      <span style={labelS}>{label}</span>
      {children}
    </div>
  )
}

export function ActionParamsEditor({ actionType, params, entityType, onChange, vocabulary = 'automation', compitiFratelli = [] }: Props) {
  const { t } = useTranslation()
  const targetOptions = useTargetOptions()
  const { data: teamsData }    = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const { data: usersData }    = useQuery<{ users: { id: string; name: string; email: string }[] }>(GET_USERS, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const { data: workflowData } = useQuery<{ workflowDefinitions: { id: string; name: string; entityType: string; steps: { name: string; label: string }[] }[] }>(GET_WORKFLOW_LIST, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const { values: priorityValues } = useEnumValues(entityType || 'incident', 'priority')
  const { labelOf, entriesOf } = useDomainVocabularies()
  const { values: severityValues } = useEnumValues(entityType || 'incident', 'severity')
  const { fields: metamodelFields } = useEntityFieldMetas(entityType)
  /**
   * I campi dei MODULI che un'automazione può scrivere (ondata 8): solo quelli
   * a valore singolo e senza formula — `settableByAutomation` lo decide l'API,
   * che è anche quella che rifiuta gli altri. Un nome che il metamodello ha già
   * vince: è quello che il ticket scrive davvero.
   */
  const daiModuli = useFormFieldMetas(entityType, { soloScrivibili: true })
  const fieldMetas = [...metamodelFields, ...daiModuli.filter((f) => !metamodelFields.some((m) => m.name === f.name))]
  // F-16: i ruoli del cliente, per l'azione «richiedi approvazione».
  const { roles, labelOf: roleLabelOf } = useRoles()
  /**
   * I CAMPI SQUADRA dei moduli: l'azione «crea un compito» può prendere la
   * squadra da lì invece che sceglierla una volta per tutte. Si chiedono solo
   * quando servono — è una query in più su ogni apertura del pannello.
   */
  const { data: campiModulo } = useQuery<{ formReferenceFields: { name: string; label: string; fieldType: string }[] }>(
    GET_FORM_REFERENCE_FIELDS, { skip: actionType !== 'create_task', fetchPolicy: METAMODEL_FETCH_POLICY },
  )
  /**
   * I campi da cui si può ricavare una squadra: quelli SQUADRA (la risposta
   * è la squadra) e quelli CI (la squadra è chi supporta il CI scelto). Una
   * tendina sola, perché per chi disegna è la stessa domanda: «da dove la
   * prendo?».
   */
  const campiSquadra = (campiModulo?.formReferenceFields ?? []).filter((f) => f.fieldType === 'ref_team' || f.fieldType === 'ref_ci')

  const teams = teamsData?.teams ?? []
  const users = usersData?.users ?? []
  const steps = (workflowData?.workflowDefinitions ?? [])
    .filter(w => w.entityType === entityType)
    .flatMap(w => w.steps ?? [])
    .filter((s, i, arr) => arr.findIndex(x => x.name === s.name) === i)

  const selectedFieldMeta = fieldMetas.find(f => f.name === params['field'])
  // `update_field` (vocabolario workflow_step) scrive ogni campo del
  // metamodello che non è riservato (ondata 3 di «Cosa resta cablato»): le
  // stesse riserve che il motore applica a runtime e l'API in scrittura. Le
  // relazioni (utente, team) si assegnano con `assign_to`.
  const updatableFields = fieldMetas.filter(f => isStepFieldWritable(f.name, entityType) && f.fieldType !== 'user' && f.fieldType !== 'team')

  const text = (key: string, label: string, placeholder = '', type = 'text') => (
    <Labeled key={key} label={label}>
      <Input type={type} style={inputS} placeholder={placeholder} value={params[key] ?? ''} onChange={e => onChange(key, e.target.value)} />
    </Labeled>
  )
  const choice = (key: string, label: string, options: { value: string; label?: string }[], fallback: string) => (
    <Labeled key={key} label={label}>
      <Select style={selectS} value={params[key] ?? fallback} onChange={e => onChange(key, e.target.value)}>
        {options.map(o => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
      </Select>
    </Labeled>
  )

  switch (actionType) {
    // ── Vocabolario automation (actionExecutor) ───────────────────────────────
    case 'assign_team':
      return (
        <Select style={{ ...selectS, flex: 1 }} value={params['team_id'] ?? ''} onChange={e => onChange('team_id', e.target.value)}>
          <option value="">{t('automation.params.selectTeam')}</option>
          {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      )

    case 'assign_user':
      return (
        <Select style={{ ...selectS, flex: 1 }} value={params['user_id'] ?? ''} onChange={e => onChange('user_id', e.target.value)}>
          <option value="">{t('automation.params.selectUser')}</option>
          {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
        </Select>
      )

    case 'transition_workflow':
      return (
        <Select style={{ ...selectS, flex: 1 }} value={params['to_step'] ?? ''} onChange={e => onChange('to_step', e.target.value)}>
          <option value="">{t('automation.params.selectStep')}</option>
          {steps.map(s => <option key={s.name} value={s.name}>{s.label || s.name}</option>)}
        </Select>
      )

    case 'set_priority':
      return (
        <Select style={{ ...selectS, flex: 1 }} value={params['priority'] ?? ''} onChange={e => onChange('priority', e.target.value)}>
          <option value="">{t('automation.params.selectPriority')}</option>
          {/*
            L'etichetta del vocabolario che si sta offrendo davvero: `priority`
            se il tipo lo dichiara, altrimenti `severity` (per l'incident era
            l'unico che esistesse, prima dell'ondata 2).
          */}
          {(priorityValues.length > 0 ? priorityValues : severityValues).map(v =>
            <option key={v} value={v} title={v}>
              {labelOf(priorityValues.length > 0 ? 'priority' : 'severity', v) ?? humanizeValue(v)}
            </option>
          )}
        </Select>
      )

    case 'set_field':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {/* Field dropdown */}
          <Select
            style={{ ...selectS, width: 160 }}
            value={params['field'] ?? ''}
            onChange={e => { onChange('field', e.target.value); onChange('value', '') }}
          >
            <option value="">{t('automation.params.selectFieldOption')}</option>
            {fieldMetas.map(f => (
              <option key={f.name} value={f.name}>{f.label} ({t(fieldTypeKey(f.fieldType))})</option>
            ))}
          </Select>
          {/* Value input — adapts to field type */}
          {renderFieldValue(params['value'] ?? '', v => onChange('value', v), selectedFieldMeta, users, teams, labelOf, t)}
        </div>
      )

    case 'create_notification':
      // A chi arriva e da dove (AU-2): prima l'azione non consegnava niente,
      // e non si poteva dire a chi.
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          <Select style={{ ...selectS, width: 180 }} aria-label={t('automation.params.notificationTarget')} value={params['target'] ?? 'all'} onChange={e => onChange('target', e.target.value)}>
            {withCurrent(targetOptions, params['target'] ?? 'all').map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          <Select style={{ ...selectS, width: 140 }} aria-label={t('automation.params.notificationChannel')} value={params['channel'] ?? 'in_app'} onChange={e => onChange('channel', e.target.value)}>
            {AUTOMATION_NOTIFICATION_CHANNELS.map(c => <option key={c} value={c}>{t(CHANNEL_LABEL_KEY[c] ?? c)}</option>)}
          </Select>
          <textarea aria-label={t('automation.params.notificationMessage')} style={{ ...textareaS, flex: 1, minWidth: 200 }} placeholder={t('automation.params.notificationMessage')} value={params['message'] ?? ''} onChange={e => onChange('message', e.target.value)} />
        </div>
      )

    case 'create_comment':
      return (
        <textarea aria-label={t('automation.params.commentText')} style={{ ...textareaS, flex: 1 }} placeholder={t('automation.params.commentText')} value={params['text'] ?? ''} onChange={e => onChange('text', e.target.value)} />
      )

    case 'execute_script':
      return (
        <textarea aria-label={t('a11y.scriptCode')} style={{ ...monoS, flex: 1 }} placeholder="// JavaScript (isolated-vm, timeout 5s)..." value={params['code'] ?? ''} onChange={e => onChange('code', e.target.value)} />
      )

    case 'call_webhook':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          <Select style={{ ...selectS, width: 90 }} value={params['method'] ?? 'POST'} onChange={e => onChange('method', e.target.value)}>
            <option value="POST">POST</option>
            <option value="PUT">PUT</option>
            <option value="GET">GET</option>
          </Select>
          <Input style={{ ...inputS, flex: 1, minWidth: 200 }} placeholder="https://..." value={params['url'] ?? ''} onChange={e => onChange('url', e.target.value)} />
          {vocabulary === 'workflow_step' && text('payload_template', 'payload_template (JSON)', '{}')}
        </div>
      )

    case 'set_sla':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1 }}>
          <Input style={{ ...inputS, width: 100 }} type="number" placeholder={t('automation.params.responseMinutes')} value={params['response_minutes'] ?? ''} onChange={e => onChange('response_minutes', e.target.value)} />
          <Input style={{ ...inputS, width: 100 }} type="number" placeholder={t('automation.params.resolveMinutes')} value={params['resolve_minutes'] ?? ''} onChange={e => onChange('resolve_minutes', e.target.value)} />
        </div>
      )

    // ── Vocabolario workflow_step (packages/workflow) ─────────────────────────
    case 'sla_start':
    case 'sla_stop':
      return choice('sla_type', 'sla_type', [{ value: 'response' }, { value: 'resolve' }], 'response')

    case 'create_entity':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {choice('entity_type', 'entity_type', [{ value: 'incident' }, { value: 'problem' }, { value: 'change' }], 'incident')}
          {/* Una change nasce solo con un tipo del vocabolario del cliente: non c'è un default (verifica «Cosa resta cablato», ondata 1). */}
          {params['entity_type'] === 'change' && (
            <Labeled label="change_type">
              <Select style={selectS} value={params['change_type'] ?? ''} onChange={e => onChange('change_type', e.target.value)}>
                <option value="">{t('automation.params.selectChangeType')}</option>
                {(entriesOf('change_type') ?? []).map((e) => <option key={e.value} value={e.value}>{e.label}</option>)}
              </Select>
            </Labeled>
          )}
          {text('title_template', 'title_template', '{title} — escalated')}
          {choice('link_to_current', 'link_to_current', [{ value: 'true' }, { value: 'false' }], 'true')}
          {text('copy_fields', 'copy_fields (comma-sep)', 'severity,priority')}
        </div>
      )

    case 'assign_to': {
      const targetType = params['target_type'] ?? 'team'
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {choice('target_type', 'target_type', [{ value: 'team' }, { value: 'user' }], 'team')}
          <Labeled label="target_id">
            <Select style={selectS} value={params['target_id'] ?? ''} onChange={e => onChange('target_id', e.target.value)}>
              <option value="">{t(targetType === 'user' ? 'automation.params.userOption' : 'automation.params.teamOption')}</option>
              {targetType === 'user'
                ? users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)
                : teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Labeled>
          {text('target_name', 'target_name (template)', '{assigned_team}')}
        </div>
      )
    }

    case 'update_field': {
      const updateMeta = updatableFields.find(f => f.name === params['field'])
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          <Labeled label="field">
            {/*
              Ogni campo del metamodello che un passo può scrivere (riserve in
              @opengraphity/types, ondata 3). `status` e gli altri campi del
              motore restano fuori: configurarli qui faceva divergere lo stato
              del ticket dal passo del processo (B-9).
            */}
            <Select style={selectS} value={params['field'] ?? ''} onChange={e => { onChange('field', e.target.value); onChange('value', '') }}>
              <option value="">{t('automation.params.pickField')}</option>
              {updatableFields.map(f => (
                <option key={f.name} value={f.name}>{f.label} ({t(fieldTypeKey(f.fieldType))})</option>
              ))}
              {/* Valore già salvato ma non più ammesso: resta visibile invece di sembrare un altro campo. */}
              {params['field'] && !updatableFields.some(f => f.name === params['field']) && (
                <option value={params['field']}>{params['field']} ({t('automation.params.notAllowed')})</option>
              )}
            </Select>
          </Labeled>
          {/* Un campo di vocabolario sceglie fra i SUOI valori, con le etichette del
              Dizionario; gli altri accettano anche un segnaposto ({title}). */}
          {updateMeta?.fieldType === 'enum' && updateMeta.enumValues.length > 0 ? (
            <Labeled label="value">
              <Select style={selectS} value={params['value'] ?? ''} onChange={e => onChange('value', e.target.value)}>
                <option value="">{t('automation.params.selectValue')}</option>
                {updateMeta.enumValues.map(v => (
                  <option key={v} value={v} title={v}>{(updateMeta.enumTypeName ? labelOf(updateMeta.enumTypeName, v) : null) ?? v}</option>
                ))}
              </Select>
            </Labeled>
          ) : text('value', 'value', '{title}')}
        </div>
      )
    }

    /**
     * UN COMPITO DA FARE per una squadra, all'ingresso nel passo (20 set 2026).
     *
     * Il TIPO del compito non si sceglie qui: lo eredita dalla definizione di
     * workflow che contiene il passo. È la prima delle tre difese sulla regola
     * «un compito di tipo incident non sta su una change» — qui non è
     * nemmeno esprimibile.
     */
    case 'create_task':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {text('title_template', 'title_template', t('workflow.actionParams.taskTitleExample'))}
          <Labeled label="team_id">
            <Select style={selectS} value={params['team_id'] ?? ''} onChange={(e) => onChange('team_id', e.target.value)}>
              <option value="">{t('automation.params.selectTeam')}</option>
              {teams.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Labeled>
          {/*
            …oppure la squadra che sta in un CAMPO del modulo: è la strada per
            cui «Sede: Milano» finisce al Desk di Milano. Vince sulla squadra
            fissa qui sopra, e il pannello lo dice invece di lasciarlo capire.
          */}
          {campiSquadra.length > 0 && (
            <Labeled label={t('workflow.actionParams.taskTeamFromField')}>
              <Select style={selectS} value={params['team_from_field'] ?? ''} onChange={(e) => onChange('team_from_field', e.target.value)}>
                <option value="">{t('workflow.actionParams.taskTeamFromFieldNone')}</option>
                {campiSquadra.map((f) => <option key={f.name} value={f.name}>{f.label || f.name}</option>)}
              </Select>
            </Labeled>
          )}
          {params['team_from_field'] && params['team_id'] && (
            <p style={{ flexBasis: '100%', margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-warning-text)' }}>
              {t('workflow.actionParams.taskTeamFieldWins')}
            </p>
          )}
          {text('due_in_days', 'due_in_days', t('workflow.actionParams.taskDueExample'), 'number')}
          {text('description', 'description', t('workflow.actionParams.taskDescriptionExample'))}
          {/*
            LA SEQUENZA, compito per compito: vuoto = parte subito, che è il
            caso normale. Si sceglie fra i compiti dello STESSO passo, per
            titolo — quello che poi si legge sulla pagina del ticket. Senza
            fratelli la tendina non compare: non c'è niente da aspettare.
          */}
          {compitiFratelli.length > 0 && (
            <Labeled label={t('workflow.actionParams.taskAfter')}>
              <Select style={selectS} value={params['after'] ?? ''} onChange={(e) => onChange('after', e.target.value)}>
                <option value="">{t('workflow.actionParams.taskAfterNone')}</option>
                {compitiFratelli.map((titolo) => <option key={titolo} value={titolo}>{titolo}</option>)}
              </Select>
            </Labeled>
          )}
        </div>
      )

    case 'create_approval_request':
      return (
        <div style={{ display: 'flex', gap: 6, flex: 1, flexWrap: 'wrap' }}>
          {text('title_template', 'title_template', t('workflow.actionParams.approvalTitleExample'))}
          {/* I ruoli sono del CLIENTE (revisione totale · F-16): le due scelte
              cablate `admin`/`manager` potevano non esistere, e l'azione
              «richiedi approvazione» non trovava mai destinatari. */}
          {choice('approver_role', 'approver_role',
            roles.map((r) => ({ value: r.key, label: roleLabelOf(r.key) })),
            params['approver_role'] ?? roles[0]?.key ?? '')}
          {/* Le tre modalità sono TESTO per chi legge, non nomi di parametro:
              erano in inglese nel sorgente (revisione totale · i 29 warning).
              I nomi dei parametri accanto (`approver_role`, `title_template`)
              restano invece grezzi di proposito: sono il contratto con
              l'automazione, e si scrivono così anche in italiano. */}
          {choice('approval_type', 'approval_type', [
            { value: 'any',      label: t('workflow.actionParams.approvalType.any') },
            { value: 'all',      label: t('workflow.actionParams.approvalType.all') },
            { value: 'majority', label: t('workflow.actionParams.approvalType.majority') },
          ], 'any')}
          {/*
            Persone e squadre che approvano (moduli del catalogo, ondata 3).
            Il RUOLO non basta per un catalogo servizi: l'approvazione di una
            spesa è del responsabile di budget, non di chi amministra il
            prodotto. Le tre sorgenti si UNISCONO; indicando persone o squadre
            il ruolo viene ignorato, e il pannello lo dice.
            Gli id vanno come stringa separata da virgola perché questo editor
            tiene i parametri come testo: a leggerli c'è un solo posto
            (`approverIdList` in packages/workflow).
          */}
          <Labeled label="approver_user_ids">
            <Select
              style={{ ...selectS, flex: 1 }}
              value=""
              onChange={(e) => {
                if (!e.target.value) return
                const attuali = (params['approver_user_ids'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
                if (!attuali.includes(e.target.value)) onChange('approver_user_ids', [...attuali, e.target.value].join(','))
              }}
            >
              <option value="">{t('workflow.actionParams.addApprover')}</option>
              {(usersData?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name || u.email}</option>)}
            </Select>
            <ElencoScelti
              ids={params['approver_user_ids'] ?? ''}
              nomeDi={(id) => (usersData?.users ?? []).find((u) => u.id === id)?.name ?? id}
              onChange={(v) => onChange('approver_user_ids', v)}
            />
          </Labeled>
          <Labeled label="approver_team_ids">
            <Select
              style={{ ...selectS, flex: 1 }}
              value=""
              onChange={(e) => {
                if (!e.target.value) return
                const attuali = (params['approver_team_ids'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
                if (!attuali.includes(e.target.value)) onChange('approver_team_ids', [...attuali, e.target.value].join(','))
              }}
            >
              <option value="">{t('workflow.actionParams.addApproverTeam')}</option>
              {(teamsData?.teams ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </Select>
            <ElencoScelti
              ids={params['approver_team_ids'] ?? ''}
              nomeDi={(id) => (teamsData?.teams ?? []).find((x) => x.id === id)?.name ?? id}
              onChange={(v) => onChange('approver_team_ids', v)}
            />
          </Labeled>
          {(params['approver_user_ids'] || params['approver_team_ids']) && (
            <p style={{ flexBasis: '100%', margin: 0, fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>
              {t('workflow.actionParams.approverRoleIgnored')}
            </p>
          )}
        </div>
      )

    default:
      return <Input style={{ ...inputS, flex: 1 }} placeholder={t('automation.params.generic')} value={params['value'] ?? ''} onChange={e => onChange('value', e.target.value)} />
  }
}

function renderFieldValue(
  value: string,
  onValue: (v: string) => void,
  field: FieldMeta | undefined,
  users: { id: string; name: string; email: string }[],
  teams: { id: string; name: string }[],
  labelOf: (vocabolario: string, valore: string) => string | null,
  t: TFunction,
) {
  if (!field) return <Input style={{ ...inputS, flex: 1 }} placeholder={t('automation.params.pickField')} disabled />

  if (field.fieldType === 'enum' && field.enumValues.length > 0) {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">{t('automation.params.selectValue')}</option>
        {field.enumValues.map(v => (
          <option key={v} value={v} title={v}>
            {(field.enumTypeName ? labelOf(field.enumTypeName, v) : null) ?? v}
          </option>
        ))}
      </Select>
    )
  }

  if (field.fieldType === 'user') {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">{t('automation.params.userOption')}</option>
        {users.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
      </Select>
    )
  }

  if (field.fieldType === 'team') {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">{t('automation.params.teamOption')}</option>
        {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
      </Select>
    )
  }

  if (field.fieldType === 'boolean') {
    return (
      <Select style={{ ...selectS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)}>
        <option value="">{t('automation.params.selectValue')}</option>
        <option value="true">{t('common.yes')}</option>
        <option value="false">{t('common.no')}</option>
      </Select>
    )
  }

  if (field.fieldType === 'date') {
    return <Input type="date" style={{ ...inputS, flex: 1 }} value={value} onChange={e => onValue(e.target.value)} />
  }

  if (field.fieldType === 'number') {
    return <Input type="number" style={{ ...inputS, flex: 1 }} placeholder={t('automation.params.value')} value={value} onChange={e => onValue(e.target.value)} />
  }

  return <Input style={{ ...inputS, flex: 1 }} placeholder={t('automation.params.value')} value={value} onChange={e => onValue(e.target.value)} />
}

/**
 * Gli id scelti, coi loro nomi e una × per toglierli. Gli id viaggiano come
 * stringa separata da virgola (vedi il commento in `create_approval_request`):
 * qui si mostrano come nomi, perché un elenco di identificativi non si rilegge.
 */
function ElencoScelti({ ids, nomeDi, onChange }: { ids: string; nomeDi: (id: string) => string; onChange: (v: string) => void }) {
  const elenco = ids.split(',').map((x) => x.trim()).filter(Boolean)
  if (elenco.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
      {elenco.map((id) => (
        <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--color-slate-bg)', borderRadius: 4, padding: '1px 6px', fontSize: 'var(--font-size-table)', color: 'var(--color-slate-dark)' }}>
          {nomeDi(id)}
          <button
            type="button"
            aria-label={`${nomeDi(id)} ×`}
            onClick={() => onChange(elenco.filter((x) => x !== id).join(','))}
            style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', padding: 0, lineHeight: 1 }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  )
}
