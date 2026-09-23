/**
 * IL MODALE DEL COSTRUTTORE: uno, e con le sue lezioni dentro (18 set 2026).
 *
 * Era scritto in linea nel pannello, e ci sono voluti tre tentativi per farlo
 * stare al centro. Le tre cose che non si vedono leggendo il codice:
 *
 *  1. STA IN UN PORTAL attaccato al `body`. Scritto dentro la pagina era
 *     l'ultimo figlio della griglia a due colonne, e si prendeva la regola
 *     `max-height: 42vh` pensata per la palette impilata: il velo diventava
 *     alto 202px su una finestra da 482, quindi il riquadro era tagliato.
 *     `position: fixed` non salva da un tetto messo sull'elemento stesso.
 *  2. SI CENTRA CON `margin: auto`, non con `align-items: center`: quando il
 *     riquadro è più alto dello schermo i margini automatici non assorbono
 *     niente e si scorre dall'alto, mentre `center` taglierebbe via
 *     l'intestazione — cioè il titolo e la croce per chiudere.
 *  3. IL TETTO È `100%`, non `100dvh`: il velo è già grande quanto la finestra
 *     meno il suo margine, mentre `dvh` può raccontare un'altra storia (le
 *     barre di iOS, uno schermo emulato) e allora il riquadro esce di sotto.
 *     Dentro scorre solo il CORPO.
 *
 * THE KEYBOARD (tour of 23 Sep 2026). It declares `aria-modal`, and it keeps
 * that promise the way `Modal` does, through the same hook: the focus moves
 * inside when it opens, Tab and Shift+Tab cycle inside it, Escape closes it,
 * and on closing the focus goes back where it was. Before, the focus stayed on
 * the canvas behind the veil: whoever opened the properties of a field from
 * the keyboard kept tabbing through the page behind, and reached the dialog
 * last. Escape is heard on the document, not on the panel: the focus is
 * usually in a text box, and a handler on the panel would catch it by chance.
 */
import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { alpha, colors } from '@/lib/tokens'
import { useDialogFocus } from '@/hooks/useDialogFocus'

export function ModaleCentrato({ titolo, sottotitolo, largo, onChiudi, children }: {
  titolo: string
  sottotitolo?: string
  /** La larghezza del riquadro: le proprietà stanno strette, un editor no. */
  largo?: number
  onChiudi: () => void
  children: React.ReactNode
}) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)

  // Mounted means open: whoever shows this modal renders it only while it is.
  useDialogFocus(dialogRef, true, onChiudi)

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={titolo}
      style={{
        position: 'fixed', inset: 0, zIndex: 100, background: alpha.scrim,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: 'clamp(12px, 3vh, 32px) 16px', overflowY: 'auto',
      }}
    >
      <div style={{
        background: colors.white, borderRadius: 12, padding: 20,
        width: largo ?? 680, maxWidth: '100%', margin: 'auto',
        display: 'flex', flexDirection: 'column', maxHeight: '100%',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <strong style={{ fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>{titolo}</strong>
          <button type="button" onClick={onChiudi} aria-label={t('common.cancel')}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-slate-light)' }}>
            <X size={16} />
          </button>
        </div>
        {sottotitolo !== undefined && sottotitolo !== '' && (
          <p style={{ margin: '4px 0 0', fontSize: 'var(--font-size-table)', color: 'var(--color-slate)' }}>{sottotitolo}</p>
        )}
        {/* `minHeight: 0` perché senza, un figlio flex non si lascia
            rimpicciolire sotto il suo contenuto e lo scorrimento non parte. */}
        <div style={{ overflowY: 'auto', minHeight: 0, flex: 1, marginTop: 12 }}>
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
