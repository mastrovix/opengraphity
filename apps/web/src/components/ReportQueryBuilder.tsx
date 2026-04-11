import { AlertCircle, GitPullRequest, Users, User, Box } from 'lucide-react'
import type { Node } from '@xyflow/react'
import type { NavigableEntity } from './ReportFlowNodes'

interface NodeDataEntry {
  entityType: string; neo4jLabel: string; label: string
  isResult: boolean; isRoot: boolean
}

interface Props {
  entities:         NavigableEntity[]
  nodes:            Node[]
  nodeDataMap:      Record<string, NodeDataEntry>
  onSelectRoot:     (entity: NavigableEntity) => void
}

function getEntityIcon(entityType: string, size = 24): React.ReactNode {
  switch (entityType) {
    case 'Incident': return <AlertCircle    size={size} color="var(--color-danger)" />
    case 'Change':   return <GitPullRequest  size={size} color="#3b82f6" />
    case 'Team':     return <Users           size={size} color="#8b5cf6" />
    case 'User':     return <User            size={size} color="#10b981" />
    default:         return <Box             size={size} color="var(--color-brand)" />
  }
}

const ITSM_TYPES = ['Incident', 'Change']
const ORG_TYPES  = ['Team', 'User']

export function ReportQueryBuilder({ entities, nodes, nodeDataMap, onSelectRoot }: Props) {
  const itsmEntities = entities.filter(e => ITSM_TYPES.includes(e.entityType))
  const orgEntities  = entities.filter(e => ORG_TYPES.includes(e.entityType))
  const ciEntities   = entities.filter(e => !ITSM_TYPES.includes(e.entityType) && !ORG_TYPES.includes(e.entityType))

  const renderGroup = (groupLabel: string, items: NavigableEntity[]) => {
    if (!items.length) return null
    return (
      <div style={{ marginBottom: 24 }} key={groupLabel}>
        <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 700, color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
          {groupLabel}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 12 }}>
          {items.map(e => {
            const isSelected = nodes.length > 0 && (nodeDataMap[nodes[0]?.id] as NodeDataEntry | undefined)?.neo4jLabel === e.neo4jLabel
            return (
              <div
                key={e.entityType}
                onClick={() => onSelectRoot(e)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  gap: 10, padding: '20px 12px', borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                  transition: 'all 0.15s',
                  border:     isSelected ? '2px solid #0284c7' : '1px solid #e5e7eb',
                  background: isSelected ? 'var(--color-brand-light)' : '#fff',
                }}
              >
                {getEntityIcon(e.entityType, 28)}
                <span style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: isSelected ? 'var(--color-brand)' : 'var(--color-slate)' }}>
                  {e.label}
                </span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <div>
      <h3 style={{ margin: '0 0 6px', fontSize: 'var(--font-size-card-title)', fontWeight: 700, color: 'var(--color-slate-dark)' }}>
        Cosa vuoi analizzare?
      </h3>
      <p style={{ margin: '0 0 24px', fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
        Scegli il tipo di dato su cui costruire la sezione del report.
      </p>
      {renderGroup('ITSM', itsmEntities)}
      {renderGroup('Organizzazione', orgEntities)}
      {renderGroup('CI', ciEntities)}
    </div>
  )
}
