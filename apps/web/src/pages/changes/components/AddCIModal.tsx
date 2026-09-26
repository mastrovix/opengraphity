/**
 * Search-and-add modal: pick a CI (with owner/support groups) and add it
 * to the change. The caller re-fetches the affected/impacted CI lists on
 * success.
 */
import { SearchBox } from '@/components/ui/SearchBox'
import { Pill } from '@/components/ui/Pill'
import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Modal } from '@/components/Modal'
import { GET_ALL_CIS } from '@/graphql/queries'
import { useTicketCIExclusions } from '@/hooks/useTicketCIExclusions'
import { ADD_CI_TO_CHANGE } from '@/graphql/mutations'
import { colors } from '@/lib/tokens'
import { showError } from '@/lib/showError'
import { useCILabels } from '@/hooks/useCILabels'

export function AddCIModal({ changeId, existingCIIds, onClose, refetchAffected, refetchImpacted, refetchAudit }: {
  changeId: string
  existingCIIds: Set<string>
  onClose: () => void
  refetchAffected: () => Promise<unknown>
  refetchImpacted: () => Promise<unknown>
  refetchAudit:    () => Promise<unknown>
}) {
  const ciLabels = useCILabels()
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  // CM-8: i tipi di CI esclusi per le change non si propongono (l'API li rifiuta comunque).
  const { excluded: excludedCITypes } = useTicketCIExclusions('change')
  const { data: ciData } = useQuery<{ allCIs: { items: Array<{ id: string; name: string; type: string | null; environment: string | null; ownerGroup: { id: string; name: string } | null; supportGroup: { id: string; name: string } | null }> } }>(
    GET_ALL_CIS, { variables: { search, limit: 20, excludeCiTypes: excludedCITypes }, skip: search.length < 2 || excludedCITypes === undefined, fetchPolicy: 'network-only' },
  )
  const [addCI, { loading }] = useMutation(ADD_CI_TO_CHANGE, {
    onCompleted: () => {
      void refetchImpacted()
      void refetchAffected()
      void refetchAudit()
      toast.success(t('toast.change.ciAdded'))
    },
    onError: (e) => showError(e),
  })
  const results = ciData?.allCIs?.items ?? []

  return (
    <Modal open onClose={onClose} title={t('pages.addCI.title')} width={560}>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- the search of a dialog the user just opened: the focus goes there */}
        <SearchBox value={search} onChange={setSearch} ariaLabel={t('pages.createChange.searchCI')} placeholder={t('pages.createChange.searchCI')} autoFocus style={{ marginBottom: 12 }} />
        <div style={{ overflowY: 'auto', maxHeight: 400 }}>
          {search.length < 2 && <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: 0 }}>{t('pages.addCI.typeTwoChars')}</p>}
          {search.length >= 2 && results.length === 0 && <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)', margin: 0 }}>{t('pages.addCI.noCIFound')}</p>}
          {results.map(ci => {
            const alreadyAdded = existingCIIds.has(ci.id)
            const hasOwner = !!ci.ownerGroup
            const hasSupport = !!ci.supportGroup
            const canAdd = !alreadyAdded && hasOwner && hasSupport
            return (
              <div key={ci.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--color-border-light)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, color: 'var(--color-slate-dark)', fontSize: 'var(--font-size-body)' }}>{ci.name}</div>
                  <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
                    {ci.type && <Pill bg={colors.slateBg} color="var(--color-slate)" radius={3} style={{ fontSize: 'var(--font-size-label)' }}>{ciLabels.typeLabel(ci.type)}</Pill>}
                    {ci.environment && <Pill bg={colors.slateBg} color="var(--color-slate)" radius={3} style={{ fontSize: 'var(--font-size-label)' }}>{ciLabels.environmentLabel(ci.environment)}</Pill>}
                  </div>
                  <div style={{ display: 'flex', gap: 12, marginTop: 3, fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)' }}>
                    <span><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: hasOwner ? 'var(--color-success)' : 'var(--color-danger)', marginRight: 4, verticalAlign: 'middle' }} />{t('pages.addCIModal.owner', { name: ci.ownerGroup?.name ?? '—' })}</span>
                    <span><span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', backgroundColor: hasSupport ? 'var(--color-success)' : 'var(--color-danger)', marginRight: 4, verticalAlign: 'middle' }} />{t('pages.addCIModal.support', { name: ci.supportGroup?.name ?? '—' })}</span>
                  </div>
                </div>
                {alreadyAdded ? (
                  <span style={{ fontSize: 'var(--font-size-label)', color: 'var(--color-slate-light)', flexShrink: 0 }}>{t('pages.addCI.alreadyAdded')}</span>
                ) : (
                  <button
                    type="button" disabled={!canAdd || loading}
                    title={!canAdd ? t('pages.addCI.groupsRequired') : undefined}
                    onClick={() => void addCI({ variables: { changeId, ciId: ci.id } })}
                    style={{
                      padding: '4px 10px', borderRadius: 6, border: 'none', fontSize: 'var(--font-size-label)', fontWeight: 600, flexShrink: 0,
                      backgroundColor: canAdd ? 'var(--color-brand)' : colors.border, color: canAdd ? colors.white : 'var(--color-slate-light)',
                      cursor: canAdd ? 'pointer' : 'not-allowed',
                    }}
                  >
                    {t('common.add')}
                  </button>
                )}
              </div>
            )
          })}
        </div>
    </Modal>
  )
}
