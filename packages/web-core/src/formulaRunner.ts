/**
 * LE FORMULE DEI CAMPI CALCOLATI, NEL BROWSER (moduli del catalogo, ondata 6).
 *
 * Perché esiste, dato che il valore lo decide il server: perché chi compila
 * deve VEDERE il totale mentre scrive, non scoprirlo dopo aver creato il
 * ticket. Quello che si vede qui è un'anteprima; il valore che si scrive lo
 * ricalcola l'API al salvataggio, e se i due non coincidessero vince l'API —
 * per principio, non per caso: un valore calcolato nel browser è un valore che
 * l'utente può cambiare.
 *
 * QuickJS (WebAssembly), lo stesso sandbox con cui il web calcola i default dei
 * campi CI: nessun accesso alla pagina, alla rete o al DOM, e un `while(true)`
 * non blocca il browser perché il contesto ha un limite di istruzioni. Il
 * modulo si carica la prima volta che serve davvero (`import()` dinamico),
 * quindi un modulo senza formule non paga il megabyte del WASM.
 *
 * L'involucro è IDENTICO a quello del server (`runFormulaScript`): il codice
 * gira dentro una funzione, con `input` in scope, e restituisce con `return`.
 * Una formula scritta una volta vale in due posti.
 */
import { formulaInput } from '@opengraphity/types'

/** Il pezzo di libreria che serve, caricato una volta sola. */
let quickjs: Promise<{ newContext: () => QuickJSContext }> | null = null

interface QuickJSContext {
  evalCode: (code: string) => { error?: QuickJSHandle; value?: QuickJSHandle }
  dump: (h: QuickJSHandle) => unknown
  dispose: () => void
}
interface QuickJSHandle { dispose: () => void }

async function contesto(): Promise<QuickJSContext> {
  if (!quickjs) quickjs = import('quickjs-emscripten').then((m) => m.getQuickJS()) as Promise<{ newContext: () => QuickJSContext }>
  return (await quickjs).newContext()
}

export interface FormulaEsito {
  /** Il valore calcolato: `null` vuol dire «nessun valore», non «zero». */
  value: unknown
  /** Il messaggio dell'errore, quando la formula non ha prodotto un valore. */
  error: string | null
}

/**
 * Esegue una formula sola. Non lancia: un errore torna dentro l'esito, perché
 * chi compila non deve vedere una pagina rotta per una formula sbagliata — lo
 * dice il campo, accanto al suo valore.
 */
export async function runFormula(code: string, input: Record<string, unknown>): Promise<FormulaEsito> {
  /**
   * Il sandbox si carica DENTRO il try, non prima: se il wasm non parte —
   * un CSP senza `wasm-unsafe-eval`, una rete che perde il file — l'errore
   * deve arrivare al campo e non restare una promise rifiutata nella console.
   * È il difetto che ha lasciato il campo calcolato vuoto nel portale: si
   * vedeva «—», cioè «nessun valore», che è una risposta, non un guasto.
   */
  let vm: QuickJSContext
  try {
    vm = await contesto()
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) }
  }
  try {
    const risultato = vm.evalCode(`(function(){\n  const input = ${JSON.stringify(input)};\n${code}\n})()`)
    if (risultato.error) {
      const err = vm.dump(risultato.error)
      risultato.error.dispose()
      return { value: null, error: typeof err === 'string' ? err : JSON.stringify(err) }
    }
    const valore = risultato.value ? vm.dump(risultato.value) : null
    risultato.value?.dispose()
    /**
     * `NaN` e `Infinity` NON sono valori: sono il segno che la formula ha
     * moltiplicato qualcosa che non c'era. Qui diventano «nessun valore» per
     * due ragioni: a schermo «NaN» non vuol dire niente per chi compila, e il
     * server fa già la stessa cosa — passa il risultato per JSON, dove `NaN`
     * diventa `null`. Senza questa riga il browser mostrerebbe «NaN» e il
     * ticket nascerebbe vuoto: due risposte diverse alla stessa domanda.
     */
    if (typeof valore === 'number' && !Number.isFinite(valore)) return { value: null, error: null }
    return { value: valore ?? null, error: null }
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : String(e) }
  } finally {
    vm.dispose()
  }
}

export interface CampoConFormula {
  name: string
  formula?: string | null
}

export interface FormuleCalcolate {
  /** Valore per nome di campo: da mettere nelle risposte. */
  values: Record<string, unknown>
  /** Errore per nome di campo, quando la formula non ha prodotto un valore. */
  errors: Record<string, string>
}

/**
 * Tutte le formule dei campi dati, con le stesse regole del server: ogni
 * formula vede solo le risposte dei campi NON calcolati (`formulaInput`, dal
 * contratto condiviso), quindi l'ordine non conta e i cicli non esistono.
 */
export async function computeFormulas(
  campi: readonly CampoConFormula[],
  answers: Readonly<Record<string, unknown>>,
): Promise<FormuleCalcolate> {
  const conFormula = campi.filter((c) => c.formula && c.formula.trim() !== '')
  if (conFormula.length === 0) return { values: {}, errors: {} }
  const calcolati = new Set(campi.filter((c) => c.formula).map((c) => c.name))
  const input = formulaInput(answers, calcolati)
  const values: Record<string, unknown> = {}
  const errors: Record<string, string> = {}
  for (const campo of conFormula) {
    const esito = await runFormula(campo.formula!, input)
    if (esito.error) errors[campo.name] = esito.error
    values[campo.name] = esito.value
  }
  return { values, errors }
}
