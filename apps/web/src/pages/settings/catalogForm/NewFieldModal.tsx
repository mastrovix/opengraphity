/**
 * IL MODALE DEL CAMPO NUOVO.
 *
 * Dentro c'è l'EDITOR DELLA LIBRERIA, lo stesso: etichette, aiuto,
 * obbligatorio, colonna nelle liste, il vocabolario di una tendina, le
 * colonne di una tabella, la formula e lo script di validazione. Un editor
 * ridotto avrebbe voluto dire che certe cose si possono impostare solo
 * sapendo che esiste un'altra scheda — ed è esattamente il difetto da cui
 * è nata la palette dei tipi.
 *
 * Un modale e non più un riquadro in linea: le caselle sono tante (compreso
 * il JavaScript), e infilarle dentro la sezione spingeva il modulo in fondo
 * allo schermo proprio mentre lo si sta guardando.
 *
 * The modal creates the field in the library and hands its name back; WHERE
 * it goes on the form (the section and the place it was dropped on) is the
 * panel's business.
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation } from '@apollo/client/react'
import { toast } from 'sonner'
import { nomeDaEtichetta } from '@opengraphity/types'
import { CREATE_FORM_FIELD } from '@/graphql/mutations'
import { showError } from '@/lib/showError'
import type { FormFieldRow } from './FieldLibraryPanel'
import { FieldEditor, inputDaBozza, type Bozza } from './FieldEditor'
import { ModaleCentrato } from './ModaleCentrato'

export function NewFieldModal({ draft, onDraft, sectionName, library, vocabularies, reloadLibrary, onCreated, onClose }: {
  /** The field being written: its type is the one taken from the palette. */
  draft: Bozza
  onDraft: (b: Bozza) => void
  /** The section it will go into, as the canvas names it. */
  sectionName: string
  library: readonly FormFieldRow[]
  vocabularies: readonly { name: string; label: string }[]
  /** Reads the library again; `false` when it could not be (see `useFieldLibrary`). */
  reloadLibrary: () => Promise<boolean>
  /** The field exists in the library, by this name: the panel puts it on the form. */
  onCreated: (name: string) => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [creating, setCreating] = useState(false)
  const [createField] = useMutation(CREATE_FORM_FIELD, { onError: (e) => showError(e) })

  /* `Escape` chiude il modale. Sta su `window` e non sul riquadro: il fuoco è
     dentro una casella dell'editor, e un gestore sul contenitore lo prende
     solo per caso — oltre a essere un ascoltatore su un elemento che non è
     interattivo, che è quello che dice il lint. */
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => { window.removeEventListener('keydown', esc) }
  }, [onClose])

  /**
   * CREA IL CAMPO E LO METTE DOVE È CADUTO.
   *
   * Il campo nasce nella LIBRERIA — è condiviso da tutti i moduli, e il suo
   * nome diventa una proprietà del ticket — e solo dopo entra nel modulo. Se
   * la creazione fallisce (nome riservato, libreria piena, vocabolario
   * inesistente) non si tocca la bozza: meglio niente che una voce che punta
   * a un campo che non c'è.
   */
  const create = async () => {
    const common = inputDaBozza(draft, draft.fieldType)
    if (common.label === '') { toast.error(t('pages.catalogForms.library.labelNeeded')); return }
    const name = draft.name.trim() === '' ? nomeDaEtichetta(common.label, library.map((f) => f.name)) : draft.name.trim()
    setCreating(true)
    try {
      await createField({ variables: { input: { ...common, name, fieldType: draft.fieldType } } })
    } catch {
      // The mutation's onError has already told the user; the modal stays OPEN,
      // since whoever just filled ten boxes must fix what is wrong, not start over.
      setCreating(false)
      return
    }
    /*
     * FROM HERE THE FIELD EXISTS. The library is read again BEFORE the item
     * goes into the draft, or the row would show the technical name instead of
     * the label. If that reading fails the field goes on the form all the same
     * and the modal closes: left open, it invited pressing «Create» again for
     * a field that was already created.
     */
    if (!(await reloadLibrary())) toast.error(t('pages.catalogForms.builder.libraryNotRefreshed', { count: 1 }))
    onCreated(name)
    setCreating(false)
  }

  return (
    <ModaleCentrato
      titolo={t('pages.catalogForms.builder.newFieldOfType', { type: t(`pages.catalogForms.fieldType.${draft.fieldType}`) })}
      sottotitolo={t('pages.catalogForms.builder.newFieldInSection', { section: sectionName })}
      onChiudi={onClose}
    >
      {/*
        Dentro c'è l'EDITOR DELLA LIBRERIA, lo stesso: etichette, aiuto,
        obbligatorio, colonna nelle liste, vocabolario, tipi di CI di un
        riferimento, colonne di una tabella, formula e script di validazione.
        Un editor ridotto avrebbe voluto dire che certe cose si impostano solo
        sapendo che esiste un'altra scheda — il difetto da cui è nata la
        palette dei tipi.
      */}
      <FieldEditor
        bozza={draft}
        onBozza={onDraft}
        vocabolari={vocabularies}
        onSalva={create}
        onAnnulla={onClose}
        salvando={creating}
        etichettaSalva={t('pages.catalogForms.builder.createField')}
        nomeDallEtichetta
        nomiPresi={library.map((f) => f.name)}
        campiLeggibili={library.map((f) => ({ name: f.name, label: f.label }))}
      />
    </ModaleCentrato>
  )
}
