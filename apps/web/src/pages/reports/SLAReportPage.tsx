import { useState, useId } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDateTime } from '@/lib/datetime'
import { useQuery, useMutation } from '@apollo/client/react'
import { Gauge, Plus, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { QueryError } from '@/components/QueryError'
import { Skeleton } from '@/components/ui/skeleton'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { Input, Textarea, Select, FieldLabel } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { GET_SLA_REPORT, GET_OLA_CONTRACTS, GET_TEAMS } from '@/graphql/queries'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { CREATE_OLA_CONTRACT, UPDATE_OLA_CONTRACT } from '@/graphql/mutations'
import { colors, palette } from '@/lib/tokens'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SLAPriorityRow { priority: string; total: number; met: number; breached: number }
interface OLARow {
  id: string; type: string; name: string; entityType: string; partyType: string | null
  partyName: string | null; resolveMinutes: number; evaluated: number; met: number
  breached: number; attainmentPct: number | null
}
interface SLAReport {
  generatedAt: string; windowDays: number
  sla: {
    total: number; met: number; breached: number; paused: number; openOnTrack: number
    breachRate: number; avgResolutionMinutes: number | null; byPriority: SLAPriorityRow[]
  }
  ola: OLARow[]
}
interface OLAContract {
  id: string; type: string; name: string; description: string | null; entityType: string
  responseMinutes: number; resolveMinutes: number; businessHours: boolean
  partyType: string | null; partyName: string | null; teamId: string | null
  teamName: string | null; enabled: boolean; createdAt: string
}

const ENTITY_LABELS: Record<string, string> = {
  incident: 'Incident', problem: 'Problem', change: 'Change', service_request: 'Service Request', any: 'Tutti',
}
const WINDOWS = [7, 30, 90]

// ── Helpers ─────────────────────────────────────────────────────────────────

function fmtMinutes(m: number | null): string {
  if (m == null) return '—'
  if (m < 60) return `${Math.round(m)}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${Math.round(m % 60)}m`
  return `${Math.floor(h / 24)}g ${h % 24}h`
}
function pctColor(pct: number | null): string {
  if (pct == null) return 'var(--color-slate-light)'
  if (pct >= 95) return palette.success.text
  if (pct >= 80) return palette.warning.text
  return palette.danger.text
}

/**
 * IL RESPONSABILE: un team si SCEGLIE, un fornitore si scrive.
 *
 * `partyName` era un testo libero anche per i team — «Es. Network Ops» — e
 * permetteva di scrivere un team che non esiste, di scriverne uno esistente
 * con un refuso (due responsabili dove ce n'è uno), e di vedere il nome
 * vecchio per sempre dopo una rinomina. Un team di questo cliente è
 * un'entità: si cita per id (`teamId`) e il nome lo risolve il server
 * (`teamName`). Il fornitore esterno non è un'entità del prodotto, e per lui
 * il testo libero resta la forma giusta.
 */
type OLAForm = {
  type: string; name: string; description: string; entityType: string
  responseMinutes: number; resolveMinutes: number; partyType: string
  /** Solo per `partyType: 'supplier'`. */
  partyName: string
  /** Solo per `partyType: 'team'`: l'id, non il nome. */
  teamId: string
}
const EMPTY_OLA: OLAForm = {
  type: 'ola', name: '', description: '', entityType: 'incident',
  responseMinutes: 240, resolveMinutes: 1440, partyType: 'team', partyName: '', teamId: '',
}

interface Team { id: string; name: string }

// ── KPI card ──────────────────────────────────────────────────────────────────

function Kpi({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 10, padding: '14px 16px', minWidth: 120, flex: 1 }}>
      <div style={{ fontSize: 22, fontWeight: 700, color: color ?? 'var(--color-slate-dark)' }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginTop: 2 }}>{label}</div>
    </div>
  )
}

// ── Page ──────────────────────────────────────────────────────────────────────

export function SLAReportPage() {
  const { t } = useTranslation()
  const uid = useId()
  const ids = {
    type: `${uid}-type`, entity: `${uid}-entity`, name: `${uid}-name`, desc: `${uid}-desc`,
    response: `${uid}-response`, resolve: `${uid}-resolve`, partyType: `${uid}-party-type`, partyName: `${uid}-party-name`,
    teamId: `${uid}-team`,
  }
  const [windowDays, setWindowDays] = useState(30)
  const { data, loading, error, refetch } = useQuery<{ slaReport: SLAReport }>(GET_SLA_REPORT, {
    variables: { windowDays }, fetchPolicy: 'cache-and-network',
  })
  const { data: olaData, refetch: refetchOLA } = useQuery<{ olaContracts: OLAContract[] }>(GET_OLA_CONTRACTS, {
    fetchPolicy: 'cache-and-network',
  })
  const { data: teamsData } = useQuery<{ teams: Team[] }>(GET_TEAMS, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const teams: Team[] = teamsData?.teams ?? []

  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; item: OLAContract } | null>(null)
  const [form, setForm] = useState<OLAForm>(EMPTY_OLA)

  const [createOLA, { loading: creating }] = useMutation(CREATE_OLA_CONTRACT, {
    onCompleted: async () => { setModal(null); await refetchOLA(); await refetch(); toast.success(t('toast.sla.olaCreated')) },
    onError: (e) => toast.error(e.message),
  })
  const [updateOLA, { loading: updating }] = useMutation(UPDATE_OLA_CONTRACT, {
    onCompleted: async () => { setModal(null); await refetchOLA(); await refetch() },
    onError: (e) => toast.error(e.message),
  })
  const saving = creating || updating

  const openCreate = () => { setForm(EMPTY_OLA); setModal({ mode: 'create' }) }
  const openEdit = (o: OLAContract) => {
    setForm({
      type: o.type, name: o.name, description: o.description ?? '', entityType: o.entityType,
      responseMinutes: o.responseMinutes, resolveMinutes: o.resolveMinutes,
      partyType: o.partyType ?? 'team', partyName: o.partyName ?? '', teamId: o.teamId ?? '',
    })
    setModal({ mode: 'edit', item: o })
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!modal) return
    // Le due forme non convivono: un team viaggia come riferimento, un
    // fornitore come nome. Mandarle entrambe lascerebbe sul contratto una
    // copia del nome del team, che invecchia alla prima rinomina.
    const responsabile = form.partyType === 'team'
      ? { partyType: 'team', teamId: form.teamId || null, partyName: null }
      : { partyType: 'supplier', partyName: form.partyName.trim() || null, teamId: null }
    const base = {
      name: form.name.trim(), description: form.description.trim() || null, entityType: form.entityType,
      responseMinutes: Number(form.responseMinutes), resolveMinutes: Number(form.resolveMinutes),
      ...responsabile,
    }
    if (modal.mode === 'create') void createOLA({ variables: { input: { type: form.type, ...base } } })
    else void updateOLA({ variables: { id: modal.item.id, input: base } })
  }
  const toggleEnabled = (o: OLAContract) => void updateOLA({ variables: { id: o.id, input: { enabled: !o.enabled } } })

  const report = data?.slaReport
  const contracts = olaData?.olaContracts ?? []

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <PageTitle icon={<Gauge size={20} />}>{t('sidebar.slaReport')}</PageTitle>
        <div style={{ display: 'flex', gap: 6 }}>
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              aria-pressed={windowDays === w}
              onClick={() => setWindowDays(w)}
              style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid var(--color-border-light)', background: windowDays === w ? 'var(--color-brand)' : colors.white, color: windowDays === w ? colors.white : 'var(--color-slate)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}
            >
              {t('pages.slaReport.windowDays', { count: w })}
            </button>
          ))}
        </div>
      </div>

      {loading && !data && <Skeleton style={{ height: 160 }} />}
      {error && !data && <QueryError message={error.message} onRetry={() => void refetch()} />}

      {report && (
        <>
          {/* SLA compliance KPIs */}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 20 }}>
            <Kpi label={t('pages.slaReport.slaInWindow', { window: t('pages.slaReport.windowDays', { count: report.windowDays }) })} value={String(report.sla.total)} />
            <Kpi label={t('pages.slaReport.met')} value={String(report.sla.met)} color={palette.success.text} />
            <Kpi label={t('pages.slaReport.breached')} value={String(report.sla.breached)} color={palette.danger.text} />
            <Kpi label={t('sla.paused')} value={String(report.sla.paused)} color={palette.purple.dark} />
            <Kpi label={t('pages.slaReport.breachRate')} value={`${report.sla.breachRate.toFixed(1)}%`} color={pctColor(100 - report.sla.breachRate)} />
            <Kpi label={t('pages.slaReport.avgResolution')} value={fmtMinutes(report.sla.avgResolutionMinutes)} />
          </div>

          {/* By priority */}
          <div style={{ marginBottom: 28 }}>
            <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: '0 0 10px' }}>{t('pages.slaReport.byPriority')}</h3>
            {report.sla.byPriority.length === 0 ? (
              <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('pages.slaReport.noData')}</p>
            ) : (
              <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 10, overflow: 'hidden' }}>
                <div className="og-scroll-x">
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
                  <thead>
                    <tr style={{ background: palette.neutral.surface1, textAlign: 'left', color: 'var(--color-slate-light)' }}>
                      <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('detail.priority')}</th>
                      <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('pages.slaReport.total')}</th>
                      <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('pages.slaReport.met')}</th>
                      <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('pages.slaReport.breached')}</th>
                      <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('pages.slaReport.compliance')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.sla.byPriority.map((r) => {
                      const concluded = r.met + r.breached
                      const pct = concluded > 0 ? (r.met / concluded) * 100 : null
                      return (
                        <tr key={r.priority} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: 'var(--color-slate-dark)', textTransform: 'capitalize' }}>{r.priority}</td>
                          <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{r.total}</td>
                          <td style={{ padding: '9px 14px', color: palette.success.text }}>{r.met}</td>
                          <td style={{ padding: '9px 14px', color: palette.danger.text }}>{r.breached}</td>
                          <td style={{ padding: '9px 14px', fontWeight: 600, color: pctColor(pct) }}>{pct == null ? '—' : `${pct.toFixed(0)}%`}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              </div>
            )}
          </div>

          {/* OLA / UC attainment */}
          <div style={{ marginBottom: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ShieldCheck size={16} /> {t('pages.slaReport.contracts')}
            </h3>
            <Button onClick={openCreate}><Plus size={15} style={{ marginRight: 6 }} />{t('pages.slaReport.newContract')}</Button>
          </div>

          {contracts.length === 0 ? (
            <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>
              {t('pages.slaReport.noContracts')}
            </p>
          ) : (
            <div style={{ border: '1px solid var(--color-border-light)', borderRadius: 10, overflow: 'hidden' }}>
              <div className="og-scroll-x">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--font-size-body)' }}>
                <thead>
                  <tr style={{ background: palette.neutral.surface1, textAlign: 'left', color: 'var(--color-slate-light)' }}>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('common.type')}</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('common.name')}</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('admin.sla.scopeField')}</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('pages.slaReport.party')}</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('pages.slaReport.target')}</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600 }}>{t('pages.slaReport.attainment', { window: t('pages.slaReport.windowDays', { count: report.windowDays }) })}</th>
                    <th style={{ padding: '9px 14px', fontWeight: 600, textAlign: 'right' }}>{t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((o) => {
                    const att = report.ola.find((r) => r.id === o.id)
                    const pct = att?.attainmentPct ?? null
                    return (
                      <tr key={o.id} style={{ borderTop: '1px solid var(--color-border-light)', opacity: o.enabled ? 1 : 0.55 }}>
                        <td style={{ padding: '9px 14px' }}>
                          <Pill bg={o.type === 'uc' ? palette.purple.tint : palette.info.tint} color={o.type === 'uc' ? palette.purple.dark : palette.info.text}>{o.type.toUpperCase()}</Pill>
                        </td>
                        <td style={{ padding: '9px 14px', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{o.name}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{ENTITY_LABELS[o.entityType] ?? o.entityType}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{(o.partyType === 'team' ? o.teamName : o.partyName) ?? '—'}</td>
                        <td style={{ padding: '9px 14px', color: 'var(--color-slate)' }}>{fmtMinutes(o.resolveMinutes)}</td>
                        <td style={{ padding: '9px 14px', fontWeight: 600, color: pctColor(pct) }}>
                          {pct == null ? <span style={{ color: 'var(--color-slate-light)', fontWeight: 400 }}>{t('components.widgetBody.noData')}</span> : `${pct.toFixed(0)}%`}
                          {att && att.evaluated > 0 && (
                            <span style={{ color: 'var(--color-slate-light)', fontWeight: 400, marginLeft: 6, fontSize: 12 }}>
                              ({att.met}/{att.evaluated})
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '9px 14px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                          <Button variant="ghost" onClick={() => openEdit(o)} style={{ marginRight: 6 }}>{t('common.edit')}</Button>
                          <Button variant="secondary" onClick={() => toggleEnabled(o)} disabled={saving}>
                            {t(o.enabled ? 'common.disable' : 'common.enable')}
                          </Button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            </div>
          )}

          <p style={{ marginTop: 10, fontSize: 12, color: 'var(--color-slate-light)' }}>
            {t('pages.slaReport.generatedNote', { date: formatDateTime(report.generatedAt) })}
          </p>
        </>
      )}

      {/* Create / edit OLA modal */}
      <Modal
        open={modal !== null}
        onClose={() => setModal(null)}
        title={t(modal?.mode === 'edit' ? 'pages.slaReport.editContract' : 'pages.slaReport.newContractTitle')}
        as="form"
        onSubmit={submit}
        footer={
          <>
            <Button type="button" variant="secondary" onClick={() => setModal(null)}>{t('common.cancel')}</Button>
            <Button type="submit" disabled={saving || form.name.trim().length === 0}>{saving ? t('common.saving') : t('common.save')}</Button>
          </>
        }
      >
        <div className="og-pair">
          <div>
            <FieldLabel htmlFor={ids.type}>{t('common.type')}</FieldLabel>
            <Select id={ids.type} value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} disabled={modal?.mode === 'edit'}>
              <option value="ola">{t('pages.slaReport.typeOla')}</option>
              <option value="uc">{t('pages.slaReport.typeUc')}</option>
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor={ids.entity}>{t('admin.sla.scopeField')}</FieldLabel>
            <Select id={ids.entity} value={form.entityType} onChange={(e) => setForm({ ...form, entityType: e.target.value })}>
              {Object.entries(ENTITY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <FieldLabel htmlFor={ids.name}>{t('pages.slaReport.nameRequired')}</FieldLabel>
            <Input
              id={ids.name}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
              // eslint-disable-next-line jsx-a11y/no-autofocus -- focus management del dialogo OLA/UC aperto dall'utente (Nuovo/Modifica contratto)
              autoFocus
              placeholder={t('pages.slaReport.namePlaceholder')}
            />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <FieldLabel htmlFor={ids.desc}>{t('common.description')}</FieldLabel>
            <Textarea id={ids.desc} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
          </div>
          <div>
            <FieldLabel htmlFor={ids.response}>{t('pages.slaReport.responseTarget')}</FieldLabel>
            <Input id={ids.response} type="number" min={1} value={form.responseMinutes} onChange={(e) => setForm({ ...form, responseMinutes: Number(e.target.value) })} required />
          </div>
          <div>
            <FieldLabel htmlFor={ids.resolve}>{t('pages.slaReport.resolveTarget')}</FieldLabel>
            <Input id={ids.resolve} type="number" min={1} value={form.resolveMinutes} onChange={(e) => setForm({ ...form, resolveMinutes: Number(e.target.value) })} required />
          </div>
          <div>
            <FieldLabel htmlFor={ids.partyType}>{t('pages.slaReport.party')}</FieldLabel>
            <Select id={ids.partyType} value={form.partyType} onChange={(e) => setForm({ ...form, partyType: e.target.value })}>
              <option value="team">{t('pages.slaReport.partyTeam')}</option>
              <option value="supplier">{t('pages.slaReport.partySupplier')}</option>
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor={form.partyType === 'supplier' ? ids.partyName : ids.teamId}>
              {t(form.partyType === 'supplier' ? 'pages.slaReport.supplierName' : 'pages.slaReport.teamName')}
            </FieldLabel>
            {form.partyType === 'supplier' ? (
              <Input
                id={ids.partyName} value={form.partyName}
                onChange={(e) => setForm({ ...form, partyName: e.target.value })}
                placeholder={t('pages.slaReport.supplierPlaceholder')}
              />
            ) : (
              <Select id={ids.teamId} value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}>
                <option value="">{t('pages.slaReport.pickTeam')}</option>
                {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
              </Select>
            )}
            {form.partyType === 'team' && teams.length === 0 && (
              <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                {t('pages.slaReport.noTeams')}
              </p>
            )}
          </div>
        </div>
      </Modal>
    </PageContainer>
  )
}
