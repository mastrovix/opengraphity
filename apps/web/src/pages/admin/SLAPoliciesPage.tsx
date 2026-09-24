import { useId } from 'react'
import { InvalidFilterNotice } from '@/components/InvalidFilterNotice'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { useItilTypeLabels } from '@/hooks/useItilTypeLabels'
import type { TFunction } from 'i18next'
import { useEnumValues } from '@/hooks/useEnumValues'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { FilterBuilder, type FieldConfig } from '@/components/FilterBuilder'
import { Shield, Plus, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { GET_SLA_POLICIES, GET_TEAMS } from '@/graphql/queries'
import { CREATE_SLA_POLICY, UPDATE_SLA_POLICY, DELETE_SLA_POLICY } from '@/graphql/mutations'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Select } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { Toggle } from '@/components/ui/Toggle'
import { selectS, labelS } from '@/components/ui/styles'
import { useListQueryState } from '@/hooks/useListQueryState'
import { useCrudModal } from '@/hooks/useCrudModal'
import { useConfirm } from '@/hooks/useConfirm'
import { ALWAYS_ON, ComplianceFields, TimeCountingField, calendarChoiceOf, calendarIdFor, complianceValid, useServiceCalendars } from '@/components/sla/ServiceTargetFields'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SLAPolicy {
  id: string; name: string; entityType: string; priority: string | null
  category: string | null; teamId: string | null; teamName: string | null
  timezone: string | null; responseMinutes: number; resolveMinutes: number
  businessHours: boolean; calendarId: string | null; calendarName: string | null
  complianceTarget: number | null; complianceWarning: number | null
  warningMinutes: number; enabled: boolean
}

interface Team { id: string; name: string }

type FormState = {
  name: string; entityType: string; priority: string; category: string
  teamId: string; responseMinutes: number; resolveMinutes: number
  /** `''` nessuna scelta, `24x7`, o l'id di un calendario (components/sla/ServiceTargetFields). */
  calendarChoice: string; timezone: string; warningMinutes: number
  complianceTarget: string; complianceWarning: string
}

const EMPTY_FORM: FormState = {
  name: '', entityType: 'incident', priority: '', category: '',
  teamId: '', responseMinutes: 60, resolveMinutes: 480,
  // Fuso vuoto = quello del cliente: lo sceglie l'API, non una costante qui.
  // Come conta il tempo e l'obiettivo di conformità si scelgono: nessun valore di partenza (ondata 2).
  calendarChoice: '', timezone: '', complianceTarget: '', complianceWarning: '',
  // Il valore con cui nasce una policy: si cambia qui sotto (NT-8/F6).
  warningMinutes: DEFAULT_SLA_WARNING_MINUTES,
}

const policyToForm = (p: SLAPolicy): FormState => ({
  name: p.name, entityType: p.entityType, priority: p.priority ?? '',
  category: p.category ?? '', teamId: p.teamId ?? '',
  responseMinutes: p.responseMinutes, resolveMinutes: p.resolveMinutes,
  calendarChoice: calendarChoiceOf(p.calendarId, p.businessHours), timezone: p.timezone ?? '', warningMinutes: p.warningMinutes,
  complianceTarget: p.complianceTarget == null ? '' : String(p.complianceTarget),
  complianceWarning: p.complianceWarning == null ? '' : String(p.complianceWarning),
})

import { SLA_ENTITY_TYPES as ENTITY_TYPES, SLA_CATEGORY_ENTITY_TYPES, DEFAULT_SLA_WARNING_MINUTES } from '@opengraphity/types'
import { useDomainVocabularies } from '@/contexts/DomainVocabularyContext'
import { palette } from '@/lib/tokens'
import { showError } from '@/lib/showError'

type VocabEntries = ReadonlyArray<{ value: string; label?: string | null }>
// Valori e etichette dai vocabolari del cliente: prima erano tre liste scritte qui.
const slaFilterFields = (t: TFunction, priorities: VocabEntries, categories: VocabEntries, labelOf: (entityType: string) => string): FieldConfig[] => [
  { key: 'entityType', label: t('admin.sla.entityType'), type: 'enum', options:
    ENTITY_TYPES.map((et) => ({ value: et, label: labelOf(et) })) },
  { key: 'priority', label: t('admin.sla.priority'), type: 'enum', options:
    priorities.map((v) => ({ value: v.value, label: v.label ?? v.value })) },
  { key: 'category', label: t('admin.sla.category'), type: 'enum', options:
    categories.map((v) => ({ value: v.value, label: v.label ?? v.value })) },
  { key: 'enabled', label: t('admin.sla.enabled'), type: 'enum', options: [
    { value: 'true', label: t('common.yes') }, { value: 'false', label: t('common.no') },
  ]},
  { key: 'name', label: t('common.name'), type: 'text' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Le unita (min / h / g) sono ABBREVIAZIONI a schermo: vengono dalle chiavi,
 * perche «gg» in inglese e «d». Il resto e aritmetica.
 */
function fmtMinutes(m: number, t: TFunction): string {
  const u = (k: string, n: number) => t(`admin.sla.unit.${k}`, { count: n })
  if (m < 60) return u('minutes', m)
  if (m < 1440) return m % 60 === 0 ? u('hours', m / 60) : `${u('hours', Math.floor(m / 60))} ${u('minutes', m % 60)}`
  const d = m / 1440
  return d === Math.floor(d) ? u('days', d) : `${u('days', Math.floor(d))} ${fmtMinutes(m % 1440, t)}`
}

function scopeParts(entityType: string, priority: string | null, category: string | null, teamName: string | null, t: TFunction, label: (vocab: string, v: string) => string): string[] {
  const parts: string[] = []
  // For an incident the stored `priority` is the severity the engine matches: say so, as the form does.
  if (priority) parts.push(entityType === 'incident'
    ? t('admin.sla.scopeSeverity', { value: label('severity', priority) })
    : t('admin.sla.scopePriority', { value: label('priority', priority) }))
  if (category) parts.push(t('admin.sla.scopeCategory', { value: label('category', category) }))
  if (teamName) parts.push(t('admin.sla.scopeTeam',     { value: teamName }))
  return parts
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SLAPoliciesPage() {
  const { t } = useTranslation()
  // F16: le etichette dei tipi ITIL vengono dal metamodello del cliente.
  const { labelOf: typeLabel } = useItilTypeLabels()
  const confirm = useConfirm()
  const list  = useListQueryState()
  const modal = useCrudModal<SLAPolicy, FormState>(EMPTY_FORM, policyToForm)
  const { draft: form, patch } = modal
  /**
   * IL CAMPO CHE IL MOTORE CONFRONTA, non quello che l'etichetta prometteva.
   *
   * `SLAPolicyNode.priority` riceve, per un incident, la **severità**
   * (`resolvePolicy(…, severity)` la passa come argomento `priority` del
   * selettore); per problem e service request riceve la priorità. La tendina
   * leggeva invece `incident.priority` dal metamodello — un campo che non
   * esiste — quindi era **vuota**: su questa pagina non si poteva scrivere
   * nessuna policy per severità. Trovato aprendo la pagina su un tenant vero.
   *
   * E leggeva sempre `'incident'`, anche con «Problem» scelto: le categorie
   * offerte erano quelle degli incident.
   */
  const campoAmbito = form.entityType === 'incident' ? 'severity' : 'priority'
  const { values: PRIORITIES } = useEnumValues(form.entityType, campoAmbito)
  const { values: CATEGORIES } = useEnumValues(form.entityType, 'category')
  // La categoria vale solo per i ticket che ne hanno una: per gli altri il
  // motore non la vede, e l'API rifiuta la policy.
  const hasCategory = (SLA_CATEGORY_ENTITY_TYPES as readonly string[]).includes(form.entityType)
  const { entriesOf, labelOf } = useDomainVocabularies()
  const vocabLabel = (vocab: string, v: string) => labelOf(vocab, v) ?? labelOf('severity', v) ?? v

  const { data, loading, refetch } = useQuery<{ slaPolicies: SLAPolicy[] }>(GET_SLA_POLICIES, { variables: list.variables })
  const { data: teamsData }           = useQuery<{ teams: Team[] }>(GET_TEAMS)
  const { calendars }                 = useServiceCalendars()
  const policies: SLAPolicy[]        = data?.slaPolicies ?? []
  const teams: Team[]                 = teamsData?.teams ?? []

  // `refetch()` of the ACTIVE query keeps its sort/filter variables; a
  // `refetchQueries: [{ query }]` without variables would fill another cache
  // entry and leave the visible list stale (E-08). Errors are toasted by the
  // handlers below (they need the await for the success message).
  const uid = useId()
  const fid = (name: string) => `${uid}-${name}`
  const afterWrite = { onCompleted: () => { void refetch() } }
  const [createPolicy] = useMutation(CREATE_SLA_POLICY, afterWrite)
  const [updatePolicy] = useMutation(UPDATE_SLA_POLICY, afterWrite)
  const [deletePolicy] = useMutation(DELETE_SLA_POLICY, afterWrite)

  // Group by entity type
  const grouped = ENTITY_TYPES.reduce<Record<string, SLAPolicy[]>>((acc, et) => {
    const items = policies.filter(p => p.entityType === et)
    if (items.length) acc[et] = items
    return acc
  }, {})

  async function handleSave() {
    if (!form.name.trim()) { toast.error(t('toast.sla.nameRequired')); return }
    if (form.calendarChoice === '') { toast.error(t('serviceTargets.timeCountingRequired')); return }
    if (!complianceValid(form.complianceTarget, form.complianceWarning)) { toast.error(t('serviceTargets.complianceInvalid')); return }
    const common = {
      name: form.name.trim(),
      priority: form.priority || null, category: hasCategory ? (form.category || null) : null,
      teamId: form.teamId || null,
      responseMinutes: Number(form.responseMinutes), resolveMinutes: Number(form.resolveMinutes),
      calendarId: calendarIdFor(form.calendarChoice), timezone: form.timezone.trim() || null, warningMinutes: form.warningMinutes,
      complianceTarget: Number(form.complianceTarget), complianceWarning: Number(form.complianceWarning),
    }
    try {
      if (modal.editing) {
        await updatePolicy({ variables: { id: modal.editing.id, input: common } })
        toast.success(t('toast.sla.updated'))
      } else {
        await createPolicy({ variables: { input: { ...common, entityType: form.entityType } } })
        toast.success(t('toast.sla.created'))
      }
      modal.close()
    } catch (e: unknown) { showError(e) }
  }

  async function handleDelete(p: SLAPolicy) {
    const ok = await confirm({ title: t('admin.sla.deleteTitle'), body: p.name, danger: true })
    if (!ok) return
    try {
      await deletePolicy({ variables: { id: p.id } })
      toast.success(t('toast.sla.deleted'))
    } catch (e: unknown) { showError(e) }
  }

  async function handleToggle(p: SLAPolicy) {
    try {
      await updatePolicy({ variables: { id: p.id, input: { enabled: !p.enabled } } })
      toast.success(p.enabled ? t('toast.sla.disabled') : t('toast.sla.enabled'))
    } catch (e: unknown) { showError(e) }
  }

  const policyColumns: ColumnDef<SLAPolicy>[] = [
    /*
      Nome e AMBITO in due colonne, invece di cinque. C'erano «Nome» (con sotto
      in corsivo «Si applica a: Incident con categoria network»), «Ambito»,
      «Categoria» e «Team»: la frase ripeteva le tre colonne accanto, e nove
      colonne in una pagina di 700px spingevano fuori schermo proprio quella
      con la matita per modificare. Filtrare per priorita, categoria o team
      resta possibile dai filtri avanzati.
    */
    { key: 'name', label: t('common.name'), sortable: true, render: (v) => (
      <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{String(v)}</span>
    ) },
    { key: 'priority', label: t('admin.sla.appliesToColumn'), sortable: false, render: (_v, row) => {
      const scope = scopeParts(row.entityType, row.priority, row.category, row.teamName, t, vocabLabel)
      return (
        <span style={{ color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>
          {scope.length === 0 ? t('common.all') : scope.join(', ')}
        </span>
      )
    } },
    { key: 'responseMinutes', label: t('admin.sla.response'), sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{fmtMinutes(Number(v), t)}</span> },
    { key: 'resolveMinutes', label: t('admin.sla.resolution'), sortable: true, render: (v) => <span style={{ fontWeight: 500 }}>{fmtMinutes(Number(v), t)}</span> },
    { key: 'businessHours', label: t('serviceTargets.timeCounting'), sortable: true, width: '150px', render: (_v, row) => (
      row.businessHours
        ? <Pill bg={row.calendarName ? palette.success.tint : palette.danger.tint} color={row.calendarName ? palette.success.text : palette.danger.text} radius={10}>{row.calendarName ?? t('serviceTargets.noCalendar')}</Pill>
        : <Pill bg="var(--color-border-light)" color="var(--color-slate)" radius={10}>{t('serviceTargets.alwaysOn')}</Pill>
    ) },
    { key: 'complianceTarget', label: t('serviceTargets.targetColumn'), sortable: false, width: '100px', render: (_v, row) => (
      <span style={{ color: 'var(--color-slate)' }}>{row.complianceTarget == null ? '—' : `${row.complianceTarget}%`}</span>
    ) },
    { key: 'enabled', label: t('admin.rules.active'), sortable: true, render: (_v, row) => (
      <Toggle checked={row.enabled} onChange={() => void handleToggle(row)} label={t('admin.sla.toggleLabel', { name: row.name })} />
    ) },
    { key: 'id', label: t('common.actions'), sortable: false, render: (_v, row) => (
      <div style={{ display: 'inline-flex', gap: 6 }}>
        <Button variant="ghost" title={t('common.edit')} aria-label={t('common.edit')} onClick={() => modal.openEdit(row)} style={{ padding: 4 }}><Pencil size={15} aria-hidden="true" color="var(--color-slate)" /></Button>
        <Button variant="ghost" title={t('common.delete')} aria-label={t('common.delete')} onClick={() => handleDelete(row)} style={{ padding: 4 }}><Trash2 size={15} aria-hidden="true" color="var(--color-danger)" /></Button>
      </div>
    ) },
  ]

  // ── Preview text for modal form ───────────────────────────────────────────
  function formPreview(): string {
    const team = teams.find(tm => tm.id === form.teamId)
    const scope = scopeParts(form.entityType, form.priority, form.category, team?.name ?? null, t, vocabLabel)
    return scope.length === 0
      ? t('admin.sla.previewAll',  { entity: typeLabel(form.entityType) })
      : t('admin.sla.previewSome', { entity: typeLabel(form.entityType), scope: scope.join(', ') })
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <PageContainer>
      {/* F-17: un filtro dell'URL illeggibile si dice, non si ignora. */}
      <InvalidFilterNotice show={list.filtersInvalid} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Shield size={22} color="var(--color-icon-accent)" />}>{t('sidebar.slaPolicies')}</PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : t('pages.slaPolicies.count', { count: policies.length })}
          </p>
        </div>
        <Button icon={<Plus size={15} aria-hidden="true" />} onClick={modal.openCreate}>{t('pages.slaPolicies.newPolicy')}</Button>
      </div>

      {!loading && policies.length === 0 && (
        <EmptyState
          icon={<Shield size={32} color="var(--color-slate-light)" />}
          title={t('pages.slaPolicies.emptyTitle')}
          description={t('pages.slaPolicies.emptyDescription')}
        />
      )}

      <FilterBuilder fields={slaFilterFields(t, [...(entriesOf('severity') ?? []), ...(entriesOf('priority') ?? [])].filter((v, i, a) => a.findIndex((x) => x.value === v.value) === i), entriesOf('category') ?? [], typeLabel)} onApply={list.setFilterGroup} />

      {Object.entries(grouped).map(([entityType, items]) => (
        <div key={entityType} style={{ marginBottom: 28 }}>
          <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 8, textTransform: 'capitalize' }}>
            {typeLabel(entityType)}
          </h3>
          <SortableFilterTable<SLAPolicy>
            onSort={list.handleSort}
            sortField={list.sortField}
            sortDir={list.sortDir}
            columns={policyColumns}
            data={items}
            // Tutta la riga apre la modifica: non dipende piu dal vedere la colonna delle azioni.
            onRowClick={(row) => modal.openEdit(row)}
            loading={false}
            label={t('admin.sla.tableLabel', { entity: typeLabel(entityType) })}
          />
        </div>
      ))}

      {/* ── Create / Edit Modal ──────────────────────────────────────────────── */}
      <Modal
        open={modal.open}
        onClose={modal.close}
        title={t(modal.editing ? 'pages.slaPolicies.editPolicy' : 'pages.slaPolicies.newPolicy')}
        width={560}
        zIndex={9000}
        closeOnOverlay={false}
        footer={
          <>
            <Button variant="secondary" size="xs" onClick={modal.close}>{t('common.cancel')}</Button>
            <Button onClick={() => handleSave()}>{modal.editing ? t('common.save') : t('common.create')}</Button>
          </>
        }
      >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label htmlFor={fid('name')} style={labelS}>{t('pages.slaReport.nameRequired')}</label>
              <Input id={fid('name')} value={form.name} onChange={e => patch({ name: e.target.value })} placeholder={t('pages.slaPolicies.namePlaceholder')} />
            </div>

            <div className="og-pair">
              <div>
                <label htmlFor={fid('entity-type')} style={labelS}>{t('admin.sla.entityType')} *</label>
                <Select id={fid('entity-type')} style={selectS} value={form.entityType} onChange={e => patch({ entityType: e.target.value })} disabled={modal.isEditing}>
                  {ENTITY_TYPES.map(et => <option key={et} value={et}>{typeLabel(et)}</option>)}
                </Select>
              </div>
              <div>
                <label htmlFor={fid('priority')} style={labelS}>{t(campoAmbito === 'severity' ? 'admin.sla.severity' : 'admin.sla.priority')}</label>
                <Select id={fid('priority')} style={selectS} value={form.priority} onChange={e => patch({ priority: e.target.value })} aria-describedby={fid('scope-hint')}>
                  <option value="">{t('admin.sla.anyScope')}</option>
                  {PRIORITIES.map(p => <option key={p} value={p}>{vocabLabel(campoAmbito, p)}</option>)}
                </Select>
                <p id={fid('scope-hint')} style={{ margin: '4px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate)' }}>
                  {t(form.entityType === 'incident' ? 'admin.sla.scopeHintIncident' : 'admin.sla.scopeHintOther')}
                </p>
              </div>
            </div>

            <div className="og-pair">
              {hasCategory && (
                <div>
                  <label htmlFor={fid('category')} style={labelS}>{t('admin.sla.category')}</label>
                  <Select id={fid('category')} style={selectS} value={form.category} onChange={e => patch({ category: e.target.value })}>
                    <option value="">{t('admin.sla.anyScope')}</option>
                    {CATEGORIES.map(c => <option key={c} value={c}>{vocabLabel('category', c)}</option>)}
                  </Select>
                </div>
              )}
              <div>
                <label htmlFor={fid('team')} style={labelS}>{t('admin.sla.team')}</label>
                <Select id={fid('team')} style={selectS} value={form.teamId} onChange={e => patch({ teamId: e.target.value })}>
                  <option value="">{t('admin.sla.anyTeam')}</option>
                  {teams.map(tm => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
                </Select>
              </div>
            </div>

            <div className="og-pair">
              <div>
                <label htmlFor={fid('response-minutes')} style={labelS}>{t('pages.slaPolicies.responseMinutes')}</label>
                <Input id={fid('response-minutes')} type="number" min={1} value={form.responseMinutes} onChange={e => patch({ responseMinutes: Number(e.target.value) })} />
              </div>
              <div>
                <label htmlFor={fid('resolve-minutes')} style={labelS}>{t('pages.slaPolicies.resolveMinutes')}</label>
                <Input id={fid('resolve-minutes')} type="number" min={1} value={form.resolveMinutes} onChange={e => patch({ resolveMinutes: Number(e.target.value) })} />
              </div>
            </div>

            <div>
              <label htmlFor={fid('warning-minutes')} style={labelS}>{t('pages.slaPolicies.warningMinutes')}</label>
              <Input id={fid('warning-minutes')} type="number" min={1} max={Math.max(1, form.resolveMinutes - 1)} value={form.warningMinutes} onChange={e => patch({ warningMinutes: Number(e.target.value) })} />
              <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>{t('pages.slaPolicies.warningMinutesHint')}</span>
            </div>

            <div className="og-pair" style={{ alignItems: 'start' }}>
              <TimeCountingField id={fid('time-counting')} value={form.calendarChoice} onChange={(v) => patch({ calendarChoice: v })} />
              <div>
                <label htmlFor={fid('timezone')} style={labelS}>{t('pages.slaPolicies.timezone')}</label>
                <Input id={fid('timezone')} value={form.timezone} placeholder={t('admin.sla.timezoneTenantDefault')} onChange={e => patch({ timezone: e.target.value })} />
              </div>
            </div>

            <ComplianceFields idPrefix={fid('compliance')} target={form.complianceTarget} warning={form.complianceWarning} onChange={patch} />

            {/* Preview */}
            <div style={{ background: palette.info.light, border: `1px solid ${palette.info.border}`, borderRadius: 8, padding: '10px 14px', fontSize: 'var(--font-size-body)', color: 'var(--accent-hover)' }}>
              <strong>{t('admin.sla.previewLabel')}</strong> {formPreview()} — {t('admin.sla.previewTimes', { response: fmtMinutes(form.responseMinutes, t), resolve: fmtMinutes(form.resolveMinutes, t) })}
              {form.calendarChoice !== '' && <>{' '}{form.calendarChoice === ALWAYS_ON ? t('admin.sla.preview247') : t('serviceTargets.previewCalendar', { name: calendars.find((c) => c.id === form.calendarChoice)?.name ?? '' })}</>}
            </div>
          </div>
      </Modal>
    </PageContainer>
  )
}
