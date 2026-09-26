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
import { Modal } from '@/components/Modal'

/**
 * Since 26 Sep 2026 (wave 4 of «tutte in fila») this is the app's `Modal`
 * under the builder's name: the lessons above live there now — a portal on the
 * body, the header always in view, only the body scrolling, the keyboard kept
 * inside.
 */
export function ModaleCentrato({ titolo, sottotitolo, largo, onChiudi, children }: {
  titolo: string
  sottotitolo?: string
  /** La larghezza del riquadro: le proprietà stanno strette, un editor no. */
  largo?: number
  onChiudi: () => void
  children: React.ReactNode
}) {
  return (
    <Modal open onClose={onChiudi} title={titolo} subtitle={sottotitolo || undefined} width={largo ?? 680} zIndex={100}>
      {children}
    </Modal>
  )
}
