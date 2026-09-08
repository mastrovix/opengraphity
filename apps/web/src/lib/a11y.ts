import type { KeyboardEvent } from 'react'

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
