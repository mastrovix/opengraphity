/**
 * UN ERRORE, UN AVVISO (dopo l'ondata 7 di «Nulla cablato»).
 *
 * Gli errori GraphQL e di rete li mostra già il link degli errori
 * (`lib/apollo.ts` → `@opengraphity/web-core`), tradotti nella lingua di chi
 * guarda. Una pagina che li mostrava di nuovo nel suo `onError` faceva
 * comparire due avvisi per lo stesso errore. `showError` mostra solo quello
 * che il link non ha mostrato: un errore del browser, di una chiamata REST, di
 * un controllo locale. `message` è la frase da usare in quel caso (per
 * esempio «Salvataggio non riuscito: …»); senza, il messaggio dell'errore.
 *
 * Il guardiano `showError.test.ts` impedisce di tornare a `toast.error(e.message)`.
 */
import { toast } from 'sonner'
import { wasNotifiedCentrally } from '@opengraphity/web-core'

/** Message of any thrown value (Error, Apollo ErrorLike, string). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'object' && e !== null && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

export function showError(error: unknown, message?: string): void {
  if (wasNotifiedCentrally(error)) return
  toast.error(message ?? errorMessage(error))
}
