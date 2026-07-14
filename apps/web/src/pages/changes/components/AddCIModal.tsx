/**
 * Search-and-add modal: pick a CI (with owner/support groups) and add it
 * to the change. The caller re-fetches the affected/impacted CI lists on
 * success.
 */
import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { Search } from 'lucide-react'
import { Modal } from '@/components/Modal'
import { GET_ALL_CIS } from '@/graphql/queries'
import { ADD_CI_TO_CHANGE } from '@/graphql/mutations'

export function AddCIModal({ changeId, existingCIIds, onClose, refetchAffected, refetchImpacted, refetchAudit }: {
  changeId: string
  existingCIIds: Set<string>
  onClose: () => void
  refetchAffected: () => Promise<unknown>
  refetchImpacted: () => Promise<unknown>
  refetchAudit:    () => Promise<unknown>
}) {
  const [search, setSearch] = useState('')
  const { data: ciData } = useQuery<{ allCIs: { items: Array<{ id: string; name: string; type: string | null; environment: string | null; ownerGroup: { id: string; name: string } | null; supportGroup: { id: string; name: string } | null }> } }>(
    GET_ALL_CIS, { variables: { search, limit: 20 }, skip: search.length < 2, fetchPolicy: 'network-only' },
  )
  const [addCI, { loading }] = useMutation(ADD_CI_TO_CHANGE, {
    onCompleted: () => {
      void refetchImpacted()
      void refetchAffected()
      void refetchAudit()
      toast.success('CI aggiunto')
    },
    onError: (e) => toast.error(e.message),
  })
  const results = ciData?.allCIs?.items ?? []

  return (
    <Modal open onClose={onClose} title="Aggiungi CI al Change" width={560}>
        <div style={{ position: 'relative', marginBottom: 12 }}>
          <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--color-slate-light)' }} />
          <input
            type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Cerca CI per nome..." autoFocus
            style={{ width: '100%', padding: '8px 12px 8px 30px', border: '1px solid #e5e7eb', borderRadius: 6, fontSize: 'var(--font-size-body)', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ overflowY: 'auto', maxHeight: 400 }}>
          {search.length < 2 && <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: 0 }}>Digita almeno 2 caratteri per cercare</p>}
          {search.length >= 2 && results.length === 0 && <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: 0 }}>Nessun CI trovato</p>}
          {results.map(ci => {
            const alreadyAdded = existingCIIds.has(ci.id)
            const hasOwner = !!ci.ownerGroup
            const hasSupport = !!ci.supportGroup
            const canAdd = !alreadyAdded && hasOwner && hasSupport
            return (
              <div key={ci.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid #f3f4f6' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)' }}>{ci.name}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                    {ci.type && <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 4px', borderRadius: 3, backgroundColor: '#f1f5f9', color: 'var(--color-slate)' }}>{ci.type}</span>}
                    {ci.environment && <span style={{ fontSize: 'var(--font-size-label)', padding: '1px 4px', borderRadius: 3, backgroundColor: '#f1f5f9', color: 'var(--color-slate)' }}>{ci.environment}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 3, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                    <span><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: hasOwner ? 'var(--color-success)' : 'var(--color-danger)', marginRight: 4, verticalAlign: 'middle' }} />Owner: {ci.ownerGroup?.name ?? '—'}</span>
                    <span><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: hasSupport ? 'var(--color-success)' : 'var(--color-danger)', marginRight: 4, verticalAlign: 'middle' }} />Support: {ci.supportGroup?.name ?? '—'}</span>
                  </div>
                </div>
                {alreadyAdded ? (
                  <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', flexShrink: 0 }}>Già aggiunto</span>
                ) : (
                  <button
                    type="button" disabled={!canAdd || loading}
                    title={!canAdd ? 'Owner Group e Support Group obbligatori' : undefined}
                    onClick={() => void addCI({ variables: { changeId, ciId: ci.id } })}
                    style={{
                      padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 'var(--font-size-label)', fontWeight: 600, flexShrink: 0,
                      backgroundColor: canAdd ? 'var(--color-brand)' : '#e5e7eb', color: canAdd ? '#fff' : 'var(--color-slate-light)',
                      cursor: canAdd ? 'pointer' : 'not-allowed',
                    }}
                  >
                    Aggiungi
                  </button>
                )}
              </div>
            )
          })}
        </div>
    </Modal>
  )
}
