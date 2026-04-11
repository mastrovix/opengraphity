import { useState, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { ArrowLeft, Info, AlertTriangle, Clock, ChevronDown, ChevronRight } from 'lucide-react'
import { CIIcon } from '@/lib/ciIcon'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { GET_STANDARD_CHANGE_CATALOG_ENTRY, GET_ALL_CIS } from '@/graphql/queries'
import { CREATE_CHANGE_FROM_CATALOG } from '@/graphql/mutations'
import { useEnumValues } from '@/hooks/useEnumValues'

// ── Types ────────────────────────────────────────────────────────────────────

interface CatalogEntry {
  id: string; name: string; description: string; categoryId: string
  riskLevel: string; impact: string; defaultTitleTemplate: string
  defaultDescriptionTemplate: string; defaultPriority: string
  ciTypes: string[] | null; checklist: string | null
  estimatedDurationHours: number | null; requiresDowntime: boolean
  rollbackProcedure: string | null; icon: string | null; color: string | null
  usageCount: number; createdAt: string
  ciRequired: boolean; maintenanceWindow: string | null
  category: { id: string; name: string; icon: string | null; color: string | null } | null
  workflow: { id: string; name: string } | null
}

interface CI { id: string; name: string; type: string; environment: string; status: string }
interface ChecklistItem { order: number; title: string; description?: string }

// ── Styles ───────────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', padding: '9px 12px', border: '1px solid #e5e7eb',
  borderRadius: 8, fontSize: 13, color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box',
  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
}
const selectS: React.CSSProperties = {
  ...inputS, appearance: 'none' as const,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}
const labelS: React.CSSProperties = {
  display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-slate-light)',
  textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6,
}
const badge = (bg: string, fg: string): React.CSSProperties => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: bg, color: fg,
})

function riskBadge(risk: string): React.CSSProperties {
  return risk === 'low' ? badge('#dcfce7', '#15803d') : risk === 'medium' ? badge('#fef3c7', '#92400e') : badge('#fee2e2', '#991b1b')
}
// riskLabel moved inside component for i18n access

function parseChecklist(raw: string | null): ChecklistItem[] {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

// ── Component ────────────────────────────────────────────────────────────────

export function ChangeCatalogCreatePage() {
  const { entryId } = useParams<{ entryId: string }>()
  const { t } = useTranslation()
  const navigate = useNavigate()

  function riskLabel(risk: string): string {
    const labels: Record<string, string> = { low: t('pages.changeCatalog.riskLow'), medium: t('pages.changeCatalog.riskMedium'), high: t('pages.changeCatalog.riskHigh') }
    return labels[risk] ?? risk
  }

  const { data, loading } = useQuery<{ standardChangeCatalogEntry: CatalogEntry }>(
    GET_STANDARD_CHANGE_CATALOG_ENTRY,
    { variables: { id: entryId }, skip: !entryId },
  )
  const entry = data?.standardChangeCatalogEntry ?? null

  const { data: cisData } = useQuery<{ allCIs: { items: CI[] } }>(GET_ALL_CIS, {
    skip: !entry, variables: { limit: 500 },
  })
  const allCIs = Array.isArray(cisData?.allCIs?.items) ? cisData.allCIs.items : Array.isArray(cisData?.allCIs) ? (cisData.allCIs as unknown as CI[]) : []

  const { values: priorityValues } = useEnumValues('change', 'priority')

  const [createFromCatalog, { loading: creating }] = useMutation<{ createChangeFromCatalog: { id: string } }>(CREATE_CHANGE_FROM_CATALOG)

  // Form state — initialized from entry
  const [formTitle, setFormTitle] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formPriority, setFormPriority] = useState('')
  const [formCIIds, setFormCIIds] = useState<string[]>([])
  const [initialized, setInitialized] = useState(false)

  if (entry && !initialized) {
    setFormTitle(entry.defaultTitleTemplate)
    setFormDescription(entry.defaultDescriptionTemplate)
    setFormPriority(entry.defaultPriority)
    setInitialized(true)
  }

  const filteredCIs = useMemo(() => {
    if (!allCIs.length) return []
    const types = Array.isArray(entry?.ciTypes) ? entry.ciTypes : []
    if (types.length === 0) return allCIs
    return allCIs.filter(ci => types.includes(ci.type))
  }, [allCIs, entry])

  // Replace {ci_name} in title when CI selected
  const resolvedTitle = useMemo(() => {
    if (!formCIIds.length || !formTitle.includes('{ci_name}')) return formTitle
    const ci = allCIs.find(c => c.id === formCIIds[0])
    return ci ? formTitle.replace(/\{ci_name\}/g, ci.name) : formTitle
  }, [formTitle, formCIIds, allCIs])

  const checklist = useMemo(() => entry ? parseChecklist(entry.checklist) : [], [entry])

  async function handleCreate() {
    if (!entry) return
    try {
      const { data: result } = await createFromCatalog({
        variables: {
          catalogEntryId: entry.id,
          title: resolvedTitle || null,
          description: formDescription || null,
          ciIds: formCIIds.length > 0 ? formCIIds : null,
        },
      })
      toast.success(t('pages.changeCatalog.created'))
      if (result?.createChangeFromCatalog?.id) {
        navigate(`/changes/${result.createChangeFromCatalog.id}`)
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  if (loading) {
    return <PageContainer><p style={{ color: 'var(--color-slate-light)', fontSize: 13 }}>{t('common.loading')}</p></PageContainer>
  }

  if (!entry) {
    return <PageContainer><p style={{ color: 'var(--color-slate-light)', fontSize: 13 }}>{t('pages.changeCatalog.entryNotFound')}</p></PageContainer>
  }

  return (
    <PageContainer>
      {/* Back link */}
      <button
        onClick={() => navigate('/changes/catalog')}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)', fontSize: 12, padding: 0, marginBottom: 16 }}
      >
        <ArrowLeft size={13} /> {t('pages.changeCatalog.backToCatalog', 'Torna al catalogo')}
      </button>

      {/* Header — compact */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
        <CIIcon icon={entry.icon || entry.category?.icon || 'box'} size={22} color={entry.color || entry.category?.color || 'var(--color-brand)'} />
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--color-slate-dark)' }}>{entry.name}</h2>
        {entry.category && (
          <span style={badge(entry.category.color || '#e0f2fe', entry.category.color ? '#fff' : '#0284c7')}>
            {entry.category.name}
          </span>
        )}
        <span style={riskBadge(entry.riskLevel)}>{riskLabel(entry.riskLevel)}</span>
        <span style={riskBadge(entry.impact)}>{t('pages.changeCatalogAdmin.impact')}: {riskLabel(entry.impact)}</span>
        {entry.requiresDowntime && (
          <span style={badge('#fee2e2', '#991b1b')}>
            <AlertTriangle size={10} style={{ marginRight: 2, verticalAlign: 'middle' }} /> {t('pages.changeCatalogAdmin.downtime')}
          </span>
        )}
        {entry.estimatedDurationHours != null && entry.estimatedDurationHours > 0 && (
          <span style={{ fontSize: 12, color: 'var(--color-slate-light)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Clock size={12} /> ~{entry.estimatedDurationHours} {t('pages.changeCatalog.hours')}
          </span>
        )}
      </div>
      {entry.description && (
        <p style={{
          fontSize: 13, color: 'var(--color-slate-light)', margin: '0 0 16px', lineHeight: 1.5,
          display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden',
        }}>
          {entry.description}
        </p>
      )}

      {/* Info box */}
      <div style={{ background: '#e0f2fe', border: '1px solid #bae6fd', borderRadius: 10, padding: '12px 16px', fontSize: 13, color: '#0369a1', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Info size={18} style={{ flexShrink: 0 }} />
        {t('pages.changeCatalog.preApproved')}
      </div>

      {entry.maintenanceWindow && (
        <div style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 10, padding: '10px 16px', fontSize: 13, color: '#92400e', display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <Clock size={16} style={{ flexShrink: 0 }} />
          {t('pages.changeCatalog.maintenanceWindow')}: {entry.maintenanceWindow}
        </div>
      )}

      <div>
        <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: '24px 28px' }}>
          <h2 style={{ margin: '0 0 20px', fontSize: 16, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
            {t('pages.changeCatalog.createTitle')}
          </h2>

          <div style={{ marginBottom: 16 }}>
            <label style={labelS}>{t('common.title')} *</label>
            <input style={inputS} value={resolvedTitle} onChange={e => setFormTitle(e.target.value)} />
            {entry.defaultTitleTemplate.includes('{ci_name}') && (
              <p style={{ fontSize: 11, color: 'var(--color-slate-light)', margin: '4px 0 0' }}>
                {t('pages.changeCatalog.ciNameHint')}
              </p>
            )}
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={labelS}>{t('common.description')}</label>
            <textarea
              style={{ ...inputS, minHeight: 120, resize: 'vertical' }}
              value={formDescription}
              onChange={e => setFormDescription(e.target.value)}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={labelS}>{t('pages.changes.priority')}</label>
              <select style={selectS} value={formPriority} onChange={e => setFormPriority(e.target.value)}>
                {priorityValues.map(p => (
                  <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>
                ))}
              </select>
            </div>
            <div>
              <label style={labelS}>{t('pages.changeCatalog.sectionCI')}</label>
              <select
                style={{ ...selectS, minHeight: 80 }}
                multiple
                value={formCIIds}
                onChange={e => setFormCIIds(Array.from(e.target.selectedOptions, o => o.value))}
              >
                {filteredCIs.map(ci => (
                  <option key={ci.id} value={ci.id}>{ci.name} ({ci.type})</option>
                ))}
              </select>
              {entry.ciTypes && entry.ciTypes.length > 0 && (
                <p style={{ fontSize: 11, color: 'var(--color-slate-light)', margin: '4px 0 0' }}>
                  {t('pages.changeCatalog.filteredBy')}: {entry.ciTypes.join(', ')}
                </p>
              )}
            </div>
          </div>

          {/* Checklist */}
          {checklist.length > 0 && (
            <div style={{ marginTop: 8, marginBottom: 16, padding: '14px 16px', background: '#f9fafb', border: '1px solid #f3f4f6', borderRadius: 8 }}>
              <h3 style={{ margin: '0 0 10px', fontSize: 13, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                {t('pages.changeCatalog.checklist')}
              </h3>
              <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--color-slate-dark)', lineHeight: 1.8 }}>
                {checklist.map((item, i) => (
                  <li key={i}>
                    <strong>{item.title}</strong>
                    {item.description && (
                      <span style={{ color: 'var(--color-slate-light)', fontSize: 12 }}> — {item.description}</span>
                    )}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {/* Rollback — collapsible */}
          {entry.rollbackProcedure && <RollbackSection rollback={entry.rollbackProcedure} label={t('pages.changeCatalog.rollback')} />}

          {/* Actions */}
          {entry.ciRequired && formCIIds.length === 0 && (
            <p style={{ fontSize: 12, color: '#dc2626', margin: '8px 0 0' }}>
              {t('pages.changeCatalog.ciRequiredHint')}
            </p>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
            <button
              onClick={handleCreate}
              disabled={!(!creating && (!entry.ciRequired || formCIIds.length > 0))}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '10px 20px',
                backgroundColor: '#16a34a', color: '#fff', border: 'none', borderRadius: 8,
                fontSize: 14, fontWeight: 600, cursor: (!creating && (!entry.ciRequired || formCIIds.length > 0)) ? 'pointer' : 'not-allowed',
                opacity: (!creating && (!entry.ciRequired || formCIIds.length > 0)) ? 1 : 0.6, transition: 'background-color 150ms',
              }}
              onMouseEnter={e => { if (!creating) (e.currentTarget as HTMLElement).style.backgroundColor = '#15803d' }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#16a34a' }}
            >
              {creating ? t('common.loading') : t('pages.changeCatalog.createTitle')}
            </button>
            <button
              onClick={() => navigate('/changes/catalog')}
              style={{
                padding: '10px 16px', border: '1px solid #e5e7eb', borderRadius: 8,
                background: '#fff', color: 'var(--color-slate)', fontSize: 14, cursor: 'pointer',
              }}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </div>
    </PageContainer>
  )
}

// ── Rollback collapsible ─────────────────────────────────────────────────────

function RollbackSection({ rollback, label }: { rollback: string; label: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 8, border: '1px solid #f3f4f6', borderRadius: 8, overflow: 'hidden' }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8,
          padding: '10px 14px', background: '#f9fafb', border: 'none',
          cursor: 'pointer', fontSize: 13, fontWeight: 600, color: 'var(--color-slate-dark)',
          textAlign: 'left',
        }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        {label}
      </button>
      {open && (
        <div style={{ padding: '10px 14px', fontSize: 13, color: 'var(--color-slate)', whiteSpace: 'pre-wrap', fontFamily: 'monospace', lineHeight: 1.6, background: '#fff' }}>
          {rollback}
        </div>
      )}
    </div>
  )
}
