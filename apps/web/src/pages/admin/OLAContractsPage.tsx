/**
 * CONTRATTI OLA / UC — dove si configurano.
 *
 * Stavano dentro l'SLA Report: la pagina di REPORTING era l'unico posto in cui
 * si potevano creare, modificare e disattivare. Un contratto è configurazione,
 * come una SLA policy, e un report non è il posto dove la si scrive — chi
 * cercava «dove si crea un OLA» andava in Admin e non lo trovava. Ora sta qui,
 * accanto a SLA Policies; il report mostra solo quanto i contratti sono stati
 * rispettati.
 *
 * Il responsabile è sempre un TEAM, citato per id e scelto da una tendina:
 * - «team interno»     → un team con Sourcing = Internal;
 * - «fornitore esterno» → un team con Sourcing = External.
 * Il fornitore era un nome scritto a mano; da quando ogni team dice se è
 * interno o esterno, il fornitore è un team come gli altri.
 */
import { useState, useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useQuery, useMutation } from '@apollo/client/react'
import { Handshake, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { ListPageHeader } from '@/components/ListPageHeader'
import { QueryError } from '@/components/QueryError'
import { EmptyState } from '@/components/EmptyState'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { SortableFilterTable, type ColumnDef } from '@/components/SortableFilterTable'
import { Input, Textarea, Select, FieldLabel } from '@/components/ui/FormControls'
import { Pill } from '@/components/ui/Pill'
import { Toggle } from '@/components/ui/Toggle'
import { GET_OLA_CONTRACTS, GET_TEAMS } from '@/graphql/queries'
import { CREATE_OLA_CONTRACT, UPDATE_OLA_CONTRACT } from '@/graphql/mutations'
import { METAMODEL_FETCH_POLICY } from '@/lib/fetchPolicy'
import { palette } from '@/lib/tokens'

export interface OLAContract {
  id: string; type: string; name: string; description: string | null; entityType: string
  responseMinutes: number; resolveMinutes: number; businessHours: boolean
  partyType: string | null; partyName: string | null; teamId: string | null
  teamName: string | null; enabled: boolean; createdAt: string
}

/** L'ambito del contratto: l'entità, o «tutte». Le etichette delle entità sono i loro nomi ITIL. */
export const OLA_SCOPES = ['incident', 'problem', 'change', 'service_request', 'any'] as const
export function olaScopeLabel(scope: string, t: TFunction): string {
  switch (scope) {
    case 'incident':        return 'Incident'
    case 'problem':         return 'Problem'
    case 'change':          return 'Change'
    case 'service_request': return 'Service Request'
    case 'any':             return t('common.all')
    default:                return scope
  }
}

/** Minuti in forma breve, con le unità tradotte (le stesse delle SLA policy). */
export function olaMinutes(m: number | null, t: TFunction): string {
  if (m == null) return '—'
  const u = (k: string, n: number) => t(`admin.sla.unit.${k}`, { count: n })
  if (m < 60) return u('minutes', Math.round(m))
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 === 0 ? u('hours', h) : `${u('hours', h)} ${u('minutes', Math.round(m % 60))}`
  return `${u('days', Math.floor(h / 24))}${h % 24 ? ` ${u('hours', h % 24)}` : ''}`
}

/**
 * IL RESPONSABILE È SEMPRE UN TEAM, scelto fra quelli col Sourcing giusto:
 * «team interno» → i team con sourcing = internal, «fornitore esterno» → i team
 * con sourcing = external. Il nome del fornitore scritto a mano non c'è più.
 * L'API fa lo stesso controllo (`assertResponsabile`).
 */
type OLAForm = {
  type: string; name: string; description: string; entityType: string
  responseMinutes: number; resolveMinutes: number; partyType: string
  /** L'id del team responsabile, qualunque sia il tipo. */
  teamId: string
}
const EMPTY_OLA: OLAForm = {
  type: 'ola', name: '', description: '', entityType: 'incident',
  responseMinutes: 240, resolveMinutes: 1440, partyType: 'team', teamId: '',
}

/** Il Sourcing che un team deve avere per ciascun tipo di responsabile. */
const SOURCING_PER_RESPONSABILE: Record<string, 'internal' | 'external'> = { team: 'internal', supplier: 'external' }

interface Team { id: string; name: string; sourcing: string | null }

export function OLAContractsPage() {
  const { t } = useTranslation()
  const uid = useId()
  const ids = {
    type: `${uid}-type`, entity: `${uid}-entity`, name: `${uid}-name`, desc: `${uid}-desc`,
    response: `${uid}-response`, resolve: `${uid}-resolve`, partyType: `${uid}-party-type`,
    teamId: `${uid}-team`,
  }

  const { data, loading, error, refetch } = useQuery<{ olaContracts: OLAContract[] }>(GET_OLA_CONTRACTS, {
    fetchPolicy: 'cache-and-network',
  })
  const { data: teamsData } = useQuery<{ teams: Team[] }>(GET_TEAMS, { fetchPolicy: METAMODEL_FETCH_POLICY })
  const teams: Team[] = teamsData?.teams ?? []

  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; item: OLAContract } | null>(null)
  const [form, setForm] = useState<OLAForm>(EMPTY_OLA)

  // L'OLA / UC Report legge gli stessi contratti: si rilegge anche lui, altrimenti
  // aprendolo subito dopo mostrerebbe il contratto com'era.
  const refetchQueries = ['GetOLAReport']
  const [createOLA, { loading: creating }] = useMutation(CREATE_OLA_CONTRACT, {
    refetchQueries,
    onCompleted: async () => { setModal(null); await refetch(); toast.success(t('toast.sla.olaCreated')) },
    onError: (e) => toast.error(e.message),
  })
  const [updateOLA, { loading: updating }] = useMutation(UPDATE_OLA_CONTRACT, {
    refetchQueries,
    onCompleted: async () => { setModal(null); await refetch() },
    onError: (e) => toast.error(e.message),
  })
  const saving = creating || updating

  const openCreate = () => { setForm(EMPTY_OLA); setModal({ mode: 'create' }) }
  const openEdit = (o: OLAContract) => {
    setForm({
      type: o.type, name: o.name, description: o.description ?? '', entityType: o.entityType,
      responseMinutes: o.responseMinutes, resolveMinutes: o.resolveMinutes,
      partyType: o.partyType ?? 'team', teamId: o.teamId ?? '',
    })
    setModal({ mode: 'edit', item: o })
  }
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!modal) return
    const responsabile = { partyType: form.partyType, teamId: form.teamId || null }
    const base = {
      name: form.name.trim(), description: form.description.trim() || null, entityType: form.entityType,
      responseMinutes: Number(form.responseMinutes), resolveMinutes: Number(form.resolveMinutes),
      ...responsabile,
    }
    if (modal.mode === 'create') void createOLA({ variables: { input: { type: form.type, ...base } } })
    else void updateOLA({ variables: { id: modal.item.id, input: base } })
  }
  const toggleEnabled = (o: OLAContract) => void updateOLA({ variables: { id: o.id, input: { enabled: !o.enabled } } })

  const contracts = data?.olaContracts ?? []
  // Solo i team col Sourcing del tipo di responsabile scelto.
  const teamsDelTipo = teams.filter((tm) => tm.sourcing === SOURCING_PER_RESPONSABILE[form.partyType])

  const columns: ColumnDef<OLAContract>[] = [
    { key: 'type', label: t('common.type'), sortable: true, width: '90px', render: (v) => (
      <Pill bg={v === 'uc' ? palette.purple.tint : palette.info.tint} color={v === 'uc' ? palette.purple.dark : palette.info.text}>{String(v).toUpperCase()}</Pill>
    ) },
    { key: 'name', label: t('common.name'), sortable: true, render: (v) => <span style={{ fontWeight: 500, color: 'var(--color-slate-dark)' }}>{String(v)}</span> },
    { key: 'entityType', label: t('admin.sla.scopeField'), sortable: true, render: (v) => olaScopeLabel(String(v), t) },
    { key: 'teamName', label: t('pages.slaReport.party'), sortable: true, render: (_v, o) => o.teamName ?? o.partyName ?? '—' },
    { key: 'responseMinutes', label: t('admin.sla.response'), sortable: true, render: (v) => olaMinutes(Number(v), t) },
    { key: 'resolveMinutes', label: t('admin.sla.resolution'), sortable: true, render: (v) => olaMinutes(Number(v), t) },
    { key: 'enabled', label: t('admin.rules.active'), sortable: true, width: '90px', render: (_v, o) => (
      <Toggle checked={o.enabled} onChange={() => toggleEnabled(o)} label={t('admin.sla.toggleLabel', { name: o.name })} />
    ) },
  ]

  return (
    <PageContainer>
      <ListPageHeader
        icon={<Handshake />}
        title={t('sidebar.olaContracts')}
        subtitle={
          <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', marginTop: 4, marginBottom: 0 }}>
            {loading && !data ? '—' : t('pages.olaContracts.subtitle')}
          </p>
        }
        actions={
          <Button icon={<Plus size={15} aria-hidden="true" />} onClick={openCreate}>{t('pages.slaReport.newContract')}</Button>
        }
      />

      {error && !data ? (
        <QueryError message={error.message} onRetry={() => void refetch()} />
      ) : !loading && contracts.length === 0 ? (
        <EmptyState icon={<Handshake size={24} />} title={t('pages.olaContracts.empty')} description={t('pages.slaReport.noContracts')} />
      ) : (
        <SortableFilterTable<OLAContract>
          columns={columns}
          data={contracts}
          loading={loading && !data}
          label={t('sidebar.olaContracts')}
          onRowClick={openEdit}
        />
      )}

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
              {OLA_SCOPES.map((v) => <option key={v} value={v}>{olaScopeLabel(v, t)}</option>)}
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
            {/* Cambiare tipo svuota il team: quello scelto prima ha il Sourcing dell'altro tipo. */}
            <Select id={ids.partyType} value={form.partyType} onChange={(e) => setForm({ ...form, partyType: e.target.value, teamId: '' })}>
              <option value="team">{t('pages.slaReport.partyTeam')}</option>
              <option value="supplier">{t('pages.slaReport.partySupplier')}</option>
            </Select>
          </div>
          <div>
            <FieldLabel htmlFor={ids.teamId}>
              {t(form.partyType === 'supplier' ? 'pages.olaContracts.supplierTeam' : 'pages.slaReport.teamName')}
            </FieldLabel>
            <Select id={ids.teamId} value={form.teamId} onChange={(e) => setForm({ ...form, teamId: e.target.value })}>
              <option value="">{t('pages.slaReport.pickTeam')}</option>
              {teamsDelTipo.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </Select>
            {teamsDelTipo.length === 0 && (
              <p style={{ margin: '6px 0 0', fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                {t(form.partyType === 'supplier' ? 'pages.olaContracts.noExternalTeams' : 'pages.olaContracts.noInternalTeams')}
              </p>
            )}
          </div>
        </div>
      </Modal>
    </PageContainer>
  )
}
