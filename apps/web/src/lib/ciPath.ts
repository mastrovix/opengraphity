export interface CIPathRef {
  id: string
  type: string | null | undefined
}

/**
 * L'indirizzo della pagina di un CI.
 *
 * Senza tipo si passa da `/cis/<id>`, la rotta che RISOLVE il tipo dal grafo
 * (`CIByIdRedirect`): un ripiego su «application» mandava a `/ci/application/
 * <id>`, cioè a un 404 sul CI sbagliato, e chi guardava pensava che il CI non
 * esistesse più (revisione totale · F-32).
 */
export function ciPath(ci: CIPathRef): string {
  const type = typeof ci.type === 'string' ? ci.type.trim() : ''
  return type === '' ? `/cis/${ci.id}` : `/ci/${type.toLowerCase()}/${ci.id}`
}
