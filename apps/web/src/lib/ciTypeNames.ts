/**
 * I nomi dei tipi e dei campi CI, lato interfaccia (A-12).
 *
 * Le regole NON sono riscritte qui: arrivano da
 * `@opengraphity/schema-generator/names`, lo stesso modulo che usa la porta
 * dell'API (`apps/api/src/lib/metamodelNames.ts`). Due copie vorrebbero dire
 * un nome accettato dal form e rifiutato dal server — o, peggio, il contrario.
 *
 * **Quella del server è l'unica che conta**: un client con API key non passa
 * dal web. Questa serve a dirlo subito, con la stessa spiegazione, invece di
 * far cliccare «Crea» per ricevere un errore.
 *
 * L'elenco dei nomi già presi lo calcola il web da `ciTypes` — che è il
 * metamodello VIVO — invece di tenerne una copia: è la stessa idea dell'API,
 * che lo legge dallo schema di base e dal grafo.
 */
import {
  assertCITypeName, assertCIFieldName,
  reservedNamesForCITypes, mergeReservedNames, emptyReservedNames,
  MetamodelNameError,
  type ReservedSchemaNames,
} from '@opengraphity/schema-generator/names'
import i18n from '@/i18n/i18n'

/** Quel poco che serve di un tipo CI per sapere se un nome è già preso. */
export interface KnownCIType {
  name:  string
  scope?: string | null
}

/** Un tipo è spedito col prodotto quando non è del cliente (A-6). */
export function isShippedType(t: { scope?: string | null }): boolean {
  return (t.scope ?? 'base') !== 'tenant'
}

/**
 * DA DOVE viene il nome già preso: finisce dentro il messaggio di rifiuto che
 * compone `@opengraphity/schema-generator/names`. La frase la traduce il
 * client, quindi qui si chiede la chiave a i18n invece di scriverla.
 */
function originOf(scope: string | null | undefined): string {
  switch (scope) {
    case 'base':   return i18n.t('citypeDesigner.origin.base')
    case 'itil':   return i18n.t('citypeDesigner.origin.itil')
    case 'tenant': return i18n.t('citypeDesigner.origin.tenant')
    default:       return i18n.t('citypeDesigner.origin.unknown')
  }
}

/**
 * L'elenco riservato che il web può calcolare: i tipi CI che ha davanti.
 *
 * Niente lista scritta a mano dei tipi dello schema di base — quella vive nel
 * server, che la **legge** da `buildBaseSDL()`. Qui non la si ricopia: un nome
 * come `team` passa il form e il server lo rifiuta con lo stesso messaggio.
 * Il contrario (il form rifiuta, il server accetta) non è possibile, perché il
 * server ha l'elenco completo — che è l'unico ordine di errori accettabile.
 */
const reservedFor = (types: readonly KnownCIType[]): ReservedSchemaNames =>
  mergeReservedNames(
    emptyReservedNames(),
    reservedNamesForCITypes(types.map((t) => ({ name: t.name, origin: originOf(t.scope) }))),
  )

/**
 * La FRASE di rifiuto nella lingua del cliente, o `null` se il nome va bene.
 *
 * Il rifiuto arriva come dato (`rule` + `i18n: { key, params }`) e la frase la
 * compone qui il client: `message` e in inglese per i log. I parametri che
 * finiscono in `Key` sono a loro volta chiavi (le parti facoltative della
 * frase) e si risolvono passando gli stessi parametri, come fa il link i18n
 * di Apollo per gli errori dell'API. Se la chiave non e nei locale si mostra
 * il `message` inglese: meglio una frase nella lingua sbagliata che nessuna.
 */
function fraseDiRifiuto(e: MetamodelNameError): string {
  const params: Record<string, string> = { ...e.i18n.params }
  for (const [nome, valore] of Object.entries(e.i18n.params)) {
    if (nome.endsWith('Key')) params[nome.slice(0, -3)] = i18n.t(valore, params)
  }
  return i18n.exists(e.i18n.key) ? i18n.t(e.i18n.key, params) : e.message
}

/** Il messaggio di rifiuto, o `null` se il nome va bene. */
export function checkCITypeName(name: string, existing: readonly KnownCIType[]): string | null {
  try { assertCITypeName(name, reservedFor(existing)); return null }
  catch (e) { if (e instanceof MetamodelNameError) return fraseDiRifiuto(e); throw e }
}

/** Come sopra per un nome di campo, con i campi già presenti sul tipo. */
export function checkCIFieldName(
  name: string,
  opts: { existingFieldNames?: readonly string[]; typeLabel?: string } = {},
): string | null {
  try {
    assertCIFieldName(name, { existingFieldNames: opts.existingFieldNames, typeLabel: opts.typeLabel })
    return null
  } catch (e) { if (e instanceof MetamodelNameError) return fraseDiRifiuto(e); throw e }
}

export { suggestCITypeName, suggestCIFieldName, CI_TYPE_NAME_RE, CI_FIELD_NAME_RE } from '@opengraphity/schema-generator/names'
