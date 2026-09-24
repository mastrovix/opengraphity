/**
 * One CMDB chain, drawn and changed as a whole: its name, its kind
 * (application, infrastructure, mixed — which chain families its types may
 * have), the drawing, and the panel of the type chosen in it. Nothing is
 * written until «Save»: the API validates the whole tree (families,
 * metamodel) and its refusal is shown as it comes, naming what is wrong.
 * Who cannot change the metamodel sees the chain and cannot change it.
 */
import { useState } from 'react'
import { useMutation } from '@apollo/client/react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/Button'
import { ConfirmModal } from '@/components/ui/ConfirmModal'
import { Input, Select } from '@/components/ui/FormControls'
import { CREATE_CMDB_CHAIN, DELETE_CMDB_CHAIN, UPDATE_CMDB_CHAIN } from '@/graphql/mutations'
import { useMetamodel } from '@/contexts/MetamodelContext'
import { useCILabels } from '@/hooks/useCILabels'
import { showError } from '@/lib/showError'
import { colors } from '@/lib/tokens'
import { ChainCanvas } from './ChainCanvas'
import { ChainNodePanel } from './ChainNodePanel'
import { addLink, CHAIN_KINDS, isChainKind, toChainInput, withoutSubtree, type ChainDraft, type CmdbChain } from './chainModel'

/** The reads a saved or removed chain changes: the list and the health numbers. */
const REFRESH = ['GetCmdbChains', 'GetCmdbHealth']

interface Props {
  initial: ChainDraft
  canEdit: boolean
  /** After a save (the chain's id) or a removal (null). */
  onDone: (id: string | null) => void
  onCancel: () => void
}

export function ChainEditor({ initial, canEdit, onDone, onCancel }: Props) {
  const { t } = useTranslation()
  const { ciTypes } = useMetamodel()
  const ciLabels = useCILabels()
  const [draft, setDraft] = useState<ChainDraft>(initial)
  const [chosenId, setChosenId] = useState<string | null>(initial.nodes.find((n) => !n.parentId)?.id ?? null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [create, { loading: creating }] = useMutation<{ createCmdbChain: CmdbChain }>(CREATE_CMDB_CHAIN, { refetchQueries: REFRESH })
  const [update, { loading: updating }] = useMutation<{ updateCmdbChain: CmdbChain }>(UPDATE_CMDB_CHAIN, { refetchQueries: REFRESH })
  const [remove, { loading: removing }] = useMutation(DELETE_CMDB_CHAIN, { refetchQueries: REFRESH })
  const root = draft.nodes.find((n) => !n.parentId)
  const chosen = draft.nodes.find((n) => n.id === chosenId)
  const dirty = JSON.stringify(toChainInput(draft)) !== JSON.stringify(toChainInput(initial))
  const saving = creating || updating

  const save = async () => {
    try {
      const input = toChainInput(draft)
      const id = draft.id
        ? (await update({ variables: { id: draft.id, input } })).data?.updateCmdbChain.id
        : (await create({ variables: { input } })).data?.createCmdbChain.id
      toast.success(t('pages.cmdbHealth.chains.saved'))
      onDone(id ?? null)
    } catch (e) {
      showError(e)
    }
  }
  const destroy = async () => {
    if (!draft.id) return
    try {
      await remove({ variables: { id: draft.id } })
      toast.success(t('pages.cmdbHealth.chains.deleted'))
      setConfirmDelete(false)
      onDone(null)
    } catch (e) {
      showError(e)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 220px', fontSize: 'var(--font-size-label)', color: colors.slate }}>
          {t('pages.cmdbHealth.chains.name')}
          <Input value={draft.name} disabled={!canEdit} maxLength={80} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--font-size-label)', color: colors.slate }}>
          {t('pages.cmdbHealth.chains.kind')}
          <Select value={draft.kind} disabled={!canEdit} onChange={(e) => { if (isChainKind(e.target.value)) setDraft({ ...draft, kind: e.target.value }) }}>
            {CHAIN_KINDS.map((k) => <option key={k} value={k}>{t(`pages.cmdbHealth.chains.kinds.${k}`)}</option>)}
          </Select>
        </label>
        {/* The root can change only while nothing hangs below it: the links below depend on it. */}
        {root && draft.nodes.length === 1 && canEdit && (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 'var(--font-size-label)', color: colors.slate }}>
            {t('pages.cmdbHealth.chains.rootType')}
            <Select value={root.ciType} onChange={(e) => setDraft({ ...draft, nodes: [{ ...root, ciType: e.target.value }] })}>
              {ciTypes.filter((ct) => ct.chainFamilies.length > 0).map((ct) => <option key={ct.name} value={ct.name}>{ciLabels.typeLabel(ct.name)}</option>)}
            </Select>
          </label>
        )}
        {canEdit && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => save()} disabled={!dirty || saving}>{t('pages.cmdbHealth.chains.save')}</Button>
            <Button variant="secondary" onClick={onCancel}>{t('pages.cmdbHealth.chains.cancel')}</Button>
            {draft.id && <Button variant="danger" onClick={() => setConfirmDelete(true)}>{t('pages.cmdbHealth.chains.delete')}</Button>}
          </div>
        )}
      </div>
      <p style={{ margin: 0, fontSize: 'var(--font-size-label)', color: colors.slateLight }}>{t(`pages.cmdbHealth.chains.kindHint.${draft.kind}`)}</p>
      {!canEdit && <p style={{ margin: 0, fontSize: 'var(--font-size-body)', color: colors.slate }}>{t('pages.cmdbHealth.chains.readOnly')}</p>}

      {/* The drawing and the panel side by side; on a narrow screen the panel goes below. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: '2 1 480px', minWidth: 0 }}>
          <ChainCanvas nodes={draft.nodes} chosenId={chosenId} onChoose={setChosenId} />
        </div>
        {chosen ? (
          <div style={{ flex: '1 1 280px', minWidth: 0 }}><ChainNodePanel
            key={chosen.id} node={chosen} nodes={draft.nodes} kind={draft.kind} canEdit={canEdit}
            onRemove={() => { setDraft({ ...draft, nodes: withoutSubtree(draft.nodes, chosen.id) }); setChosenId(chosen.parentId) }}
            onAdd={(option) => setDraft({ ...draft, nodes: addLink(draft.nodes, chosen.id, option) })}
          /></div>
        ) : (
          <p style={{ flex: '1 1 280px', margin: 0, fontSize: 'var(--font-size-body)', color: colors.slateLight }}>{t('pages.cmdbHealth.chains.choose')}</p>
        )}
      </div>

      <ConfirmModal
        open={confirmDelete} danger loading={removing}
        title={t('pages.cmdbHealth.chains.deleteTitle', { name: draft.name })}
        body={t('pages.cmdbHealth.chains.deleteBody')}
        confirmLabel={t('pages.cmdbHealth.chains.delete')}
        onConfirm={() => void destroy()} onCancel={() => setConfirmDelete(false)}
      />
    </div>
  )
}
