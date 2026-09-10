import type { CSSProperties, KeyboardEvent } from 'react'

/**
 * Testo presente per screen reader ma non visibile (equivalente di `.sr-only`):
 * per le descrizioni collegate con `aria-describedby` a chip e badge il cui
 * dettaglio starebbe altrimenti solo in un `title` (invisibile da tastiera e touch).
 */
export const srOnlyStyle: CSSProperties = {
  position: 'absolute', width: 1, height: 1, padding: 0, margin: -1,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
}

/**
 * Equivalente da tastiera di `onClick` per gli elementi che non possono essere
 * un `<button>` (righe di tabella, card con contenuto interattivo annidato…).
 *
 * Uso: `<tr role="button" tabIndex={0} onClick={open} onKeyDown={keyActivate(open)}>`.
 * Enter e Spazio attivano l'handler; lo Spazio non fa scorrere la pagina.
 *
 * Regola del design system: prima di ricorrere a questo helper valutare se
 * l'elemento può semplicemente diventare un `<button type="button">`.
 */
export function keyActivate<T extends Element = Element>(
  handler: (e: KeyboardEvent<T>) => void,
): (e: KeyboardEvent<T>) => void {
  return (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    if (e.target !== e.currentTarget) return // non intercettare Enter/Spazio dei controlli annidati
    e.preventDefault()
    handler(e)
  }
}
