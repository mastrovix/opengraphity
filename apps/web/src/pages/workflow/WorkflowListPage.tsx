import { useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { AlertCircle, GitPullRequest } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { GET_WORKFLOW_LIST } from '@/graphql/queries'

interface WorkflowDef {
  id:         string
  name:       string
  entityType: string
  active:     boolean
  version:    number
}

export function WorkflowListPage() {
  const navigate = useNavigate()
  const { data, loading } = useQuery<{ workflowDefinitions: WorkflowDef[] }>(GET_WORKFLOW_LIST)

  const defs = data?.workflowDefinitions ?? []

  return (
    <div style={{ maxWidth: 900, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: '0 0 24px 0' }}>
        Workflow
      </h1>

      {loading ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} style={{ height: 140, width: 240, borderRadius: 10 }} />
          ))}
        </div>
      ) : defs.length === 0 ? (
        <p style={{ color: '#8892a4', fontSize: 13 }}>Nessun workflow trovato.</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {defs.map((def) => {
            const isIncident = def.entityType === 'incident'
            const color = isIncident ? '#4f46e5' : '#16a34a'
            const Icon  = isIncident ? AlertCircle : GitPullRequest

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
                  <div style={{ fontSize: 15, fontWeight: 600, color: '#0f1629' }}>
                    {def.name}
                  </div>
                  <div style={{ fontSize: 12, color: '#8892a4', marginTop: 2 }}>
                    {def.entityType}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 'auto' }}>
                  <span style={{
                    fontSize:        11,
                    fontWeight:      600,
                    padding:         '2px 8px',
                    borderRadius:    100,
                    backgroundColor: def.active ? '#f0fdf4' : '#f9fafb',
                    color:           def.active ? '#16a34a' : '#8892a4',
                  }}>
                    {def.active ? 'Attivo' : 'Inattivo'}
                  </span>
                  <span style={{ fontSize: 12, color: '#8892a4' }}>v{def.version}</span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
