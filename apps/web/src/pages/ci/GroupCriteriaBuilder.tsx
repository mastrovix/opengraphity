import { useMemo, useState } from 'react'
import { gql } from '@apollo/client'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { SectionCard } from '@/components/ui/SectionCard'
import { Select, Input, FieldLabel } from '@/components/ui/FormControls'
import { Button } from '@/components/Button'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { toPascalCase } from '@/lib/stringUtils'
import { UPDATE_CI } from '@/graphql/mutations'

const PREVIEW_COUNT = gql`
  query GroupCriteriaPreview($ciTypes: [String], $environment: String, $status: String, $search: String) {
    allCIs(ciTypes: $ciTypes, environment: $environment, status: $status, search: $search, limit: 1, offset: 0) {
      total
    }
  }
`

const ENVIRONMENTS = ['production', 'staging', 'development']
const STATUSES     = ['active', 'inactive', 'maintenance']

interface Props {
  groupId:  string
  criteria: { ciTypes: string; environment: string; status: string; nameContains: string }
  /** Called after a successful save so the parent can refetch detail + members. */
  onSaved:  () => void
}

/**
 * Visual query builder for dynamic group membership: CI-type chips,
 * environment/status selects, name filter — with a live count preview
 * (same semantics as the backend ciGroupMembers criteria evaluation).
 */
export function GroupCriteriaBuilder({ groupId, criteria, onSaved }: Props) {
  const { t } = useTranslation()
  const { ciTypes } = useMetamodel()

  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(
    () => new Set(criteria.ciTypes.split(',').map((s) => s.trim()).filter(Boolean)),
  )
  const [environment, setEnvironment]   = useState(criteria.environment)
  const [status, setStatus]             = useState(criteria.status)
  const [nameContains, setNameContains] = useState(criteria.nameContains)
  const [saving, setSaving]             = useState(false)

  // Selectable types: every active CI type except groups themselves
  const selectableTypes = useMemo(
    () => ciTypes.filter((ct) => ct.active && ct.name !== 'dynamic_ci_group' && ct.name !== '__base__'),
    [ciTypes],
  )

  // Live preview — allCIs matches lowercased Neo4j labels
  const previewCiTypes = selectedTypes.size > 0
    ? [...selectedTypes].map((n) => toPascalCase(n).toLowerCase())
    : undefined
  const { data: previewData, loading: previewLoading } = useQuery<{ allCIs: { total: number } }>(PREVIEW_COUNT, {
    variables: {
      ciTypes:     previewCiTypes ?? null,
      environment: environment || null,
      status:      status || null,
      search:      nameContains.trim() || null,
    },
    fetchPolicy: 'cache-and-network',
  })
  const previewTotal = previewData?.allCIs?.total

  const [updateCIFields] = useMutation(UPDATE_CI)

  const dirty =
    [...selectedTypes].sort().join(',') !== criteria.ciTypes.split(',').map((s) => s.trim()).filter(Boolean).sort().join(',')
    || environment !== criteria.environment
    || status !== criteria.status
    || nameContains !== criteria.nameContains

  const toggleType = (name: string) => {
    setSelectedTypes((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  const save = async () => {
    setSaving(true)
    try {
      await updateCIFields({
        variables: {
          id: groupId,
          input: {
            criteriaCiTypes:      [...selectedTypes].join(','),
            criteriaEnvironment:  environment,
            criteriaStatus:       status,
            criteriaNameContains: nameContains.trim(),
          },
        },
      })
      toast.success(t('pages.ci.criteriaSaved'))
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionCard title={t('pages.ci.criteriaTitle')} defaultOpen={true}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {/* CI type chips */}
        <div>
          <FieldLabel>{t('pages.ci.criteriaTypes')}</FieldLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {selectableTypes.map((ct) => {
              const active = selectedTypes.has(ct.name)
              return (
                <button
                  key={ct.name}
                  type="button"
                  onClick={() => toggleType(ct.name)}
                  style={{
                    padding: '4px 12px', borderRadius: 100, fontSize: 'var(--font-size-body)', fontWeight: 500,
                    cursor: 'pointer', transition: 'all 120ms',
                    border: active ? '1.5px solid var(--color-brand)' : '1.5px solid #e5e7eb',
                    background: active ? 'var(--color-brand-light)' : '#fff',
                    color: active ? 'var(--color-brand)' : 'var(--color-slate)',
                  }}
                >
                  {ct.label}
                </button>
              )
            })}
          </div>
          <p style={{ fontSize: 'var(--font-size-table)', color: 'var(--text-muted)', margin: '6px 0 0' }}>
            {selectedTypes.size === 0 ? t('pages.ci.criteriaAllTypes') : t('pages.ci.criteriaNTypes', { count: selectedTypes.size })}
          </p>
        </div>

        {/* Environment / status / name */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div>
            <FieldLabel>Environment</FieldLabel>
            <Select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
              <option value="">—</option>
              {ENVIRONMENTS.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          </div>
          <div>
            <FieldLabel>Status</FieldLabel>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">—</option>
              {STATUSES.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          </div>
          <div>
            <FieldLabel>{t('pages.ci.criteriaNameContains')}</FieldLabel>
            <Input value={nameContains} onChange={(e) => setNameContains(e.target.value)} placeholder="es. web-" />
          </div>
        </div>

        {/* Live preview + save */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 4, borderTop: '1px solid #f3f4f6' }}>
          <span style={{ fontSize: 'var(--font-size-body)', color: 'var(--text-secondary)' }}>
            {previewLoading
              ? <Loader2 size={12} className="animate-spin" />
              : t('pages.ci.criteriaPreview', { count: previewTotal ?? 0 })}
          </span>
          <Button onClick={() => void save()} disabled={!dirty || saving} icon={saving ? <Loader2 size={13} className="animate-spin" /> : undefined}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </SectionCard>
  )
}
