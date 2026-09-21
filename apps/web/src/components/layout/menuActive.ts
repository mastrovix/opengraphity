/**
 * QUALE VOCE DEL MENU È ACCESA: una sola, la più specifica.
 *
 * Ogni voce decideva da sé con «il percorso comincia con il mio»: su
 * /reports/sla si accendevano insieme «SLA Report» e «AI Analysis» (/reports),
 * perché /reports/sla comincia con /reports. Qui la scelta si fa guardando
 * tutte le voci insieme: vince quella il cui percorso copre la pagina ed è il
 * più lungo. Una pagina interna senza voce propria (/incidents/123) accende la
 * voce da cui discende (/incidents); una pagina che non discende da nessuna
 * voce non accende niente.
 */
export function voceAttiva(pathname: string, percorsi: readonly string[]): string | null {
  let migliore: string | null = null
  for (const to of percorsi) {
    const copre = pathname === to || pathname.startsWith(`${to}/`)
    if (copre && (migliore === null || to.length > migliore.length)) migliore = to
  }
  return migliore
}
