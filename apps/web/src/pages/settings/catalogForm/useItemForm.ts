/**
 * THE FORM OF THE CHOSEN ITEM: the one stored on the server, and the draft the
 * canvas builds on it.
 *
 * The panel chooses the item; this hook reads that item's stored form, keeps
 * the draft, knows whether the draft has unpublished changes and whether it
 * belongs to the chosen item at all, retries a form that could not be read,
 * and publishes. They are one piece because they answer one question — which
 * form is on the canvas, and may it be written — and the worst bug found here
 * on 23 Sep 2026 came from two of them disagreeing: a draft published onto an
 * item it did not belong to.
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { CATALOG_FORM_VERSION, emptyCatalogForm, type CatalogFormDefinition } from '@opengraphity/types'
import { GET_CATALOG_FORM } from '@/graphql/queries'
import { SAVE_CATALOG_FORM } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import { useConfirm } from '@/hooks/useConfirm'

/** The stored form of an item, as the API sends it: `definition` is a JSON string. */
export interface StoredForm { itemId: string; itemName: string; revision: number; definition: string }

/** `itemId` is `''` while no item is chosen; `itemName` is what the publication asks about. */
export function useItemForm(itemId: string, itemName: string) {
  const { t } = useTranslation()
  const confirm = useConfirm()

  const { data, error, refetch } = useQuery<{ catalogForm: StoredForm }>(
    GET_CATALOG_FORM, { variables: { itemId }, skip: !itemId, fetchPolicy: 'network-only' },
  )

  const [draft, setDraft] = useState<CatalogFormDefinition>(emptyCatalogForm())
  const [touched, setTouched] = useState(false)
  /**
   * THE ITEM THE DRAFT BELONGS TO (tour of 23 Sep 2026): the one whose stored
   * form it was loaded from. After a switch the previous item's draft stayed
   * on the canvas, still marked as unpublished, until the new form arrived —
   * and if that form failed to load, «Save and publish» wrote the previous
   * item's draft onto the one just chosen. Now nothing of the chosen item is
   * shown or published until its own form is in hand.
   */
  const [draftItemId, setDraftItemId] = useState<string | null>(null)
  const ready = itemId !== '' && draftItemId === itemId
  const [retrying, setRetrying] = useState(false)
  const [save, { loading: publishing }] = useMutation(SAVE_CATALOG_FORM, { onError: (e) => showError(e) })

  useEffect(() => {
    if (!data?.catalogForm) return
    try { setDraft(JSON.parse(data.catalogForm.definition) as CatalogFormDefinition) }
    catch { setDraft(emptyCatalogForm()) }
    setTouched(false)
    setDraftItemId(data.catalogForm.itemId)
  }, [data])

  /** «Retry» on a form that could not be loaded: while it runs, the canvas says it is loading. */
  const retry = async () => {
    setRetrying(true)
    try {
      await refetch()
    } catch {
      // Failed again: the error link has said so, and the message in place comes back.
    } finally { setRetrying(false) }
  }

  /** Every change to the draft goes through here, and marks it as not published. Stable, so an effect can use it. */
  const edit = useCallback((change: (d: CatalogFormDefinition) => CatalogFormDefinition) => {
    setDraft((d) => change(d))
    setTouched(true)
  }, [])

  /** Whether the draft may go: asked only when it has changes not published yet. */
  const askBeforeDiscarding = async (): Promise<boolean> => {
    if (!touched) return true
    return await confirm({
      title: t('pages.catalogForms.builder.discardTitle'),
      body:  t('pages.catalogForms.builder.discardBody'),
      danger: true,
    })
  }

  /** The draft goes with the item it belonged to: another item's form is not in hand yet. */
  const discard = () => {
    setDraft(emptyCatalogForm())
    setTouched(false)
    setDraftItemId(null)
  }

  const publish = async () => {
    // Only the chosen item's own form is published (the button is off otherwise too).
    if (!ready) return
    /*
     * LA CONFERMA NOMINA LA VOCE, e per questo esiste: pubblicare scrive sul
     * modulo di UNA voce, e il 18 set 2026 un campo è finito su quella
     * sbagliata senza che niente lo dicesse. Non è una conferma di cortesia —
     * è l'ultimo punto in cui si legge il nome prima che il modulo cambi.
     */
    const sure = await confirm({
      title: t('pages.catalogForms.builder.publishConfirmTitle'),
      body:  t('pages.catalogForms.builder.publishConfirmBody', { item: itemName }),
    })
    if (!sure) return
    let r: Awaited<ReturnType<typeof save>>
    try {
      r = await save({ variables: { itemId, definition: JSON.stringify({ ...draft, version: CATALOG_FORM_VERSION }) } })
    } catch {
      // The mutation's onError has already told the user; the draft stays marked as not published.
      return
    }
    toast.success(t('pages.catalogForms.builder.published', { revision: (r.data as { saveCatalogForm: { revision: number } }).saveCatalogForm.revision }))
    setTouched(false)
    void refetch()
  }

  return {
    /** The stored form as last read: its revision is what is published. */
    storedForm: data?.catalogForm,
    loadError: error,
    draft, touched, ready, retrying, publishing,
    retry, edit, askBeforeDiscarding, discard, publish,
  }
}
