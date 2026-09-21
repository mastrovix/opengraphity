/**
 * Lo script di validazione di un campo del metamodello, sull'API. Nato per i CI
 * (`ciMutations.ts`, F-13); lo usano anche i campi personalizzati dei ticket
 * (verifica «Cosa resta cablato», ondata 4).
 */
import { assertScriptingEnabled, isTenantOwnedDefinition } from './scriptingPlan.js'

/**
 * Runs one metamodel validation script in the scripting sandbox. The script
 * has the same contract as in the browser (CIDynamicForm/ciValidator): the
 * free variables `input` (whole CI, camelCase) and `value` (the field value)
 * are in scope and the script THROWS to reject. Returns the rejection
 * message, or null when the script accepted the value.
 */
export async function runValidationScript(
  code: string,
  data: { input: Record<string, unknown>; value?: unknown },
  name: string,
  tenantId: string,
  scope: string | undefined,
): Promise<string | null> {
  // Limite di piano (D-12): uno script scritto dal cliente non gira se il suo
  // piano non include gli script, e il rifiuto è esplicito. Gli script del
  // metamodello condiviso (scope base/itil: url, ipAddress, expiresAt,
  // certificate) sono comportamento del prodotto e non passano dal limite.
  if (isTenantOwnedDefinition(scope)) {
    await assertScriptingEnabled(tenantId, `field script of "${name}"`, 'errors.scripting.what.field', { field: name })
  }
  const { runScript } = await import('@opengraphity/scripting')
  const now = new Date().toISOString()
  const result = await runScript(
    {
      id: name, tenant_id: tenantId, name, trigger: 'manual',
      code: `const input = ctx.input;\nconst value = ctx.value;\n${code}`,
      enabled: true, created_at: now, updated_at: now,
    },
    { input: data.input, value: data.value ?? null, tenantId },
  )
  return result.success ? null : (result.error ?? `${name} failed`)
}

/**
 * LA FORMULA DI UN CAMPO CALCOLATO (moduli del catalogo, ondata 6).
 *
 * Differenza dalla validazione: quella accetta o rifiuta (`throw`), questa
 * RESTITUISCE un valore (`return`). Il sandbox avvolge il codice in una
 * funzione, quindi `return input.costo * input.quantita` è già una formula
 * valida — ed è lo stesso testo che gira nel browser in QuickJS mentre si
 * compila, perché lì l'involucro è identico.
 *
 * Il limite degli script del piano vale anche qui: una formula è codice
 * scritto dal cliente. Chi non ha la funzione accesa non la esegue e lo SENTE
 * dire, invece di ricevere un campo vuoto senza spiegazione.
 *
 * Non traduce e non interpreta il risultato: `undefined` e `null` vogliono dire
 * «nessun valore», e a convertirlo nel tipo del campo pensa chi ha chiesto il
 * calcolo (`coerce` in lib/catalogForm.ts), con le stesse regole di un valore
 * scritto a mano.
 */
export async function runFormulaScript(
  code: string,
  input: Record<string, unknown>,
  name: string,
  tenantId: string,
): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  await assertScriptingEnabled(tenantId, `formula of "${name}"`, 'errors.scripting.what.formula', { field: name })
  const { runScript } = await import('@opengraphity/scripting')
  const now = new Date().toISOString()
  const result = await runScript(
    {
      id: name, tenant_id: tenantId, name, trigger: 'manual',
      code: `const input = ctx.input;\n${code}`,
      enabled: true, created_at: now, updated_at: now,
    },
    { input, tenantId },
  )
  if (!result.success) return { ok: false, error: result.error ?? `${name} failed` }
  return { ok: true, value: result.output }
}
