import { useMemo, useState, useCallback, useId, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { QueryError } from '@/components/QueryError'
import { Modal } from '@/components/Modal'
import { Button } from '@/components/Button'
import { toPascalCase } from '@/lib/stringUtils'
import { useQuery, useMutation, useLazyQuery } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { StatusBadge } from '@/components/StatusBadge'
import { DetailField } from '@/components/ui/DetailField'
import { SectionCard } from '@/components/ui/SectionCard'
import { SimpleTable } from '@/components/ui/SimpleTable'
import { Pagination } from '@/components/ui/Pagination'
import { Input, Select, Textarea, FieldLabel } from '@/components/ui/FormControls'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
const CIGraph = lazy(() => import('@/components/CIGraph').then(m => ({ default: m.CIGraph })))
import { CIIncidentsCard } from '@/components/CIIncidentsCard'
import { CIChangeList } from '@/components/CIChangeList'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { CIIcon } from '@/lib/ciIcon'
import { ciPath } from '@/lib/ciPath'
import { formatDate } from '@/lib/datetime'
import { keyActivate } from '@/lib/a11y'
import { GroupCriteriaBuilder } from './GroupCriteriaBuilder'
import { CIHealthSection } from './CIHealthSection'
import { GET_BLAST_RADIUS, GET_ALL_CIS, GET_TEAMS } from '@/graphql/queries'
import { ADD_CI_RELATIONSHIP, REMOVE_CI_RELATIONSHIP, UPDATE_CI, ASSIGN_CI_OWNER, ASSIGN_CI_SUPPORT_GROUP } from '@/graphql/mutations'
import { X, Plus, Pencil } from 'lucide-react'
import { toast } from 'sonner'
import { colors, palette, alpha } from '@/lib/tokens'

// ── Types ─────────────────────────────────────────────────────────────────────

const BASE_TYPE_FIELDS = new Set([
  'id', 'name', 'type', 'status', 'environment',
  'description', 'createdAt', 'updatedAt', 'notes',
  'ownerGroup', 'supportGroup', 'dependencies', 'dependents',
])

interface CIRef {
  id: string; name: string; type: string
  status: string | null; environment: string | null
}

interface CIRelation { relation: string; ci: CIRef }

interface Team { id: string; name: string }

interface CIDetail {
  id: string; name: string; type: string
  status: string | null; environment: string | null
  description: string | null; createdAt: string
  updatedAt: string | null; notes: string | null
  ownerGroup: Team | null; supportGroup: Team | null
  dependencies: CIRelation[]; dependents: CIRelation[]
  [key: string]: unknown
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function RelationList({
  relations,
  navigate,
  onDelete,
  navigationLockedReason,
}: {
  relations: CIRelation[]
  navigate: (path: string) => void
  onDelete?: (rel: CIRelation) => void
  /** When set, rows do not navigate (the page is in edit mode) and show this as tooltip. */
  navigationLockedReason?: string
}) {
  const { t } = useTranslation()
  const locked = navigationLockedReason !== undefined
  const grouped = relations.reduce<Record<string, CIRelation[]>>((acc, rel) => {
    (acc[rel.relation] ??= []).push(rel)
    return acc
  }, {})

  return (
    <>
      {Object.entries(grouped).map(([relation, rels]) => (
        <CollapsibleGroup key={relation} title={relation.replace(/_/g, ' ')} count={rels.length}>
          {rels.map(rel => {
            const open = () => { if (!locked) navigate(ciPath(rel.ci)) }
            return (
            // role="button" e non <button>: la riga contiene il bottone "Elimina" (un button non può annidarne un altro)
            <div
              key={rel.ci.id}
              role="button"
              tabIndex={0}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: `1px solid ${palette.neutral.borderLight}`, cursor: locked ? 'not-allowed' : 'pointer', opacity: locked ? 0.6 : 1 }}
              title={navigationLockedReason}
              aria-disabled={locked || undefined}
              onClick={open}
              onKeyDown={keyActivate(open)}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {rel.ci.name}
                </div>
                <div style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', textTransform: 'capitalize' }}>
                  {rel.ci.type.replace(/_/g, ' ')}{rel.ci.environment ? ` · ${rel.ci.environment}` : ''}
                </div>
              </div>
              {rel.ci.status && <StatusBadge value={rel.ci.status} />}
              {onDelete && (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); onDelete(rel) }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, marginLeft: 'auto', flexShrink: 0 }}
                  title={t('common.delete')}
                  aria-label={t('common.delete')}
                >
                  <X size={14} color={colors.danger} />
                </button>
              )}
            </div>
            )
          })}
        </CollapsibleGroup>
      ))}
    </>
  )
}

// ── Dynamic CI Group members ──────────────────────────────────────────────

// items è troncato lato server (MEMBERS_LIMIT=500) per i gruppi dinamici:
// total/truncated servono a mostrare "500 di N" invece di un conteggio falso.
const CI_GROUP_MEMBERS = gql`
  query CiGroupMembers($groupId: ID!) {
    ciGroupMembers(groupId: $groupId) {
      items { id name type environment status }
      total
      truncated
    }
  }
`

interface GroupMember {
  id: string; name: string; type: string
  environment: string | null; status: string | null
}

interface GroupMembersResult {
  ciGroupMembers: { items: GroupMember[]; total: number; truncated: boolean }
}

/** Default members drawn in the graph; raisable from the map header. The table shows all. */
const DEFAULT_GRAPH_MEMBER_CAP = 50
const GRAPH_MEMBER_CAP_OPTIONS = [50, 100, 200, 500]

const MEMBERS_PAGE_SIZE = 25

/** Array stabili per le prop del grafo: un `[]` inline ricreerebbe la simulazione D3 a ogni render. */
const NO_RELATIONS: { relationType: string; ci: GraphCI }[] = []
const NO_BLAST: (GraphCI & { distance: number; parentId: string | null })[] = []

interface GraphCI { id: string; name: string; type: string; status: string; environment: string | undefined }

const toGraphCI = (c: { id: string; name: string; type: string; status: string | null; environment: string | null }): GraphCI =>
  ({ id: c.id, name: c.name, type: c.type, status: c.status ?? 'unknown', environment: c.environment ?? undefined })

function CIGroupMembersCard({ groupId }: { groupId: string }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [membersPage, setMembersPage] = useState(0)
  const { data, loading } = useQuery<GroupMembersResult>(
    CI_GROUP_MEMBERS,
    { variables: { groupId } },
  )
  const members   = data?.ciGroupMembers.items ?? []
  const total     = data?.ciGroupMembers.total ?? members.length
  const truncated = data?.ciGroupMembers.truncated ?? false
  const pageMembers = members.slice(membersPage * MEMBERS_PAGE_SIZE, (membersPage + 1) * MEMBERS_PAGE_SIZE)
  const totalPages = Math.ceil(members.length / MEMBERS_PAGE_SIZE)
  const countLabel = truncated ? t('pages.ci.membersShownOfTotal', { shown: members.length, total }) : String(total)

  return (
    <SectionCard title={`${t('pages.ci.members')} (${countLabel})`} defaultOpen={true}>
      {truncated && (
        <p style={{ fontSize: 'var(--font-size-table)', color: palette.yellow.text, background: palette.yellow.bg, border: `1px solid ${palette.warning.border}`, borderRadius: 6, padding: '6px 10px', margin: '0 0 8px' }}>
          {t('pages.ci.membersTruncated', { shown: members.length, total })}
        </p>
      )}
      {loading ? (
        <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>…</p>
      ) : (
        <SimpleTable<GroupMember>
          columns={[
            { key: 'name',        label: t('pages.ci.memberName') },
            { key: 'type',        label: t('pages.ci.memberType'),
              render: v => <span style={{ textTransform: 'capitalize' }}>{String(v ?? '').replace(/_/g, ' ')}</span> },
            { key: 'environment', label: t('pages.ci.memberEnvironment') },
            { key: 'status',      label: t('pages.ci.memberStatus'),
              render: v => v ? <StatusBadge value={String(v)} /> : '—' },
          ]}
          rows={pageMembers}
          onRowClick={row => navigate(ciPath(row))}
          empty={<p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>{t('pages.ci.noMembers')}</p>}
        />
      )}
      {totalPages > 1 && (
        <Pagination currentPage={membersPage + 1} totalPages={totalPages} onPrev={() => setMembersPage(p => p - 1)} onNext={() => setMembersPage(p => p + 1)} />
      )}
    </SectionCard>
  )
}

// ── EditField ─────────────────────────────────────────────────────────────

function EditField({ label, value, onChange, enumValues, multiline }: {
  label: string
  value: string
  onChange: (v: string) => void
  enumValues?: string[]
  multiline?: boolean
}) {
  const id = useId()
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {enumValues && enumValues.length > 0 ? (
        <Select id={id} value={value} onChange={e => onChange(e.target.value)}>
          <option value="">—</option>
          {enumValues.map(v => <option key={v} value={v}>{v}</option>)}
        </Select>
      ) : multiline ? (
        <Textarea id={id} value={value} onChange={e => onChange(e.target.value)} rows={3} />
      ) : (
        <Input id={id} type="text" value={value} onChange={e => onChange(e.target.value)} />
      )}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CIDetailPage() {
  const { typeName, id } = useParams<{ typeName: string; id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { getCIType, loading: metamodelLoading, error: metamodelError } = useMetamodel()

  const ciType = typeName ? getCIType(typeName) : undefined

  // id per le coppie label/controllo (a11y)
  const baseId = useId()
  const graphCapId     = `${baseId}-graph-cap`
  const relTypeId      = `${baseId}-rel-type`
  const targetSearchId = `${baseId}-rel-target`

  // ── Edit mode state ──────────────────────────────────────────────────────
  const [editMode, setEditMode] = useState(false)
  const [membersRefreshKey, setMembersRefreshKey] = useState(0)
  const [editDraft, setEditDraft] = useState<Record<string, string>>({})

  // ── Relation management state ────────────────────────────────────────────
  const [showAddRel, setShowAddRel] = useState(false)
  const [addRelForm, setAddRelForm] = useState<{
    relationType: string; direction: 'outgoing' | 'incoming'; search: string; targetCI: CIRef | null
  }>({ relationType: 'DEPENDS_ON', direction: 'outgoing', search: '', targetCI: null })
  const [deleteRel, setDeleteRel] = useState<{
    sourceId: string; targetId: string; relationType: string; name: string
  } | null>(null)

  const [addRelMutation] = useMutation(ADD_CI_RELATIONSHIP)
  const [removeRelMutation] = useMutation(REMOVE_CI_RELATIONSHIP)
  const [updateCIFields] = useMutation(UPDATE_CI)

  const [searchCIs, { data: ciSearchData }] = useLazyQuery<{
    allCIs: { items: { id: string; name: string; type: string; status: string | null; environment: string | null }[] }
  }>(GET_ALL_CIS)

  const ciSearchResults = (ciSearchData?.allCIs.items ?? []).filter(c => c.id !== id)

  const handleCISearch = useCallback((term: string) => {
    setAddRelForm(prev => ({ ...prev, search: term, targetCI: null }))
    if (term.length >= 2) {
      searchCIs({ variables: { search: term, limit: 10 } })
    }
  }, [searchCIs])

  const specificFields = useMemo(
    () => ciType?.fields.filter(f => !BASE_TYPE_FIELDS.has(f.name)).sort((a, b) => a.order - b.order) ?? [],
    [ciType],
  )

  // Relation types offered when adding a relation — driven by this CI type's
  // metamodel relations (e.g. HAS_MEMBER for groups), not a fixed list.
  const relationTypeOptions = useMemo(() => {
    const fromMeta = [...new Set((ciType?.relations ?? []).map(r => r.relationshipType))]
    return fromMeta.length > 0 ? fromMeta : ['DEPENDS_ON', 'HOSTED_ON', 'USES_CERTIFICATE']
  }, [ciType])

  const detailQuery = useMemo(() => {
    if (!typeName || !ciType) return null
    const pascal = toPascalCase(typeName)
    const specificFieldsStr = specificFields.map(f => f.name).join('\n          ')
    return gql`
      query DynamicDetail_${pascal}($id: ID!) {
        ${typeName}(id: $id) {
          id name type status environment description createdAt updatedAt notes
          ownerGroup { id name }
          supportGroup { id name }
          dependencies { relation ci { id name type environment status } }
          dependents { relation ci { id name type environment status } }
          ${specificFieldsStr}
        }
      }
    `
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeName, specificFields.map(f => f.name).join(',')])

  const { data, loading, error, refetch } = useQuery<Record<string, CIDetail | null>>(
    detailQuery ?? gql`query EmptyCIDetail { __typename }`,
    { variables: { id }, skip: !detailQuery || !id },
  )

  const { data: teamsData } = useQuery<{ teams: { id: string; name: string }[] }>(GET_TEAMS, { fetchPolicy: 'cache-first' })
  const allTeams = teamsData?.teams ?? []
  // teamId null → l'API rimuove la relazione ("— non assegnato —" è un'azione reale)
  const [assignOwner] = useMutation<unknown, { ciId: string; teamId: string | null }>(ASSIGN_CI_OWNER, {
    onCompleted: (_d, opts) => { toast.success(t(opts?.variables?.teamId ? 'toast.ci.ownerGroupUpdated' : 'toast.ci.ownerGroupRemoved')); void refetch() },
    onError: (e) => toast.error(e.message),
  })
  const [assignSupport] = useMutation<unknown, { ciId: string; teamId: string | null }>(ASSIGN_CI_SUPPORT_GROUP, {
    onCompleted: (_d, opts) => { toast.success(t(opts?.variables?.teamId ? 'toast.ci.supportGroupUpdated' : 'toast.ci.supportGroupRemoved')); void refetch() },
    onError: (e) => toast.error(e.message),
  })

  const { data: brData } = useQuery<{
    blastRadius: { distance: number; parentId: string | null; ci: { id: string; name: string; type: string; environment: string | null; status: string | null } }[]
  }>(GET_BLAST_RADIUS, { variables: { id }, skip: !id })

  // useMemo e non `?? []`: un array nuovo a ogni render invaliderebbe le memo del grafo
  const blastRadius = useMemo(() => brData?.blastRadius ?? [], [brData])

  // Dynamic CI groups have no DEPENDS_ON edges to their members (manual ones use
  // HAS_MEMBER, dynamic ones resolve by criteria), so the map is driven by the
  // group members instead — capped for renderability; the members table shows all.
  const isGroup = typeName === 'dynamic_ci_group'
  const { data: groupMembersData, refetch: refetchGroupMembers } = useQuery<GroupMembersResult>(
    CI_GROUP_MEMBERS,
    { variables: { groupId: id }, skip: !id || !isGroup, fetchPolicy: 'cache-and-network' },
  )
  const groupMembers = useMemo(() => groupMembersData?.ciGroupMembers.items ?? [], [groupMembersData])
  const [graphCap, setGraphCap] = useState(DEFAULT_GRAPH_MEMBER_CAP)

  const ci = typeName && data ? data[typeName] : undefined

  // Prop del grafo memoizzate (F-05): l'effetto D3 di CIGraph dipende da questi
  // array; ricrearli con .map() inline a ogni render (typing nel modal, edit
  // mode, paginazione) ricostruiva e rilanciava la simulazione a ogni keystroke.
  const graphCenterCI = useMemo<GraphCI | null>(
    () => ci ? toGraphCI({ id: ci.id, name: ci.name, type: ci.type, status: ci.status, environment: ci.environment }) : null,
    [ci],
  )
  const graphDependencies = useMemo(
    () => isGroup
      ? groupMembers.slice(0, graphCap).map((m) => ({ relationType: 'HAS_MEMBER', ci: toGraphCI(m) }))
      : ((ci?.dependencies as CIRelation[] | undefined) ?? []).map((r) => ({ relationType: r.relation, ci: toGraphCI(r.ci) })),
    [isGroup, groupMembers, graphCap, ci],
  )
  const graphDependents = useMemo(
    () => isGroup ? NO_RELATIONS : ((ci?.dependents as CIRelation[] | undefined) ?? []).map((r) => ({ relationType: r.relation, ci: toGraphCI(r.ci) })),
    [isGroup, ci],
  )
  const graphBlastRadius = useMemo(
    () => isGroup ? NO_BLAST : blastRadius.map((b) => ({ ...toGraphCI(b.ci), distance: b.distance, parentId: b.parentId })),
    [isGroup, blastRadius],
  )

  // ── Edit mode handlers ─────────────────────────────────────────────────
  function startEdit() {
    if (!ci) return
    const draft: Record<string, string> = {}
    draft['name'] = ci.name ?? ''
    draft['status'] = ci.status ?? ''
    draft['environment'] = ci.environment ?? ''
    draft['description'] = ci.description ?? ''
    draft['notes'] = (ci.notes as string) ?? ''
    for (const f of specificFields) {
      draft[f.name] = ci[f.name] !== null && ci[f.name] !== undefined ? String(ci[f.name]) : ''
    }
    setEditDraft(draft)
    setEditMode(true)
  }

  async function handleSaveAll() {
    if (!ci) return
    const baseFieldNames = new Set(['name', 'status', 'environment', 'description', 'notes'])
    const baseInput: Record<string, string> = {}
    const customInput: Record<string, string> = {}

    for (const [key, val] of Object.entries(editDraft)) {
      const original = ci[key]
      const originalStr = original !== null && original !== undefined ? String(original) : ''
      if (val !== originalStr) {
        if (baseFieldNames.has(key)) {
          baseInput[key] = val
        } else {
          customInput[key] = val
        }
      }
    }

    if (Object.keys(baseInput).length === 0 && Object.keys(customInput).length === 0) {
      setEditMode(false)
      return
    }

    const input: Record<string, string> = { ...baseInput }
    if (Object.keys(customInput).length > 0) {
      input.customFields = JSON.stringify(customInput)
    }

    try {
      await updateCIFields({ variables: { id: ci.id, input } })
      toast.success(t('toast.ci.saved'))
      setEditMode(false)
      refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  // ── Relation handlers ──────────────────────────────────────────────────
  async function handleAddRelation() {
    if (!addRelForm.targetCI || !ci) return
    const sourceId = addRelForm.direction === 'outgoing' ? ci.id : addRelForm.targetCI.id
    const targetId = addRelForm.direction === 'outgoing' ? addRelForm.targetCI.id : ci.id
    try {
      await addRelMutation({ variables: { sourceId, targetId, relationType: addRelForm.relationType } })
      toast.success(t('pages.ci.relationAdded'))
      setShowAddRel(false)
      setAddRelForm({ relationType: 'DEPENDS_ON', direction: 'outgoing', search: '', targetCI: null })
      refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  async function handleRemoveRelation() {
    if (!deleteRel) return
    try {
      await removeRelMutation({ variables: { sourceId: deleteRel.sourceId, targetId: deleteRel.targetId, relationType: deleteRel.relationType } })
      toast.success(t('pages.ci.relationRemoved'))
      setDeleteRel(null)
      refetch()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  if (metamodelLoading || loading) {
    return <div style={{ padding: 40, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('common.loading')}</div>
  }
  if (metamodelError) {
    return <div style={{ padding: 40 }}><QueryError message={metamodelError.message} /></div>
  }
  if (!ciType) {
    return <div style={{ padding: 40, color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)' }}>{t('pages.cmdb.notFound', { type: typeName })}</div>
  }
  if (error && !data) {
    return (
      <div style={{ padding: 40 }}>
        <QueryError message={error.message} onRetry={() => void refetch()} />
      </div>
    )
  }
  if (!ci) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
        <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>{t('pages.ci.notFound')}</p>
        <button
          type="button"
          onClick={() => navigate(`/ci/${typeName}`)}
          style={{ color: 'var(--color-brand)', background: 'none', border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer' }}
        >
          {t('pages.ci.backTo', { label: ciType.label })}
        </button>
      </div>
    )
  }

  return (
    <PageContainer>
      <button
        type="button"
        onClick={() => navigate(`/ci/${typeName}`)}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-slate-light)', background: 'none', border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer', padding: 0, marginBottom: 12 }}
      >
        ← {ciType.label}
      </button>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24, flexWrap: 'wrap' }}>
        <CIIcon icon={ciType.icon} size={24} color="var(--color-icon-accent)" />
        <h1 style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', margin: 0 }}>{ci.name}</h1>
        {ci.status && <StatusBadge value={ci.status} />}
      </div>

      <div>
        <div>
          <SectionCard
            title={t('detail.sections.information')}
            defaultOpen={true}
            headerRight={
              !editMode ? (
                <button
                  type="button"
                  onClick={e => { e.stopPropagation(); startEdit() }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 'var(--font-size-body)', fontWeight: 500, borderRadius: 6, border: '1px solid var(--color-brand)', background: 'transparent', color: 'var(--color-brand)', cursor: 'pointer' }}
                >
                  <Pencil size={12} /> {t('common.edit')}
                </button>
              ) : undefined
            }
          >
            {editMode ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {/* Read-only fields */}
                  <DetailField label="ID" value={ci.id} mono />
                  <DetailField label={t('pages.cmdb.type')} value={ciType.label} />
                  <DetailField label={t('pages.cmdb.createdAt')} value={formatDate(ci.createdAt)} />
                  <DetailField label={t('detail.updatedAt')} value={ci.updatedAt ? formatDate(ci.updatedAt) : null} />

                  {/* Editable base fields */}
                  <EditField label={t('pages.cmdb.name')} value={editDraft['name'] ?? ''} onChange={v => setEditDraft(d => ({ ...d, name: v }))} />
                  <EditField label={t('pages.cmdb.status')} value={editDraft['status'] ?? ''}
                    enumValues={ciType.fields.find(f => f.name === 'status')?.enumValues}
                    onChange={v => setEditDraft(d => ({ ...d, status: v }))} />
                  <EditField label={t('pages.cmdb.environment')} value={editDraft['environment'] ?? ''}
                    enumValues={ciType.fields.find(f => f.name === 'environment')?.enumValues}
                    onChange={v => setEditDraft(d => ({ ...d, environment: v }))} />

                  {/* Editable specific fields */}
                  {specificFields.map(f => (
                    <EditField
                      key={f.name}
                      label={f.label}
                      value={editDraft[f.name] ?? ''}
                      enumValues={f.enumValues.length > 0 ? f.enumValues : undefined}
                      onChange={v => setEditDraft(d => ({ ...d, [f.name]: v }))}
                    />
                  ))}
                </div>

                {/* Editable description & notes */}
                <div style={{ borderTop: `1px solid ${palette.neutral.borderLight}`, margin: '12px 0' }} />
                <EditField label={t('common.description')} value={editDraft['description'] ?? ''} multiline onChange={v => setEditDraft(d => ({ ...d, description: v }))} />
                <div style={{ marginTop: 12 }} />
                <EditField label={t('pages.ci.notes')} value={editDraft['notes'] ?? ''} multiline onChange={v => setEditDraft(d => ({ ...d, notes: v }))} />

                {/* Save / Cancel */}
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button type="button" onClick={handleSaveAll} style={{ padding: '6px 18px', borderRadius: 6, border: 'none', background: 'var(--color-brand)', color: colors.white, fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                    {t('common.save')}
                  </button>
                  <button type="button" onClick={() => setEditMode(false)} style={{ padding: '6px 14px', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.white, color: 'var(--color-slate)', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                    {t('common.cancel')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <DetailField label="ID" value={ci.id} mono />
                  <DetailField label={t('pages.cmdb.name')} value={ci.name} />
                  <DetailField label={t('pages.cmdb.type')} value={ciType.label} />
                  <DetailField label={t('pages.cmdb.status')} value={ci.status ? <StatusBadge value={ci.status} /> : null} />
                  <DetailField label={t('pages.cmdb.environment')} value={ci.environment ?? null} />
                  <DetailField label={t('pages.cmdb.createdAt')} value={formatDate(ci.createdAt)} />
                  <DetailField label={t('detail.updatedAt')} value={ci.updatedAt ? formatDate(ci.updatedAt) : null} />
                  <DetailField label={t('pages.cmdb.ownerGroup')} value={
                    <Select
                      aria-label={t('pages.cmdb.ownerGroup')}
                      value={(ci.ownerGroup as Team | null)?.id ?? ''}
                      onChange={(e) => void assignOwner({ variables: { ciId: ci.id, teamId: e.target.value || null } })}
                      style={{ fontSize: 'var(--font-size-body)', padding: '4px 8px', maxWidth: 220 }}
                    >
                      <option value="">{t('pages.ci.notAssignedOption')}</option>
                      {allTeams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
                    </Select>
                  } />
                  <DetailField label={t('pages.ci.supportGroup')} value={
                    <Select
                      aria-label={t('pages.ci.supportGroup')}
                      value={(ci.supportGroup as Team | null)?.id ?? ''}
                      onChange={(e) => void assignSupport({ variables: { ciId: ci.id, teamId: e.target.value || null } })}
                      style={{ fontSize: 'var(--font-size-body)', padding: '4px 8px', maxWidth: 220 }}
                    >
                      <option value="">{t('pages.ci.notAssignedOption')}</option>
                      {allTeams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
                    </Select>
                  } />
                  {specificFields.map(f => (
                    <DetailField
                      key={f.name}
                      label={f.label}
                      value={ci[f.name] !== null && ci[f.name] !== undefined ? String(ci[f.name]) : null}
                    />
                  ))}
                </div>
                <DetailField label={t('common.description')} value={ci.description} />
                <DetailField label={t('pages.ci.notes')} value={ci.notes as string ?? null} />
              </>
            )}
          </SectionCard>

          {/* Salute dal monitoraggio (Event Management): aperta se la salute è nota */}
          {!isGroup && <CIHealthSection ciId={ci.id} ciName={ci.name} />}

          {ci.type === 'dynamic_ci_group' && String(ci['membershipType'] ?? '') === 'dynamic' && (
            <GroupCriteriaBuilder
              groupId={ci.id}
              criteria={{
                ciTypes:      String(ci['criteriaCiTypes'] ?? ''),
                environment:  String(ci['criteriaEnvironment'] ?? ''),
                status:       String(ci['criteriaStatus'] ?? ''),
                nameContains: String(ci['criteriaNameContains'] ?? ''),
              }}
              onSaved={() => { refetch(); setMembersRefreshKey((k) => k + 1); void refetchGroupMembers() }}
            />
          )}
          {ci.type === 'dynamic_ci_group' && <CIGroupMembersCard key={membersRefreshKey} groupId={ci.id} />}

          <SectionCard
            title={isGroup ? t('pages.ci.membersMap') : t('pages.ci.dependencyMap')}
            defaultOpen={isGroup}
            headerRight={isGroup && groupMembers.length > DEFAULT_GRAPH_MEMBER_CAP ? (
              // headerRight sta fuori dal bottone di toggle di SectionCard: nessuno stopPropagation necessario
              <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <label htmlFor={graphCapId} style={{ fontSize: 'var(--font-size-table)', color: 'var(--text-muted)' }}>{t('pages.ci.graphNodes')}</label>
                <Select id={graphCapId} value={String(graphCap)} onChange={(e) => setGraphCap(Number(e.target.value))} style={{ width: 'auto', padding: '3px 8px' }}>
                  {GRAPH_MEMBER_CAP_OPTIONS.filter((n, i) => n < groupMembers.length || GRAPH_MEMBER_CAP_OPTIONS[i - 1] === undefined || GRAPH_MEMBER_CAP_OPTIONS[i - 1] < groupMembers.length).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                  <option value={groupMembers.length}>{t('pages.ci.graphAllNodes', { count: groupMembers.length })}</option>
                </Select>
              </span>
            ) : undefined}
          >
            <Suspense fallback={<div style={{ height: 260 }} />}>
            {graphCenterCI && (
              <CIGraph
                centerCI={graphCenterCI}
                dependencies={graphDependencies}
                dependents={graphDependents}
                blastRadius={graphBlastRadius}
              />
            )}
            {isGroup && groupMembers.length > graphCap && (
              <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--text-muted)', margin: '8px 0 0' }}>
                {t('pages.ci.graphShowingFirst', { shown: graphCap, total: groupMembers.length })}
              </p>
            )}
            </Suspense>
          </SectionCard>

          <SectionCard
            title={`${t('pages.ci.relations')} (${(ci.dependencies as CIRelation[]).length + (ci.dependents as CIRelation[]).length})`}
            defaultOpen={false}
            headerRight={
              <button
                type="button"
                onClick={e => { e.stopPropagation(); setShowAddRel(true) }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 'var(--font-size-body)', fontWeight: 500, borderRadius: 6, border: '1px solid var(--color-brand)', background: 'transparent', color: 'var(--color-brand)', cursor: 'pointer' }}
              >
                <Plus size={12} /> {t('pages.ci.addRelation')}
              </button>
            }
          >
            {(ci.dependencies as CIRelation[]).length === 0 && (ci.dependents as CIRelation[]).length === 0 ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>{t('pages.ci.noRelations')}</p>
            ) : (
              <>
                {(ci.dependencies as CIRelation[]).length > 0 && (
                  <div style={{ marginBottom: (ci.dependents as CIRelation[]).length > 0 ? 16 : 0 }}>
                    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                      {t('pages.ci.dependencies')}
                    </div>
                    <RelationList
                      relations={ci.dependencies as CIRelation[]}
                      navigate={navigate}
                      navigationLockedReason={editMode ? t('pages.ci.navigationLockedWhileEditing') : undefined}
                      onDelete={rel => setDeleteRel({ sourceId: ci.id, targetId: rel.ci.id, relationType: rel.relation, name: rel.ci.name })}
                    />
                  </div>
                )}

                {(ci.dependencies as CIRelation[]).length > 0 && (ci.dependents as CIRelation[]).length > 0 && (
                  <div style={{ borderTop: `1px solid ${palette.neutral.borderLight}`, margin: '8px 0 16px 0' }} />
                )}

                {(ci.dependents as CIRelation[]).length > 0 && (
                  <div>
                    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                      {t('pages.ci.dependents')}
                    </div>
                    <RelationList
                      relations={ci.dependents as CIRelation[]}
                      navigate={navigate}
                      navigationLockedReason={editMode ? t('pages.ci.navigationLockedWhileEditing') : undefined}
                      onDelete={rel => setDeleteRel({ sourceId: rel.ci.id, targetId: ci.id, relationType: rel.relation, name: rel.ci.name })}
                    />
                  </div>
                )}
              </>
            )}

            {/* Delete confirmation */}
            {deleteRel && (
              <div style={{ padding: '12px 16px', background: 'var(--color-danger-bg)', border: `1px solid ${palette.danger.border}`, borderRadius: 8, marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 'var(--font-size-body)', color: palette.danger.strong }}>
                  {t('pages.ci.removeRelation', { relationType: deleteRel.relationType, name: deleteRel.name })}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setDeleteRel(null)}
                    style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', borderRadius: 6, border: `1px solid ${colors.border}`, background: colors.white, cursor: 'pointer', color: 'var(--color-slate-dark)' }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    type="button"
                    onClick={handleRemoveRelation}
                    style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', borderRadius: 6, border: 'none', background: 'var(--color-danger)', color: colors.white, cursor: 'pointer' }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )}

          </SectionCard>

          {/* Add relation modal — outside the collapsible SectionCard: its
              children unmount when collapsed, which would keep this modal from
              ever opening while the card is closed. */}
          {showAddRel && ci && createPortal(
              <Modal
                open
                onClose={() => { setShowAddRel(false); setAddRelForm({ relationType: 'DEPENDS_ON', direction: 'outgoing', search: '', targetCI: null }) }}
                title={`${t('pages.ci.addRelation')} — ${ci.name}`}
                width={480}
                zIndex={9999}
                footer={
                  <>
                    <Button
                      variant="secondary"
                      onClick={() => { setShowAddRel(false); setAddRelForm({ relationType: 'DEPENDS_ON', direction: 'outgoing', search: '', targetCI: null }) }}
                      style={{ color: 'var(--color-slate-dark)' }}
                    >
                      {t('common.cancel')}
                    </Button>
                    <Button
                      onClick={() => void handleAddRelation()}
                      disabled={!addRelForm.targetCI}
                      style={{ fontSize: 'var(--font-size-body)', ...(addRelForm.targetCI ? {} : { backgroundColor: palette.neutral.borderStrong }) }}
                    >
                      {t('pages.ci.addRelation')}
                    </Button>
                  </>
                }
              >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Relation type */}
                    <div>
                      <label htmlFor={relTypeId} style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>
                        {t('pages.ci.relationType')}
                      </label>
                      <Select
                        id={relTypeId}
                        value={addRelForm.relationType}
                        onChange={e => setAddRelForm(prev => ({ ...prev, relationType: e.target.value, targetCI: null, search: '' }))}
                        style={{ padding: '8px 10px', outline: undefined }}
                      >
                        {relationTypeOptions.map(rt => <option key={rt} value={rt}>{rt.replace(/_/g, ' ')}</option>)}
                      </Select>
                    </div>

                    {/* Direction */}
                    <fieldset style={{ border: 'none', padding: 0, margin: 0, minWidth: 0 }}>
                      <legend style={{ display: 'block', padding: 0, fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6 }}>
                        {t('pages.ci.direction')}
                      </legend>
                      <div style={{ display: 'flex', gap: 12 }}>
                        {(['outgoing', 'incoming'] as const).map(dir => (
                          <label key={dir} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer', color: addRelForm.direction === dir ? 'var(--color-brand)' : 'var(--color-slate)' }}>
                            <input type="radio" name="rel-dir" checked={addRelForm.direction === dir} onChange={() => setAddRelForm(prev => ({ ...prev, direction: dir }))} />
                            {dir === 'outgoing' ? t('pages.ci.dirOutgoing') : t('pages.ci.dirIncoming')}
                          </label>
                        ))}
                      </div>
                    </fieldset>

                    {/* CI search */}
                    <div style={{ position: 'relative' }}>
                      <label htmlFor={targetSearchId} style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>
                        {t('pages.ci.targetCI')}
                      </label>
                      <Input
                        id={targetSearchId}
                        placeholder={t('pages.ci.searchTarget')}
                        value={addRelForm.search}
                        onChange={e => handleCISearch(e.target.value)}
                        style={{ padding: '8px 10px', outline: undefined }}
                      />
                      {addRelForm.targetCI && (
                        <div style={{ marginTop: 6, padding: '6px 10px', background: palette.info.light, border: `1px solid ${palette.info.border}`, borderRadius: 6, fontSize: 'var(--font-size-body)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span><strong>{addRelForm.targetCI.name}</strong> <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>({addRelForm.targetCI.type})</span></span>
                          <button type="button" aria-label={t('common.delete')} onClick={() => setAddRelForm(prev => ({ ...prev, targetCI: null, search: '' }))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}><X size={14} color={colors.slateLight} /></button>
                        </div>
                      )}
                      {ciSearchResults.length > 0 && !addRelForm.targetCI && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: colors.white, border: `1px solid ${colors.border}`, borderRadius: 6, maxHeight: 180, overflowY: 'auto', zIndex: 10, boxShadow: `0 4px 12px ${alpha.black08}`, marginTop: 2 }}>
                          {ciSearchResults.map(c => (
                            <button
                              type="button"
                              key={c.id}
                              onClick={() => setAddRelForm(prev => ({ ...prev, targetCI: c, search: c.name }))}
                              className="hover-bg"
                              style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', font: 'inherit', color: 'inherit', padding: '8px 12px', fontSize: 'var(--font-size-body)', cursor: 'pointer', borderBottom: `1px solid ${palette.neutral.borderLight}`, ['--hover-bg' as string]: colors.slateBg }}
                            >
                              <span style={{ fontWeight: 500 }}>{c.name}</span>{' '}
                              <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>({c.type.replace(/_/g, ' ')})</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Spacer: reserves room in the scrollable Modal body so the
                        absolutely-positioned dropdown above is never clipped */}
                    {ciSearchResults.length > 0 && !addRelForm.targetCI && (
                      <div aria-hidden="true" style={{ height: Math.min(ciSearchResults.length * 37, 180) - 6, flexShrink: 0 }} />
                    )}
                  </div>
              </Modal>,
              document.body,
            )}

          <CIIncidentsCard ciId={ci.id} />
          <CIChangeList ciId={ci.id} />

          <AttachmentsSection entityType="ci" entityId={ci.id} />
        </div>

      </div>
    </PageContainer>
  )
}
