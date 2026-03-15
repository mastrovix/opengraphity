import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@apollo/client/react'
import { StatusBadge } from '@/components/StatusBadge'
import { GET_CERTIFICATE } from '@/graphql/queries'

interface Team { id: string; name: string }
interface CertificateDetail {
  id: string; name: string; type: string; status: string | null; environment: string | null
  description: string | null; createdAt: string; updatedAt: string | null; notes: string | null
  serialNumber: string | null; expiresAt: string | null; certificateType: string | null
  ownerGroup: Team | null; supportGroup: Team | null
}

const InfoField = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div style={{ fontSize: 11, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
    <div style={{ fontSize: 13, fontWeight: 500, color: '#111827' }}>{children}</div>
  </div>
)

function ExpiryInfo({ expiresAt }: { expiresAt: string | null }) {
  if (!expiresAt) return <span style={{ color: '#c4cad4' }}>—</span>
  const now = new Date()
  const expiry = new Date(expiresAt)
  const diffMs = expiry.getTime() - now.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  let bg = '#ecfdf5', color = '#059669', label = 'Valido'
  if (diffMs < 0) { bg = '#fef2f2'; color = '#dc2626'; label = 'Scaduto' }
  else if (diffDays < 30) { bg = '#fff7ed'; color = '#ea580c'; label = `In scadenza (${diffDays}gg)` }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 100, fontSize: 11, fontWeight: 600, backgroundColor: bg, color }}>{label}</span>
      <span style={{ fontSize: 13 }}>{expiry.toLocaleDateString('it-IT')}</span>
    </div>
  )
}

export function CertificateDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()

  const { data, loading } = useQuery<{ certificate: CertificateDetail | null }>(GET_CERTIFICATE, { variables: { id }, skip: !id })

  if (loading) return <div style={{ padding: 40, color: '#8892a4', fontSize: 14 }}>Loading…</div>

  const cert = data?.certificate
  if (!cert) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: 200, gap: 12 }}>
        <p style={{ color: '#8892a4', fontSize: 14 }}>Certificato non trovato.</p>
        <button onClick={() => navigate('/certificates')} style={{ color: '#4f46e5', background: 'none', border: 'none', fontSize: 14, cursor: 'pointer' }}>← Torna ai Certificati</button>
      </div>
    )
  }

  return (
    <div>
      <button onClick={() => navigate('/certificates')} style={{ display: 'inline-flex', gap: 6, color: '#8892a4', background: 'none', border: 'none', fontSize: 13, cursor: 'pointer', padding: 0, marginBottom: 12 }}>← Certificati</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
        <span style={{ fontSize: 24 }}>🔒</span>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#0f1629', margin: 0 }}>{cert.name}</h1>
        {cert.status && <StatusBadge value={cert.status} />}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 16 }}>
        <div>
          {cert.description && (
            <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
              <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 8px' }}>Descrizione</h3>
              <p style={{ fontSize: 14, color: '#374151', margin: 0 }}>{cert.description}</p>
            </div>
          )}
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px', marginBottom: 16 }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>Info Certificato</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 24px' }}>
              {cert.certificateType && <InfoField label="Tipo">{cert.certificateType}</InfoField>}
              {cert.serialNumber    && <InfoField label="Serial Number"><span style={{ fontFamily: 'DM Mono, monospace', fontSize: 12 }}>{cert.serialNumber}</span></InfoField>}
              <div style={{ gridColumn: '1 / -1' }}>
                <InfoField label="Scadenza"><ExpiryInfo expiresAt={cert.expiresAt} /></InfoField>
              </div>
              {cert.notes && <div style={{ gridColumn: '1 / -1' }}><InfoField label="Note">{cert.notes}</InfoField></div>}
            </div>
          </div>
        </div>
        <div>
          <div style={{ background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: '16px 20px' }}>
            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#8892a4', textTransform: 'uppercase', letterSpacing: '0.04em', margin: '0 0 16px' }}>Dettagli</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <InfoField label="ID"><span style={{ fontFamily: 'DM Mono, monospace', fontSize: 11 }}>{cert.id}</span></InfoField>
              {cert.environment && <InfoField label="Environment"><span style={{ textTransform: 'capitalize' }}>{cert.environment}</span></InfoField>}
              {cert.status      && <InfoField label="Status"><StatusBadge value={cert.status} /></InfoField>}
              <InfoField label="Owner Group">{cert.ownerGroup ? <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#eef2ff', fontSize: 12, fontWeight: 500, color: '#4f46e5' }}>{cert.ownerGroup.name}</span> : <span style={{ color: '#c4cad4' }}>—</span>}</InfoField>
              <InfoField label="Support Group">{cert.supportGroup ? <span style={{ padding: '2px 8px', borderRadius: 100, backgroundColor: '#ecfdf5', fontSize: 12, fontWeight: 500, color: '#059669' }}>{cert.supportGroup.name}</span> : <span style={{ color: '#c4cad4' }}>—</span>}</InfoField>
              <InfoField label="Creato">{new Date(cert.createdAt).toLocaleDateString('it-IT')}</InfoField>
              {cert.updatedAt && <InfoField label="Aggiornato">{new Date(cert.updatedAt).toLocaleDateString('it-IT')}</InfoField>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
