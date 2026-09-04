import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useNavigate } from 'react-router-dom'
import { GET_SERVICE_CATALOG } from '@/graphql/queries'
import { CREATE_SERVICE_REQUEST } from '@/graphql/mutations'
import { notifyError } from '@/lib/notify'

interface CatalogItem {
  id: string
  name: string
  description: string | null
  category: string | null
  requiresApproval: boolean
}

export function ServiceCatalogPage() {
  const navigate = useNavigate()
  const { data, loading, error } = useQuery<{ serviceCatalogItems: CatalogItem[] }>(GET_SERVICE_CATALOG)
  const [openItem, setOpenItem] = useState<CatalogItem | null>(null)
  const [details, setDetails] = useState('')

  const [createRequest, { loading: submitting }] = useMutation<{ createServiceRequest: { id: string; number: string } }>(
    CREATE_SERVICE_REQUEST,
    {
      onCompleted: (d) => { setOpenItem(null); setDetails(''); navigate(`/tickets`, { state: { created: d.createServiceRequest.number } }) },
      onError: (e) => notifyError(e.message),
    },
  )

  if (loading) return <div style={{ padding: 24, color: '#64748B' }}>Caricamento…</div>
  if (error) return (
    <div style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      <div role="alert" style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b', padding: 12, borderRadius: 8 }}>
        Errore nel caricamento del catalogo: {error.message}
      </div>
    </div>
  )

  const items = data?.serviceCatalogItems ?? []
  const byCategory = items.reduce<Record<string, CatalogItem[]>>((acc, it) => {
    const c = it.category ?? 'Altro'
    ;(acc[c] ??= []).push(it)
    return acc
  }, {})

  function submit() {
    if (!openItem) return
    void createRequest({ variables: { input: {
      title: openItem.name,
      description: details.trim() || null,
      priority: 'medium',
      catalogItemId: openItem.id,
    } } })
  }

  return (
    <div style={{ maxWidth: 820, margin: '0 auto', padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 600, color: '#0F172A', marginBottom: 6 }}>Catalogo servizi</h1>
      <p style={{ fontSize: 13, color: '#64748B', marginBottom: 24 }}>Richiedi un servizio dal catalogo. Alcune richieste passano da un'approvazione.</p>

      {items.length === 0 && <p style={{ color: '#64748B' }}>Nessun servizio disponibile.</p>}

      {Object.entries(byCategory).map(([cat, list]) => (
        <div key={cat} style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 13, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>{cat}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12 }}>
            {list.map(it => (
              <button key={it.id} onClick={() => { setOpenItem(it); setDetails('') }}
                style={{ textAlign: 'left', background: '#fff', border: '1px solid #e5e7eb', borderRadius: 10, padding: 16, cursor: 'pointer' }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: '#0F172A', marginBottom: 4 }}>{it.name}</div>
                {it.description && <div style={{ fontSize: 12, color: '#64748B', lineHeight: 1.5 }}>{it.description}</div>}
                {it.requiresApproval && <div style={{ marginTop: 8, fontSize: 11, color: '#b45309' }}>Richiede approvazione</div>}
              </button>
            ))}
          </div>
        </div>
      ))}

      {openItem && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 }}
          onClick={() => setOpenItem(null)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 460, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ fontSize: 17, fontWeight: 600, color: '#0F172A', marginBottom: 4 }}>{openItem.name}</h3>
            {openItem.requiresApproval && <p style={{ fontSize: 12, color: '#b45309', marginBottom: 12 }}>Questa richiesta sarà sottoposta ad approvazione.</p>}
            <label style={{ fontSize: 12, fontWeight: 600, color: '#475569', display: 'block', marginBottom: 6 }}>Dettagli (opzionale)</label>
            <textarea value={details} onChange={e => setDetails(e.target.value)} rows={4}
              placeholder="Aggiungi dettagli utili per l'evasione…"
              style={{ width: '100%', border: '1px solid #e5e7eb', borderRadius: 8, padding: 10, fontSize: 13, resize: 'vertical', boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
              <button onClick={() => setOpenItem(null)} style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #e5e7eb', background: '#fff', cursor: 'pointer', fontSize: 13 }}>Annulla</button>
              <button onClick={submit} disabled={submitting} style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#0EA5E9', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600, opacity: submitting ? 0.6 : 1 }}>
                {submitting ? 'Invio…' : 'Invia richiesta'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
