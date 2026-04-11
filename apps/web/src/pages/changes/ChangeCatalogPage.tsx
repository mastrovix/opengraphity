import { useState, useMemo } from 'react'
import { useQuery } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { BookOpen, AlertTriangle, Clock } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { GET_CHANGE_CATALOG_CATEGORIES, GET_STANDARD_CHANGE_CATALOG } from '@/graphql/queries'

// ── Types ────────────────────────────────────────────────────────────────────

interface CatalogCategory {
  id: string; name: string; description: string | null; icon: string | null
  color: string | null; order: number; enabled: boolean; entryCount: number
}

interface CatalogEntry {
  id: string; name: string; description: string; categoryId: string
  riskLevel: string; impact: string; estimatedDurationHours: number | null
  requiresDowntime: boolean; icon: string | null; color: string | null
  usageCount: number; enabled: boolean
  workflowId: string | null; ciRequired: boolean
  category: { id: string; name: string; icon: string | null; color: string | null } | null
  workflow: { id: string; name: string; category: string | null } | null
}

// ── Styles ───────────────────────────────────────────────────────────────────

const inputS: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid #e5e7eb',
  borderRadius: 6, fontSize: 13, color: 'var(--color-slate-dark)',
  outline: 'none', backgroundColor: '#fff', boxSizing: 'border-box',
}
const badge = (bg: string, fg: string): React.CSSProperties => ({
  display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: bg, color: fg,
})

function riskBadge(risk: string): React.CSSProperties {
  return risk === 'low' ? badge('#dcfce7', '#15803d') : risk === 'medium' ? badge('#fef3c7', '#92400e') : badge('#fee2e2', '#991b1b')
}
function riskLabel(risk: string, t: (key: string) => string): string {
  const labels: Record<string, string> = { low: t('pages.changeCatalog.riskLow'), medium: t('pages.changeCatalog.riskMedium'), high: t('pages.changeCatalog.riskHigh') }
  return labels[risk] ?? risk
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

// ── Component ────────────────────────────────────────────────────────────────

export function ChangeCatalogPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [search, setSearch] = useState('')

  const { data: catData } = useQuery<{ changeCatalogCategories: CatalogCategory[] }>(GET_CHANGE_CATALOG_CATEGORIES)
  const { data: entriesData, loading } = useQuery<{ standardChangeCatalog: CatalogEntry[] }>(GET_STANDARD_CHANGE_CATALOG, {
    variables: { search: search || null },
    fetchPolicy: 'cache-and-network',
  })

  const categories = catData?.changeCatalogCategories?.filter(c => c.enabled).sort((a, b) => a.order - b.order) ?? []
  const entries = entriesData?.standardChangeCatalog?.filter(e => e.enabled) ?? []

  const grouped = useMemo(() => {
    const result: { category: CatalogCategory; entries: CatalogEntry[] }[] = []
    for (const cat of categories) {
      const catEntries = entries.filter(e => e.categoryId === cat.id)
      if (catEntries.length > 0) result.push({ category: cat, entries: catEntries })
    }
    return result
  }, [categories, entries])

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
            <EntryCard key={entry.id} entry={entry} showCategory onClick={() => navigate(`/changes/catalog/${entry.id}`)} t={t} />
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
              <EntryCard key={entry.id} entry={entry} showCategory={false} onClick={() => navigate(`/changes/catalog/${entry.id}`)} t={t} />
            ))}
          </div>
        </div>
      ))}
    </PageContainer>
  )
}

// ── Entry Card ───────────────────────────────────────────────────────────────

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
            {entry.workflow && (
              <div style={{ fontSize: 11, color: 'var(--color-slate-light)', marginTop: 2 }}>
                {t('pages.changeCatalogAdmin.workflow')}: {entry.workflow.name}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {showCategory && entry.category && (
            <span style={badge(entry.category.color || '#e0f2fe', entry.category.color ? '#fff' : '#0284c7')}>
              {entry.category.name}
            </span>
          )}
          <span style={riskBadge(entry.riskLevel)}>{riskLabel(entry.riskLevel, t)}</span>
          {entry.requiresDowntime && (
            <span style={badge('#fee2e2', '#991b1b')}>
              <AlertTriangle size={10} style={{ marginRight: 2, verticalAlign: 'middle' }} /> {t('pages.changeCatalogAdmin.downtime')}
            </span>
          )}
          {entry.estimatedDurationHours != null && entry.estimatedDurationHours > 0 && (
            <span style={{ fontSize: 11, color: 'var(--color-slate-light)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Clock size={10} /> ~{entry.estimatedDurationHours} {t('pages.changeCatalog.hours')}
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
