/*
 * The scripts of the CI types run in the browser at every keystroke: each
 * evaluation has a deadline and the runtime a memory cap, so a looping script
 * is an error of the field, not a frozen tab (review of 23 Sep 2026).
 */
import { newBoundedScriptVM, scriptErrorMessage } from '@opengraphity/web-core'
import i18n from '@/i18n/i18n'

export interface ValidationResult {
  valid: boolean
  errors: Record<string, string>
  globalError?: string
}

export async function validateCI(
  input: Record<string, unknown>,
  ciType: {
    validationScript?: string | null
    fields: Array<{
      name: string
      label: string
      required: boolean
      validationScript?: string | null
    }>
  },
): Promise<ValidationResult> {
  const errors: Record<string, string> = {}
  let globalError: string | undefined

  const vm = await newBoundedScriptVM()

  try {
    const inputJson = JSON.stringify(input)

    for (const field of ciType.fields) {
      const val = input[field.name]

      // Required check
      if (field.required && (val === null || val === undefined || val === '')) {
        errors[field.name] = i18n.t('forms.requiredField', { field: field.label })
        continue
      }

      // Field validation script
      if (field.validationScript && val !== null && val !== undefined) {
        const script = `(function() {
          const value = ${JSON.stringify(val)};
          const input = ${inputJson};
          ${field.validationScript}
        })()`
        const result = vm.evalCode(script)
        if (result.error) {
          const err = vm.dump(result.error)
          errors[field.name] = scriptErrorMessage(err)
          result.error.dispose()
        } else {
          result.value?.dispose()
        }
      }
    }

    // Type-level validation script (only if no field errors)
    if (ciType.validationScript && Object.keys(errors).length === 0) {
      const script = `(function() {
        const input = ${inputJson};
        ${ciType.validationScript}
      })()`
      const result = vm.evalCode(script)
      if (result.error) {
        const err = vm.dump(result.error)
        globalError = scriptErrorMessage(err)
        result.error.dispose()
      } else {
        result.value?.dispose()
      }
    }
  } finally {
    vm.dispose()
  }

  return {
    valid: Object.keys(errors).length === 0 && !globalError,
    errors,
    globalError,
  }
}

export async function isFieldVisible(
  fieldName: string,
  input: Record<string, unknown>,
  ciType: { fields: Array<{ name: string; visibilityScript?: string | null }> },
): Promise<boolean> {
  const field = ciType.fields.find(f => f.name === fieldName)
  if (!field?.visibilityScript) return true

  const vm = await newBoundedScriptVM()
  try {
    const script = `(function() {
      const input = ${JSON.stringify(input)};
      ${field.visibilityScript}
    })()`
    const result = vm.evalCode(script)
    if (result.error) {
      const err = vm.dump(result.error)
      result.error.dispose()
      throw new Error(
        `visibility_script of field "${fieldName}" failed: ${scriptErrorMessage(err)}`,
      )
    }
    const val = result.value ? vm.dump(result.value) : undefined
    result.value?.dispose()
    return Boolean(val)
  } finally {
    vm.dispose()
  }
}

export async function getFieldDefault(
  fieldName: string,
  input: Record<string, unknown>,
  ciType: { fields: Array<{ name: string; defaultScript?: string | null }> },
): Promise<unknown> {
  const field = ciType.fields.find(f => f.name === fieldName)
  if (!field?.defaultScript) return null

  const vm = await newBoundedScriptVM()
  try {
    const script = `(function() {
      const input = ${JSON.stringify(input)};
      ${field.defaultScript}
    })()`
    const result = vm.evalCode(script)
    if (result.error) {
      const err = vm.dump(result.error)
      result.error.dispose()
      throw new Error(
        `default_script of field "${fieldName}" failed: ${scriptErrorMessage(err)}`,
      )
    }
    const val = result.value ? vm.dump(result.value) : undefined
    result.value?.dispose()
    return val
  } finally {
    vm.dispose()
  }
}
