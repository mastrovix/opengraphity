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
