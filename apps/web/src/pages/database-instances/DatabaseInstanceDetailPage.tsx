import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { StatusBadge } from '@/components/StatusBadge'
import { CountBadge } from '@/components/ui/CountBadge'
import { GET_DATABASE_INSTANCE } from '@/graphql/queries'

interface CIRef { id: string; name: string; type: string; status: string | null; environment: string | null }
interface Team { id: string; name: string }
interface DBInstanceDetail {
  id: string; name: string; type: string; status: string | null; environment: string | null
  description: string | null; createdAt: string; updatedAt: string | null; notes: string | null
  ipAddress: string | null; port: string | null; vendor: string | null; dbVersion: string | null
  ownerGroup: Team | null; supportGroup: Team | null; dependencies: CIRef[]; dependents: CIRef[]
}

function ciPath(id: string, type: string): string {
  switch (type) {
    case 'application': return `/applications/${id}`
    case 'database': return `/databases/${id}`
    case 'database_instance': return `/database-instances/${id}`
    case 'server': return `/servers/${id}`
    case 'certificate': return `/certificates/${id}`
    default: return `/cmdb/${id}`
  }
}

const InfoField = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div style={{ fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{children}</div>
  </div>
)

function CIRow({ ci, onClick }: { ci: CIRef; onClick?: () => void }) {
  return (
    <div onClick={onClick} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0', borderBottom: '1px solid #f1f3f9', cursor: onClick ? 'pointer' : 'default' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#0f1629' }}>{ci.name}</div>
        <div style={{ fontSize: 12, color: '#8892a4', textTransform: 'capitalize' }}>{ci.type.replace(/_/g, ' ')} {ci.environment ? `· ${ci.environment}` : ''}</div>
      </div>
      {ci.status && <StatusBadge value={ci.status} />}
    </div>
  )
}

export function DatabaseInstanceDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [depsOpen, setDepsOpen] = useState(false)
  const [depentsOpen, setDepentsOpen] = useState(false)

  const { data, loading } = useQuery<{ databaseInstance: DBInstanceDetail | null }>(GET_DATABASE_INSTANCE, { variables: { id }, skip: !id })

  if (loading) return <div style={{ padding: 40, color: '#8892a4', fontSize: 14 }}>Loading…</div>

  const dbi = data?.databaseInstance
  if (!dbi) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
        <p style={{ color: '#8892a4', fontSize: 14 }}>DB Instance non trovata.</p>
        <button onClick={() => navigate('/database-instances')} style={{ color: '#4f46e5', background: 'none', border: 'none', fontSize: 14, cursor: 'pointer' }}>← Torna alle DB Instance</button>
      </div>
    )
  }

  return (
    <div>
      <button onClick={() => navigate('/database-instances')} style={{ display: 'inline-flex', gap: 6, color: '#8892a4', background: 'none', border: 'none', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 12 }}>← DB Instance</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <span style={{ fontSize: 24 }}>🗄</span>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>{dbi.name}</h1>
        {dbi.status && <StatusBadge value={dbi.status} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <div>
          {dbi.description && (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 8px' }}>Descrizione</h3>
              <p style={{ fontSize: 14, color: '#374151', margin: 0 }}>{dbi.description}</p>
            </div>
          )}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>Info Tecniche</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
              {dbi.ipAddress && <InfoField label="IP Address">{dbi.ipAddress}</InfoField>}
              {dbi.port      && <InfoField label="Port">{dbi.port}</InfoField>}
              {dbi.vendor    && <InfoField label="Vendor">{dbi.vendor}</InfoField>}
              {dbi.dbVersion && <InfoField label="DB Version">{dbi.dbVersion}</InfoField>}
              {dbi.notes     && <div style={{ gridColumn: '1 / -1' }}><InfoField label="Note">{dbi.notes}</InfoField></div>}
            </div>
          </div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, marginBottom: 16 }}>
            <div onClick={() => setDepsOpen(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>Dipendenze <CountBadge count={dbi.dependencies.length} /></h3>
              {depsOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
            </div>
            {depsOpen && <div style={{ marginTop: 12 }}>{dbi.dependencies.length === 0 ? <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessuna dipendenza.</p> : dbi.dependencies.map(d => <CIRow key={d.id} ci={d} onClick={() => navigate(ciPath(d.id, d.type))} />)}</div>}
          </div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 20, marginBottom: 16 }}>
            <div onClick={() => setDepentsOpen(v => !v)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}>
              <h3 style={{ fontSize: 14, fontWeight: 600, color: '#0f1629', margin: 0, display: 'flex', alignItems: 'center' }}>Dipendenti <CountBadge count={dbi.dependents.length} /></h3>
              {depentsOpen ? <ChevronDown size={16} color="#8892a4" /> : <ChevronRight size={16} color="#8892a4" />}
            </div>
            {depentsOpen && <div style={{ marginTop: 12 }}>{dbi.dependents.length === 0 ? <p style={{ fontSize: 13, color: '#8892a4', margin: 0 }}>Nessun dipendente.</p> : dbi.dependents.map(d => <CIRow key={d.id} ci={d} onClick={() => navigate(ciPath(d.id, d.type))} />)}</div>}
          </div>
        </div>
        <div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px' }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>Dettagli</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <InfoField label="ID"><span style={{ fontFamily: 'DM Mono, monospace', fontSize: 11 }}>{dbi.id}</span></InfoField>
              {dbi.environment && <InfoField label="Environment"><span style={{ textTransform: 'capitalize' }}>{dbi.environment}</span></InfoField>}
              {dbi.status      && <InfoField label="Status"><StatusBadge value={dbi.status} /></InfoField>}
              <InfoField label="Owner Group">{dbi.ownerGroup ? <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#eef2ff', fontSize: 12, fontWeight: 500, color: '#4f46e5' }}>{dbi.ownerGroup.name}</span> : <span style={{ color: '#c4cad4' }}>—</span>}</InfoField>
              <InfoField label="Support Group">{dbi.supportGroup ? <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#ecfdf5', fontSize: 12, fontWeight: 500, color: '#059669' }}>{dbi.supportGroup.name}</span> : <span style={{ color: '#c4cad4' }}>—</span>}</InfoField>
              <InfoField label="Creato">{new Date(dbi.createdAt).toLocaleDateString('it-IT')}</InfoField>
              {dbi.updatedAt && <InfoField label="Aggiornato">{new Date(dbi.updatedAt).toLocaleDateString('it-IT')}</InfoField>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
