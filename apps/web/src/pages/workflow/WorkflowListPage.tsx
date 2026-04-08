import { useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/PageContainer'
import { AlertCircle, GitPullRequest, Route, BookOpen } from 'lucide-react'
import { PageTitle } from '@/components/PageTitle'
import { EmptyState } from '@/components/EmptyState'
import { Skeleton } from '@/components/ui/skeleton'
import { GET_WORKFLOW_LIST } from '@/graphql/queries'

interface WorkflowDef {
  id:         string
  name:       string
  entityType: string
  category:   string | null
  active:     boolean
  version:    number
}

export function WorkflowListPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { data, loading } = useQuery<{ workflowDefinitions: WorkflowDef[] }>(GET_WORKFLOW_LIST)

  const defs = data?.workflowDefinitions ?? []

  return (
    <PageContainer>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 24 }}>
        <div>
          <PageTitle icon={<Route size={22} color="var(--color-brand)" />}>
            {t('pages.workflow.title', 'Workflow')}
          </PageTitle>
          <p style={{ fontSize: 13, color: '#0f172a', marginTop: 4, marginBottom: 0 }}>
            {loading ? '—' : `${defs.length} workflow`}
          </p>
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} style={{ height: 140, width: 240, borderRadius: 10 }} />
          ))}
        </div>
      ) : defs.length === 0 ? (
        <EmptyState
          icon={<Route size={32} color="var(--color-slate-light)" />}
          title={t('pages.workflow.noResults', 'Nessun workflow trovato')}
        />
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {defs.map((def) => {
            const color = 'var(--color-brand)'
            const Icon  = def.entityType === 'incident' ? AlertCircle
                        : def.entityType === 'kb_article' ? BookOpen
                        : GitPullRequest

            return (
              <div
                key={def.id}
                onClick={() => navigate(`/workflow/${def.id}`)}
                style={{
                  background:    '#fff',
                  border:        '1px solid #e5e7eb',
                  borderRadius:  10,
                  padding:       20,
                  cursor:        'pointer',
                  minWidth:      240,
                  transition:    'box-shadow 0.15s',
                  display:       'flex',
                  flexDirection: 'column',
                  gap:           12,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.boxShadow = '0 4px 16px rgba(0,0,0,0.1)'
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.boxShadow = 'none'
                }}
              >
                <Icon size={22} color={color} />

                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--color-slate-dark)' }}>
                    {def.name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-slate-light)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6 }}>
                    {def.entityType}
                    {def.category ? (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#fef3c7', color: '#92400e', fontWeight: 600 }}>
                        {def.category}
                      </span>
                    ) : (
                      <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: '#f0f9ff', color: 'var(--color-brand)', fontWeight: 600 }}>
                        Default
                      </span>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto' }}>
                  <span style={{
                    fontSize:        11,
                    fontWeight:      600,
                    padding:         '2px 8px',
                    borderRadius:    100,
                    backgroundColor: def.active ? 'var(--color-brand-light)' : '#f9fafb',
                    color:           def.active ? 'var(--color-brand)' : 'var(--color-slate-light)',
                    border:          def.active ? '1px solid #a5f3fc' : '1px solid transparent',
                  }}>
                    {def.active ? 'Attivo' : 'Inattivo'}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--color-slate-light)' }}>v{def.version}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </PageContainer>
  )
}
