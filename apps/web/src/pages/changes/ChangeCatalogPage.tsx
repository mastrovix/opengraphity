import { useState, useMemo } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { BookOpen, X, AlertTriangle, Clock, Info } from 'lucide-react'
import { toast } from 'sonner'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { GET_CHANGE_CATALOG_CATEGORIES, GET_STANDARD_CHANGE_CATALOG } from '@/graphql/queries'
import { GET_ALL_CIS } from '@/graphql/queries'
import { CREATE_CHANGE_FROM_CATALOG } from '@/graphql/mutations'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CatalogCategory {
  id: string; name: string; description: string | null; icon: string | null
  color: string | null; order: number; enabled: boolean; entryCount: number
}

interface CatalogEntry {
  id: string; name: string; description: string; categoryId: string
  riskLevel: string; impact: string; defaultTitleTemplate: string
  defaultDescriptionTemplate: string; defaultPriority: string
  ciTypes: string[] | null; checklist: string | null
  estimatedDurationHours: number | null; requiresDowntime: boolean
  rollbackProcedure: string | null; icon: string | null; color: string | null
  usageCount: number; enabled: boolean; createdBy: string | null
  createdAt: string; updatedAt: string | null
  category: { id: string; name: string; icon: string | null; color: string | null } | null
}

interface CI { id: string; name: string; type: string }

interface ChecklistItem { order: number; title: string; description?: string }

// ── Styles ────────────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 13, color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box',
}
const selectS: React.CSSProperties = {
  ...inputS, appearance: 'none' as const,
  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%238892a4' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
  backgroundRepeat: 'no-repeat', backgroundPosition: 'right 10px center', paddingRight: 30, cursor: 'pointer',
}
const labelS: React.CSSProperties = { display: 'block', fontSize: 12, fontWeight: 500, color: 'var(--color-slate)', marginBottom: 4 }
const btnPrimary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '8px 16px', border: 'none', borderRadius: 6, background: '#38bdf8',
  color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer', transition: 'background-color 150ms',
}
const btnSecondary: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '7px 14px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff',
  color: 'var(--color-slate)', fontSize: 13, cursor: 'pointer',
}
const badge = (bg: string, fg: string): React.CSSProperties => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: bg, color: fg,
})

// ── Helpers ───────────────────────────────────────────────────────────────────

function riskBadge(risk: string): React.CSSProperties {
  switch (risk) {
    case 'low':    return badge('#dcfce7', '#15803d')
    case 'medium': return badge('#fef3c7', '#92400e')
    case 'high':   return badge('#fee2e2', '#991b1b')
    default:       return badge('#f3f4f6', '#6b7280')
  }
}

function riskLabel(risk: string): string {
  switch (risk) {
    case 'low':    return 'Basso'
    case 'medium': return 'Medio'
    case 'high':   return 'Alto'
    default:       return risk
  }
}

function parseChecklist(raw: string | null): ChecklistItem[] {
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

function ColorIcon({ icon, color }: { icon: string | null; color: string | null }) {
  return (
    <div style={{
      width: 32, height: 32, borderRadius: 8, display: 'flex',
      alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700,
      background: color || '#e0f2fe', color: color ? '#fff' : '#0284c7', flexShrink: 0,
    }}>
      {icon ? icon.charAt(0).toUpperCase() : '?'}
    </div>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ChangeCatalogPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [selectedEntry, setSelectedEntry] = useState<CatalogEntry | null>(null)

  // Creation form
  const [formTitle, setFormTitle] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formPriority, setFormPriority] = useState('')
  const [formCIIds, setFormCIIds] = useState<string[]>([])

  const { data: catData } = useQuery<{ changeCatalogCategories: CatalogCategory[] }>(GET_CHANGE_CATALOG_CATEGORIES)
  const { data: entriesData, loading } = useQuery<{ standardChangeCatalog: CatalogEntry[] }>(GET_STANDARD_CHANGE_CATALOG, {
    variables: { search: search || null },
    fetchPolicy: 'cache-and-network',
  })
  const { data: cisData } = useQuery<{ allCIs: CI[] }>(GET_ALL_CIS, { skip: !selectedEntry })

  const [createFromCatalog] = useMutation<{ createChangeFromCatalog: { id: string } }>(CREATE_CHANGE_FROM_CATALOG)

  const categories = catData?.changeCatalogCategories?.filter(c => c.enabled).sort((a, b) => a.order - b.order) ?? []
  const entries = entriesData?.standardChangeCatalog?.filter(e => e.enabled) ?? []
  const allCIs = cisData?.allCIs ?? []

  // Filter CIs by entry ciTypes
  const filteredCIs = useMemo(() => {
    if (!selectedEntry?.ciTypes || selectedEntry.ciTypes.length === 0) return allCIs
    return allCIs.filter(ci => selectedEntry.ciTypes!.includes(ci.type))
  }, [allCIs, selectedEntry])

  // Group entries by category
  const grouped = useMemo(() => {
    const map = new Map<string, { category: CatalogCategory; entries: CatalogEntry[] }>()
    for (const cat of categories) {
      const catEntries = entries.filter(e => e.categoryId === cat.id)
      if (catEntries.length > 0) {
        map.set(cat.id, { category: cat, entries: catEntries })
      }
    }
    return Array.from(map.values())
  }, [categories, entries])

  function openEntry(entry: CatalogEntry) {
    setSelectedEntry(entry)
    setFormTitle(entry.defaultTitleTemplate)
    setFormDescription(entry.defaultDescriptionTemplate)
    setFormPriority(entry.defaultPriority)
    setFormCIIds([])
  }

  function closeModal() {
    setSelectedEntry(null)
  }

  async function handleCreate() {
    if (!selectedEntry) return
    try {
      const { data } = await createFromCatalog({
        variables: {
          catalogEntryId: selectedEntry.id,
          title: formTitle || null,
          description: formDescription || null,
          ciIds: formCIIds.length > 0 ? formCIIds : null,
        },
      })
      toast.success(t('pages.changeCatalog.created'))
      closeModal()
      if (data?.createChangeFromCatalog?.id) {
        navigate(`/changes/${data.createChangeFromCatalog.id}`)
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : String(e))
    }
  }

  const isSearching = search.trim().length > 0

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<BookOpen size={22} color="var(--color-brand)" />}>
            {t('pages.changeCatalog.title')}
          </PageTitle>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {t('pages.changeCatalog.subtitle')}
          </p>
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 24 }}>
        <input
          style={{ ...inputS, maxWidth: 400 }}
          placeholder={t('pages.changeCatalog.search')}
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {loading && !entries.length && (
        <p style={{ color: 'var(--color-slate-light)', fontSize: 13 }}>{t('common.loading')}</p>
      )}

      {!loading && entries.length === 0 && (
        <EmptyState
          icon={<BookOpen size={32} color="var(--color-slate-light)" />}
          title={t('pages.changeCatalog.noResults')}
        />
      )}

      {/* When searching: flat list */}
      {isSearching && entries.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
          {entries.map(entry => (
            <EntryCard key={entry.id} entry={entry} showCategory onClick={() => openEntry(entry)} t={t} />
          ))}
        </div>
      )}

      {/* No search: grouped by category */}
      {!isSearching && grouped.map(({ category, entries: catEntries }) => (
        <div key={category.id} style={{ marginBottom: 32 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <ColorIcon icon={category.icon} color={category.color} />
            <div>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                {category.name}
              </h3>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--color-slate-light)' }}>
                {category.description && <span>{category.description} &middot; </span>}
                {catEntries.length} {t('pages.changeCatalog.procedures')}
              </p>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
            {catEntries.map(entry => (
              <EntryCard key={entry.id} entry={entry} showCategory={false} onClick={() => openEntry(entry)} t={t} />
            ))}
          </div>
        </div>
      ))}

      {/* ── Creation Modal ──────────────────────────────────────────────── */}
      {selectedEntry && createPortal(
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999, padding: 16 }}
          onClick={e => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div style={{ background: '#fff', borderRadius: 14, width: '100%', maxWidth: 640, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 80px rgba(0,0,0,0.22)' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '18px 24px', borderBottom: '1px solid #f3f4f6' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <ColorIcon icon={selectedEntry.icon} color={selectedEntry.color} />
                <div>
                  <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--color-slate-dark)' }}>
                    {selectedEntry.name}
                  </h2>
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    {selectedEntry.category && (
                      <span style={badge(selectedEntry.category.color || '#e0f2fe', selectedEntry.category.color ? '#fff' : '#0284c7')}>
                        {selectedEntry.category.name}
                      </span>
                    )}
                    <span style={riskBadge(selectedEntry.riskLevel)}>
                      {riskLabel(selectedEntry.riskLevel)}
                    </span>
                    {selectedEntry.requiresDowntime && (
                      <span style={badge('#fee2e2', '#991b1b')}>Downtime</span>
                    )}
                  </div>
                </div>
              </div>
              <button onClick={closeModal} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 6, borderRadius: 6, display: 'flex' }}>
                <X size={20} color="var(--color-slate)" />
              </button>
            </div>

            <div style={{ padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
              {/* Description */}
              {selectedEntry.description && (
                <p style={{ fontSize: 13, color: 'var(--color-slate)', margin: 0, lineHeight: 1.5 }}>
                  {selectedEntry.description}
                </p>
              )}

              {/* Info box */}
              <div style={{ background: '#e0f2fe', border: '1px solid #bae6fd', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#0369a1', display: 'flex', alignItems: 'center', gap: 8 }}>
                <Info size={16} style={{ flexShrink: 0 }} />
                {t('pages.changeCatalog.preApproved')}
              </div>

              {/* Editable fields */}
              <div>
                <label style={labelS}>{t('common.title')} *</label>
                <input style={inputS} value={formTitle} onChange={e => setFormTitle(e.target.value)} />
              </div>

              <div>
                <label style={labelS}>{t('common.description')}</label>
                <textarea
                  style={{ ...inputS, minHeight: 80, resize: 'vertical' }}
                  value={formDescription}
                  onChange={e => setFormDescription(e.target.value)}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <label style={labelS}>Priority</label>
                  <select style={selectS} value={formPriority} onChange={e => setFormPriority(e.target.value)}>
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                    <option value="critical">Critical</option>
                  </select>
                </div>
                <div>
                  <label style={labelS}>CI</label>
                  <select
                    style={selectS}
                    multiple
                    value={formCIIds}
                    onChange={e => {
                      const opts = Array.from(e.target.selectedOptions, o => o.value)
                      setFormCIIds(opts)
                    }}
                  >
                    {filteredCIs.map(ci => (
                      <option key={ci.id} value={ci.id}>{ci.name} ({ci.type})</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Checklist */}
              {parseChecklist(selectedEntry.checklist).length > 0 && (
                <div>
                  <label style={{ ...labelS, marginBottom: 8 }}>{t('pages.changeCatalog.checklist')}</label>
                  <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--color-slate-dark)', lineHeight: 1.8 }}>
                    {parseChecklist(selectedEntry.checklist).map((item, i) => (
                      <li key={i}>
                        <strong>{item.title}</strong>
                        {item.description && <span style={{ color: 'var(--color-slate-light)' }}> — {item.description}</span>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}

              {/* Rollback */}
              {selectedEntry.rollbackProcedure && (
                <div>
                  <label style={{ ...labelS, marginBottom: 4 }}>{t('pages.changeCatalog.rollback')}</label>
                  <div style={{ fontSize: 13, color: 'var(--color-slate)', background: '#f9fafb', border: '1px solid #f3f4f6', borderRadius: 6, padding: '8px 12px', whiteSpace: 'pre-wrap' }}>
                    {selectedEntry.rollbackProcedure}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 24px', borderTop: '1px solid #f3f4f6' }}>
              <button style={btnSecondary} onClick={closeModal}>{t('common.cancel')}</button>
              <button
                style={btnPrimary}
                onClick={handleCreate}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#0ea5e9' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '#38bdf8' }}
              >
                {t('pages.changeCatalog.createTitle')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </PageContainer>
  )
}

// ── Entry Card ────────────────────────────────────────────────────────────────

function EntryCard({ entry, showCategory, onClick, t }: {
  entry: CatalogEntry; showCategory: boolean; onClick: () => void
  t: (key: string, opts?: Record<string, unknown>) => string
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10,
        overflow: 'hidden', cursor: 'pointer', transition: 'box-shadow 150ms',
      }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.boxShadow = 'none' }}
    >
      {/* Color stripe */}
      <div style={{ height: 4, background: entry.color || entry.category?.color || '#0284c7' }} />

      <div style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 8 }}>
          <ColorIcon icon={entry.icon} color={entry.color} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--color-slate-dark)', marginBottom: 2 }}>
              {entry.name}
            </div>
            <div style={{
              fontSize: 12, color: 'var(--color-slate-light)', lineHeight: 1.4,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            }}>
              {entry.description}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {showCategory && entry.category && (
            <span style={badge(entry.category.color || '#e0f2fe', entry.category.color ? '#fff' : '#0284c7')}>
              {entry.category.name}
            </span>
          )}
          <span style={riskBadge(entry.riskLevel)}>
            {riskLabel(entry.riskLevel)}
          </span>
          {entry.requiresDowntime && (
            <span style={badge('#fee2e2', '#991b1b')}>
              <AlertTriangle size={10} style={{ marginRight: 2, verticalAlign: 'middle' }} />
              Downtime
            </span>
          )}
          {entry.estimatedDurationHours != null && entry.estimatedDurationHours > 0 && (
            <span style={{ fontSize: 11, color: 'var(--color-slate-light)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Clock size={10} />
              ~{entry.estimatedDurationHours} {t('pages.changeCatalog.hours')}
            </span>
          )}
          <span style={{ fontSize: 11, color: 'var(--color-slate-light)', marginLeft: 'auto' }}>
            {t('pages.changeCatalog.usedTimes', { count: entry.usageCount })}
          </span>
        </div>
      </div>
    </div>
  )
}
