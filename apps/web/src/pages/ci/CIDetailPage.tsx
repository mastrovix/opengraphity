import { useMemo, useState, useCallback, lazy, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { useParams, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
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
import { Pill } from '@/components/ui/Pill'
import { CollapsibleGroup } from '@/components/ui/CollapsibleGroup'
const CIGraph = lazy(() => import('@/components/CIGraph').then(m => ({ default: m.CIGraph })))
import { CIIncidentsCard } from '@/components/CIIncidentsCard'
import { CIChangeList } from '@/components/CIChangeList'
import { AttachmentsSection } from '@/components/AttachmentsSection'
import { CIIcon } from '@/lib/ciIcon'
import { ciPath } from '@/lib/ciPath'
import { GroupCriteriaBuilder } from './GroupCriteriaBuilder'
import { GET_BLAST_RADIUS, GET_ALL_CIS } from '@/graphql/queries'
import { ADD_CI_RELATIONSHIP, REMOVE_CI_RELATIONSHIP, UPDATE_CI } from '@/graphql/mutations'
import { X, Plus, Pencil } from 'lucide-react'
import { toast } from 'sonner'

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
}: {
  relations: CIRelation[]
  navigate: (path: string) => void
  onDelete?: (rel: CIRelation) => void
}) {
  const grouped = relations.reduce<Record<string, CIRelation[]>>((acc, rel) => {
    (acc[rel.relation] ??= []).push(rel)
    return acc
  }, {})

  return (
    <>
      {Object.entries(grouped).map(([relation, rels]) => (
        <CollapsibleGroup key={relation} title={relation.replace(/_/g, ' ')} count={rels.length}>
          {rels.map(rel => (
            <div
              key={rel.ci.id}
              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f9fafb', cursor: 'pointer' }}
              onClick={() => navigate(ciPath(rel.ci))}
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
                  onClick={e => { e.stopPropagation(); onDelete(rel) }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, marginLeft: 'auto', flexShrink: 0 }}
                  title="Delete"
                >
                  <X size={14} color="#ef4444" />
                </button>
              )}
            </div>
          ))}
        </CollapsibleGroup>
      ))}
    </>
  )
}

// ── Dynamic CI Group members ──────────────────────────────────────────────

const CI_GROUP_MEMBERS = gql`
  query CiGroupMembers($groupId: ID!) {
    ciGroupMembers(groupId: $groupId) {
      id name type environment status
    }
  }
`

interface GroupMember {
  id: string; name: string; type: string
  environment: string | null; status: string | null
}

/** Default members drawn in the graph; raisable from the map header. The table shows all. */
const DEFAULT_GRAPH_MEMBER_CAP = 50
const GRAPH_MEMBER_CAP_OPTIONS = [50, 100, 200, 500]

const MEMBERS_PAGE_SIZE = 25

function CIGroupMembersCard({ groupId }: { groupId: string }) {
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [membersPage, setMembersPage] = useState(0)
  const { data, loading } = useQuery<{ ciGroupMembers: GroupMember[] }>(
    CI_GROUP_MEMBERS,
    { variables: { groupId } },
  )
  const members = data?.ciGroupMembers ?? []
  const pageMembers = members.slice(membersPage * MEMBERS_PAGE_SIZE, (membersPage + 1) * MEMBERS_PAGE_SIZE)
  const totalPages = Math.ceil(members.length / MEMBERS_PAGE_SIZE)

  return (
    <SectionCard title={`${t('pages.ci.members')} (${members.length})`} defaultOpen={true}>
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
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      {enumValues && enumValues.length > 0 ? (
        <Select value={value} onChange={e => onChange(e.target.value)}>
          <option value="">—</option>
          {enumValues.map(v => <option key={v} value={v}>{v}</option>)}
        </Select>
      ) : multiline ? (
        <Textarea value={value} onChange={e => onChange(e.target.value)} rows={3} />
      ) : (
        <Input type="text" value={value} onChange={e => onChange(e.target.value)} />
      )}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function CIDetailPage() {
  const { typeName, id } = useParams<{ typeName: string; id: string }>()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { getCIType, loading: metamodelLoading } = useMetamodel()

  const ciType = typeName ? getCIType(typeName) : undefined

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

  const { data, loading, refetch } = useQuery<Record<string, CIDetail | null>>(
    detailQuery ?? gql`query EmptyCIDetail { __typename }`,
    { variables: { id }, skip: !detailQuery || !id },
  )

  const { data: brData } = useQuery<{
    blastRadius: { distance: number; parentId: string | null; ci: { id: string; name: string; type: string; environment: string | null; status: string | null } }[]
  }>(GET_BLAST_RADIUS, { variables: { id }, skip: !id })

  const blastRadius = brData?.blastRadius ?? []

  // Dynamic CI groups have no DEPENDS_ON edges to their members (manual ones use
  // HAS_MEMBER, dynamic ones resolve by criteria), so the map is driven by the
  // group members instead — capped for renderability; the members table shows all.
  const isGroup = typeName === 'dynamic_ci_group'
  const { data: groupMembersData, refetch: refetchGroupMembers } = useQuery<{ ciGroupMembers: GroupMember[] }>(
    CI_GROUP_MEMBERS,
    { variables: { groupId: id }, skip: !id || !isGroup, fetchPolicy: 'cache-and-network' },
  )
  const groupMembers = groupMembersData?.ciGroupMembers ?? []
  const [graphCap, setGraphCap] = useState(DEFAULT_GRAPH_MEMBER_CAP)

  const ci = typeName && data ? data[typeName] : undefined

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
      toast.success('Modifiche salvate')
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
    return <div style={{ padding: 40, color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Caricamento…</div>
  }
  if (!ciType) {
    return <div style={{ padding: 40, color: 'var(--color-trigger-sla-breach)', fontSize: 'var(--font-size-body)' }}>Tipo CI "{typeName}" non trovato.</div>
  }
  if (!ci) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
        <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>CI non trovato.</p>
        <button
          onClick={() => navigate(`/ci/${typeName}`)}
          style={{ color: 'var(--color-brand)', background: 'none', border: 'none', fontSize: 'var(--font-size-body)', cursor: 'pointer' }}
        >
          ← Torna a {ciType.label}
        </button>
      </div>
    )
  }

  return (
    <PageContainer>
      <button
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
            title="Informazioni"
            defaultOpen={true}
            headerRight={
              !editMode ? (
                <button
                  onClick={e => { e.stopPropagation(); startEdit() }}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 'var(--font-size-body)', fontWeight: 500, borderRadius: 6, border: '1px solid var(--color-brand)', background: 'transparent', color: 'var(--color-brand)', cursor: 'pointer' }}
                >
                  <Pencil size={12} /> Modifica
                </button>
              ) : undefined
            }
          >
            {editMode ? (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  {/* Read-only fields */}
                  <DetailField label="ID" value={ci.id} mono />
                  <DetailField label="Tipo" value={ciType.label} />
                  <DetailField label="Creato" value={new Date(ci.createdAt).toLocaleDateString('it-IT')} />
                  <DetailField label="Aggiornato" value={ci.updatedAt ? new Date(ci.updatedAt).toLocaleDateString('it-IT') : null} />

                  {/* Editable base fields */}
                  <EditField label="Nome" value={editDraft['name'] ?? ''} onChange={v => setEditDraft(d => ({ ...d, name: v }))} />
                  <EditField label="Status" value={editDraft['status'] ?? ''}
                    enumValues={ciType.fields.find(f => f.name === 'status')?.enumValues}
                    onChange={v => setEditDraft(d => ({ ...d, status: v }))} />
                  <EditField label="Environment" value={editDraft['environment'] ?? ''}
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
                <div style={{ borderTop: '1px solid #f3f4f6', margin: '12px 0' }} />
                <EditField label="Descrizione" value={editDraft['description'] ?? ''} multiline onChange={v => setEditDraft(d => ({ ...d, description: v }))} />
                <div style={{ marginTop: 12 }} />
                <EditField label="Note" value={editDraft['notes'] ?? ''} multiline onChange={v => setEditDraft(d => ({ ...d, notes: v }))} />

                {/* Save / Cancel */}
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button onClick={handleSaveAll} style={{ padding: '6px 18px', borderRadius: 6, border: 'none', background: 'var(--color-brand)', color: '#fff', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                    Salva
                  </button>
                  <button onClick={() => setEditMode(false)} style={{ padding: '6px 14px', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', color: 'var(--color-slate)', fontWeight: 600, fontSize: 'var(--font-size-body)', cursor: 'pointer' }}>
                    Annulla
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <DetailField label="ID" value={ci.id} mono />
                  <DetailField label="Nome" value={ci.name} />
                  <DetailField label="Tipo" value={ciType.label} />
                  <DetailField label="Status" value={ci.status ? <StatusBadge value={ci.status} /> : null} />
                  <DetailField label="Environment" value={ci.environment ?? null} />
                  <DetailField label="Creato" value={new Date(ci.createdAt).toLocaleDateString('it-IT')} />
                  <DetailField label="Aggiornato" value={ci.updatedAt ? new Date(ci.updatedAt).toLocaleDateString('it-IT') : null} />
                  {ci.ownerGroup && (
                    <DetailField label="Owner Group" value={
                      <Pill bg="var(--color-brand-light)" color="var(--color-brand)" radius={100} style={{ fontSize: 'var(--font-size-body)', fontWeight: 500 }}>
                        {(ci.ownerGroup as Team).name}
                      </Pill>
                    } />
                  )}
                  {ci.supportGroup && (
                    <DetailField label="Support Group" value={
                      <Pill bg="var(--color-success-bg)" color="var(--color-trigger-automatic)" radius={100} style={{ fontSize: 'var(--font-size-body)', fontWeight: 500 }}>
                        {(ci.supportGroup as Team).name}
                      </Pill>
                    } />
                  )}
                  {specificFields.map(f => (
                    <DetailField
                      key={f.name}
                      label={f.label}
                      value={ci[f.name] !== null && ci[f.name] !== undefined ? String(ci[f.name]) : null}
                    />
                  ))}
                </div>
                <DetailField label="Descrizione" value={ci.description} />
                <DetailField label="Note" value={ci.notes as string ?? null} />
              </>
            )}
          </SectionCard>

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
            title={isGroup ? 'Mappa Membri' : 'Mappa Dipendenze'}
            defaultOpen={isGroup}
            headerRight={isGroup && groupMembers.length > DEFAULT_GRAPH_MEMBER_CAP ? (
              <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--text-muted)' }}>Nodi:</span>
                <Select value={String(graphCap)} onChange={(e) => setGraphCap(Number(e.target.value))} style={{ width: 'auto', padding: '3px 8px' }}>
                  {GRAPH_MEMBER_CAP_OPTIONS.filter((n, i) => n < groupMembers.length || GRAPH_MEMBER_CAP_OPTIONS[i - 1] === undefined || GRAPH_MEMBER_CAP_OPTIONS[i - 1] < groupMembers.length).map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                  <option value={groupMembers.length}>Tutti ({groupMembers.length})</option>
                </Select>
              </span>
            ) : undefined}
          >
            <Suspense fallback={<div style={{ height: 260 }} />}>
            {isGroup ? (
              <CIGraph
                centerCI={{
                  id: ci.id, name: ci.name, type: ci.type,
                  status: ci.status ?? 'unknown', environment: ci.environment ?? undefined,
                }}
                dependencies={groupMembers.slice(0, graphCap).map(m => ({
                  relationType: 'HAS_MEMBER',
                  ci: { id: m.id, name: m.name, type: m.type, status: m.status ?? 'unknown', environment: m.environment ?? undefined },
                }))}
                dependents={[]}
                blastRadius={[]}
              />
            ) : (
              <CIGraph
                centerCI={{
                  id: ci.id, name: ci.name, type: ci.type,
                  status: ci.status ?? 'unknown', environment: ci.environment ?? undefined,
                }}
                dependencies={(ci.dependencies as CIRelation[]).map(r => ({
                  relationType: r.relation,
                  ci: { id: r.ci.id, name: r.ci.name, type: r.ci.type, status: r.ci.status ?? 'unknown', environment: r.ci.environment ?? undefined },
                }))}
                dependents={(ci.dependents as CIRelation[]).map(r => ({
                  relationType: r.relation,
                  ci: { id: r.ci.id, name: r.ci.name, type: r.ci.type, status: r.ci.status ?? 'unknown', environment: r.ci.environment ?? undefined },
                }))}
                blastRadius={blastRadius.map(b => ({
                  ...b.ci,
                  status: b.ci.status ?? 'unknown',
                  environment: b.ci.environment ?? undefined,
                  distance: b.distance, parentId: b.parentId,
                }))}
              />
            )}
            {isGroup && groupMembers.length > graphCap && (
              <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--text-muted)', margin: '8px 0 0' }}>
                Mostra i primi {graphCap} di {groupMembers.length} membri — la lista completa è nella tabella sopra.
              </p>
            )}
            </Suspense>
          </SectionCard>

          <SectionCard
            title={`Relazioni (${(ci.dependencies as CIRelation[]).length + (ci.dependents as CIRelation[]).length})`}
            defaultOpen={false}
            headerRight={
              <button
                onClick={e => { e.stopPropagation(); setShowAddRel(true) }}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', fontSize: 'var(--font-size-body)', fontWeight: 500, borderRadius: 6, border: '1px solid var(--color-brand)', background: 'transparent', color: 'var(--color-brand)', cursor: 'pointer' }}
              >
                <Plus size={12} /> {t('pages.ci.addRelation')}
              </button>
            }
          >
            {(ci.dependencies as CIRelation[]).length === 0 && (ci.dependents as CIRelation[]).length === 0 ? (
              <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0 }}>Nessuna relazione.</p>
            ) : (
              <>
                {(ci.dependencies as CIRelation[]).length > 0 && (
                  <div style={{ marginBottom: (ci.dependents as CIRelation[]).length > 0 ? 16 : 0 }}>
                    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                      Dipendenze
                    </div>
                    <RelationList
                      relations={ci.dependencies as CIRelation[]}
                      navigate={navigate}
                      onDelete={rel => setDeleteRel({ sourceId: ci.id, targetId: rel.ci.id, relationType: rel.relation, name: rel.ci.name })}
                    />
                  </div>
                )}

                {(ci.dependencies as CIRelation[]).length > 0 && (ci.dependents as CIRelation[]).length > 0 && (
                  <div style={{ borderTop: '1px solid #f3f4f6', margin: '8px 0 16px 0' }} />
                )}

                {(ci.dependents as CIRelation[]).length > 0 && (
                  <div>
                    <div style={{ fontSize: 'var(--font-size-label)', fontWeight: 700, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 }}>
                      Dipendenti
                    </div>
                    <RelationList
                      relations={ci.dependents as CIRelation[]}
                      navigate={navigate}
                      onDelete={rel => setDeleteRel({ sourceId: rel.ci.id, targetId: ci.id, relationType: rel.relation, name: rel.ci.name })}
                    />
                  </div>
                )}
              </>
            )}

            {/* Delete confirmation */}
            {deleteRel && (
              <div style={{ padding: '12px 16px', background: 'var(--color-danger-bg)', border: '1px solid #fecaca', borderRadius: 8, marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 'var(--font-size-body)', color: '#991b1b' }}>
                  {t('pages.ci.removeRelation', { relationType: deleteRel.relationType, name: deleteRel.name })}
                </span>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => setDeleteRel(null)}
                    style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', borderRadius: 6, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', color: 'var(--color-slate-dark)' }}
                  >
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={handleRemoveRelation}
                    style={{ padding: '4px 12px', fontSize: 'var(--font-size-body)', borderRadius: 6, border: 'none', background: 'var(--color-danger)', color: '#fff', cursor: 'pointer' }}
                  >
                    {t('common.delete')}
                  </button>
                </div>
              </div>
            )}

            {/* Add relation modal */}
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
                      style={{ fontSize: 'var(--font-size-body)', ...(addRelForm.targetCI ? {} : { backgroundColor: '#d1d5db' }) }}
                    >
                      {t('pages.ci.addRelation')}
                    </Button>
                  </>
                }
              >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {/* Relation type */}
                    <div>
                      <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>
                        {t('pages.ci.relationType')}
                      </label>
                      <Select
                        value={addRelForm.relationType}
                        onChange={e => setAddRelForm(prev => ({ ...prev, relationType: e.target.value, targetCI: null, search: '' }))}
                        style={{ padding: '8px 10px', outline: undefined }}
                      >
                        <option value="DEPENDS_ON">DEPENDS_ON</option>
                        <option value="HOSTED_ON">HOSTED_ON</option>
                        <option value="USES_CERTIFICATE">USES_CERTIFICATE</option>
                      </Select>
                    </div>

                    {/* Direction */}
                    <div>
                      <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 6 }}>
                        {t('pages.ci.direction')}
                      </label>
                      <div style={{ display: 'flex', gap: 12 }}>
                        {(['outgoing', 'incoming'] as const).map(dir => (
                          <label key={dir} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', cursor: 'pointer', color: addRelForm.direction === dir ? 'var(--color-brand)' : 'var(--color-slate)' }}>
                            <input type="radio" name="rel-dir" checked={addRelForm.direction === dir} onChange={() => setAddRelForm(prev => ({ ...prev, direction: dir }))} />
                            {dir === 'outgoing' ? t('pages.ci.dirOutgoing') : t('pages.ci.dirIncoming')}
                          </label>
                        ))}
                      </div>
                    </div>

                    {/* CI search */}
                    <div style={{ position: 'relative' }}>
                      <label style={{ display: 'block', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', marginBottom: 4 }}>
                        CI Target
                      </label>
                      <Input
                        placeholder={t('pages.ci.searchTarget')}
                        value={addRelForm.search}
                        onChange={e => handleCISearch(e.target.value)}
                        style={{ padding: '8px 10px', outline: undefined }}
                      />
                      {addRelForm.targetCI && (
                        <div style={{ marginTop: 6, padding: '6px 10px', background: '#f0f9ff', border: '1px solid #bae6fd', borderRadius: 6, fontSize: 'var(--font-size-body)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span><strong>{addRelForm.targetCI.name}</strong> <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>({addRelForm.targetCI.type})</span></span>
                          <button onClick={() => setAddRelForm(prev => ({ ...prev, targetCI: null, search: '' }))} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}><X size={14} color="#94a3b8" /></button>
                        </div>
                      )}
                      {ciSearchResults.length > 0 && !addRelForm.targetCI && (
                        <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #e5e7eb', borderRadius: 6, maxHeight: 180, overflowY: 'auto', zIndex: 10, boxShadow: '0 4px 12px rgba(0,0,0,.08)', marginTop: 2 }}>
                          {ciSearchResults.map(c => (
                            <div
                              key={c.id}
                              onClick={() => setAddRelForm(prev => ({ ...prev, targetCI: c, search: c.name }))}
                              className="hover-bg"
                              style={{ padding: '8px 12px', fontSize: 'var(--font-size-body)', cursor: 'pointer', borderBottom: '1px solid #f3f4f6', ['--hover-bg' as string]: '#f1f5f9' }}
                            >
                              <span style={{ fontWeight: 500 }}>{c.name}</span>{' '}
                              <span style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>({c.type.replace(/_/g, ' ')})</span>
                            </div>
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
          </SectionCard>

          <CIIncidentsCard ciId={ci.id} />
          <CIChangeList ciId={ci.id} />

          <AttachmentsSection entityType="ci" entityId={ci.id} />
        </div>

      </div>
    </PageContainer>
  )
}
