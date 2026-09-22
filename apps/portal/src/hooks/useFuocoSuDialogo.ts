import { useEffect, useRef } from 'react'

/**
 * IL FUOCO SU UN DIALOGO, UNA VOLTA SOLA ALL'APERTURA (22 set 2026).
 *
 * Nasce da un difetto vero. Il dialogo del catalogo prendeva il fuoco con una
 * ref in linea — `ref={(el) => { el?.focus() }}` — e una funzione nuova a ogni
 * render vuol dire che React la richiama a ogni render: il fuoco tornava sul
 * dialogo A OGNI TASTO. Scrivendo nei «Dettagli» restava la prima lettera e le
 * altre finivano nel vuoto, e lo stesso in ogni campo del modulo. Dal portale,
 * una richiesta non si poteva scrivere.
 *
 * Sta in un hook e non nella pagina perché e' una regola, non un dettaglio di
 * quella pagina: il prossimo dialogo la trova già fatta.
 *
 * `chiave` e' quello che identifica il dialogo aperto (l'id della voce):
 * cambiandola il fuoco si sposta sul dialogo nuovo, e restando uguale non si
 * tocca più niente.
 */
export function useFuocoSuDialogo(chiave: string | null | undefined) {
  const dialogo = useRef<HTMLDivElement | null>(null)
  useEffect(() => { dialogo.current?.focus() }, [chiave])
  return dialogo
}
