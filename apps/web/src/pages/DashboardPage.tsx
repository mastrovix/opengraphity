import { useQuery } from '@apollo/client/react'
import { AlertTriangle, Bug, GitPullRequest, ClipboardList, TrendingUp } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { GET_DASHBOARD_STATS } from '@/graphql/queries'

interface DashboardStats {
  openIncidents:  { id: string }[]
  openProblems:   { id: string }[]
  pendingChanges: { id: string }[]
  openRequests:   { id: string }[]
}

const kpis = [
  {
    key:       'openIncidents' as const,
    label:     'Open Incidents',
    icon:      AlertTriangle,
    accent:    'var(--danger)',
    accentBg:  'var(--danger-light)',
  },
  {
    key:       'openProblems' as const,
    label:     'Open Problems',
    icon:      Bug,
    accent:    'var(--warning)',
    accentBg:  'var(--warning-light)',
  },
  {
    key:       'pendingChanges' as const,
    label:     'Pending Changes',
    icon:      GitPullRequest,
    accent:    'var(--info)',
    accentBg:  'var(--info-light)',
  },
  {
    key:       'openRequests' as const,
    label:     'Open Requests',
    icon:      ClipboardList,
    accent:    'var(--success)',
    accentBg:  'var(--success-light)',
  },
]

export function DashboardPage() {
  const { data, loading } = useQuery<DashboardStats>(GET_DASHBOARD_STATS)

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
          Dashboard
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>
          Overview of your ITSM platform
        </p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-4" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))' }}>
        {kpis.map(({ key, label, icon: Icon, accent, accentBg }) => (
          <div
            key={key}
            style={{
              backgroundColor: 'var(--surface)',
              border:          '1px solid var(--border)',
              borderRadius:    8,
              padding:         '20px 24px',
            }}
          >
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                {label}
              </span>
              <div
                style={{
                  width:           32,
                  height:          32,
                  borderRadius:    8,
                  backgroundColor: accentBg,
                  display:         'flex',
                  alignItems:      'center',
                  justifyContent:  'center',
                }}
              >
                <Icon size={15} style={{ color: accent }} />
              </div>
            </div>
            {loading ? (
              <Skeleton className="h-9 w-16" />
            ) : (
              <div className="flex items-end gap-2">
                <span style={{ fontSize: 32, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1 }}>
                  {data?.[key]?.length ?? 0}
                </span>
                <TrendingUp size={13} style={{ color: 'var(--text-muted)', marginBottom: 4 }} />
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Quick links section */}
      <div
        style={{
          backgroundColor: 'var(--surface)',
          border:          '1px solid var(--border)',
          borderRadius:    8,
          padding:         '20px 24px',
        }}
      >
        <h2 style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 12 }}>
          Platform Status
        </h2>
        <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          All systems operational. No critical alerts at this time.
        </p>
      </div>
    </div>
  )
}
