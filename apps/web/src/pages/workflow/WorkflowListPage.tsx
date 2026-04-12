import { useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { AlertCircle, GitPullRequest, Route, BookOpen, Search, Inbox } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { Skeleton } from '@/components/ui/skeleton'
import { GET_WORKFLOW_LIST } from '@/graphql/queries'
import { lookupOrError } from '@/lib/tokens'

interface WorkflowDef {
  id:             string
  name:           string
  entityType:     string
  category:       string | null
  active:         boolean
  version:        number
  changeSubtype:  string | null
}

const SUBTYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  standard:  { bg: '#dcfce7', fg: '#166534' },
  normal:    { bg: '#dbeafe', fg: '#1e40af' },
  emergency: { bg: '#fee2e2', fg: '#991b1b' },
}

const ENTITY_META: Record<string, { label: string; Icon: typeof AlertCircle; color: string }> = {
  incident:        { label: 'Incident',        Icon: AlertCircle,    color: '#ef4444' },
  change:          { label: 'Change',          Icon: GitPullRequest, color: '#8b5cf6' },
  problem:         { label: 'Problem',         Icon: Search,         color: '#f59e0b' },
  service_request: { label: 'Service Request', Icon: Inbox,          color: '#0ea5e9' },
  kb_article:      { label: 'Knowledge Base',  Icon: BookOpen,       color: '#10b981' },
}

const ENTITY_ORDER = ['incident', 'change', 'problem', 'service_request', 'kb_article']

export function WorkflowListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, loading } = useQuery<{ workflowDefinitions: WorkflowDef[] }>(GET_WORKFLOW_LIST)

  const defs = data?.workflowDefinitions ?? []

  // Group by entityType, sort: default (no category) first
  const grouped = new Map<string, WorkflowDef[]>()
  for (const def of defs) {
    const list = grouped.get(def.entityType) ?? []
    list.push(def)
    grouped.set(def.entityType, list)
  }
  for (const [key, list] of grouped) {
    grouped.set(key, list.sort((a, b) => {
      if (!a.category && b.category) return -1
      if (a.category && !b.category) return 1
      return (a.category ?? '').localeCompare(b.category ?? '')
    }))
  }

  // Order columns by ENTITY_ORDER, then any extras
  const columnKeys = [
    ...ENTITY_ORDER.filter((k) => grouped.has(k)),
    ...[...grouped.keys()].filter((k) => !ENTITY_ORDER.includes(k)),
  ]

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Route size={22} color="#38bdf8" />}>
            {t('pages.workflow.title', 'Workflow')}
          </PageTitle>
          <p style={{ fontSize: 'var(--font-size-body)', color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${defs.length} workflow`}
          </p>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 24 }}>
          {[1, 2, 3].map((i) => (
            <div key={i}>
              <Skeleton style={{ height: 20, width: 120, borderRadius: 4, marginBottom: 12 }} />
              <Skeleton style={{ height: 120, borderRadius: 10 }} />
              <Skeleton style={{ height: 120, borderRadius: 10, marginTop: 12 }} />
            </div>
          ))}
        </div>
      ) : defs.length === 0 ? (
        <EmptyState
          icon={<Route size={32} color="var(--color-slate-light)" />}
          title={t('pages.workflow.noResults', 'Nessun workflow trovato')}
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(columnKeys.length, 4)}, 1fr)`, gap: 24 }}>
          {columnKeys.map((entityType) => {
            const meta = lookupOrError(ENTITY_META, entityType, 'ENTITY_META', { label: entityType, Icon: Route, color: '#ef4444' })
            const items = grouped.get(entityType)!

            return (
              <div key={entityType}>
                {/* Column header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14, paddingBottom: 10, borderBottom: '2px solid #e5e7eb' }}>
                  <meta.Icon size={18} color={meta.color} />
                  <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>{meta.label}</span>
                  <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)', marginLeft: 'auto' }}>{items.length}</span>
                </div>

                {/* Cards */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {items.map((def) => (
                    <div
                      key={def.id}
                      onClick={() => navigate(`/workflow/${def.id}`)}
                      style={{
                        background:    '#fff',
                        border:        '1px solid #e5e7eb',
                        borderRadius:  10,
                        padding:       16,
                        cursor:        'pointer',
                        transition:    'box-shadow 0.15s, border-color 0.15s',
                        display:       'flex',
                        flexDirection: 'column',
                        gap:           10,
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.08)'
                        ;(e.currentTarget as HTMLElement).style.borderColor = meta.color
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.boxShadow = 'none'
                        ;(e.currentTarget as HTMLElement).style.borderColor = '#e5e7eb'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                        <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                          {def.name}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          {def.changeSubtype && (() => {
                            const sc = lookupOrError(SUBTYPE_COLORS, def.changeSubtype, 'SUBTYPE_COLORS', { bg: '#ef4444', fg: '#fff' })
                            return (
                              <span style={{ fontSize: 'var(--font-size-label)', padding: '2px 8px', borderRadius: 4, background: sc.bg, color: sc.fg, fontWeight: 600 }}>
                                {def.changeSubtype === 'standard' ? 'Standard' : def.changeSubtype === 'normal' ? 'Normal' : 'Emergency'}
                              </span>
                            )
                          })()}
                          {def.category ? (
                            <span style={{ fontSize: 'var(--font-size-label)', padding: '2px 8px', borderRadius: 4, background: '#fef3c7', color: '#92400e', fontWeight: 600 }}>
                              {def.category}
                            </span>
                          ) : (
                            <span style={{ fontSize: 'var(--font-size-label)', padding: '2px 8px', borderRadius: 4, background: '#dcfce7', color: '#166534', fontWeight: 600 }}>
                              Default
                            </span>
                          )}
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span style={{
                          fontSize:        11,
                          fontWeight:      600,
                          padding:         '2px 8px',
                          borderRadius:    100,
                          backgroundColor: def.active ? 'var(--color-brand-light)' : '#f9fafb',
                          color:           def.active ? 'var(--color-brand)' : 'var(--color-slate-light)',
                          border:          def.active ? '1px solid #a5f3fc' : '1px solid #e5e7eb',
                        }}>
                          {def.active ? 'Attivo' : 'Inattivo'}
                        </span>
                        <span style={{ fontSize: 'var(--font-size-table)', color: 'var(--color-slate-light)' }}>v{def.version}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </PageContainer>
  )
}
