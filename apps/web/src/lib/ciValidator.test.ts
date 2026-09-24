/**
 * CI VALIDATION SCRIPTS, run in the browser before the form is submitted.
 *
 * The scripts are written by a customer administrator and run inside QuickJS,
 * never in the page itself. What matters here is the ORDER and the failure
 * mode: a required field that is empty stops before its script runs (the
 * script would only see `undefined`), the type-level script runs only once
 * every field is clean, and a visibility or default script that throws is an
 * error with the field's name — never a silent "visible" or a silent null.
 */
import { describe, it, expect } from 'vitest'
import { validateCI, isFieldVisible, getFieldDefault } from './ciValidator'

const field = (name: string, over: Record<string, unknown> = {}) =>
  ({ name, label: name.toUpperCase(), required: false, ...over })

describe('validateCI', () => {
  it('a clean input with no scripts is valid', async () => {
    expect(await validateCI({ name: 'srv-1' }, { fields: [field('name')] }))
      .toEqual({ valid: true, errors: {}, globalError: undefined })
  })

  it('an empty required field is reported by label, and its script does not run', async () => {
    for (const empty of [null, undefined, '']) {
      const r = await validateCI({ name: empty }, { fields: [field('name', { required: true, validationScript: 'throw "never"' })] })
      expect(r.valid).toBe(false)
      expect(r.errors['name']).toContain('NAME')
      expect(r.errors['name']).not.toBe('never')
    }
  })

  it('a field script that throws becomes that field\'s error, with the script\'s own words', async () => {
    const r = await validateCI({ port: 99999 }, { fields: [field('port', { validationScript: 'if (value > 65535) throw "Port out of range"' })] })
    expect(r).toMatchObject({ valid: false, errors: { port: 'Port out of range' } })
  })

  it('a field script sees the whole input, not just its own value', async () => {
    const r = await validateCI({ min: 5, max: 3 }, { fields: [field('max', { validationScript: 'if (value < input.min) throw "max below min"' })] })
    expect(r.errors['max']).toBe('max below min')
  })

  it('a thrown Error object is read too, not stringified as [object Object]', async () => {
    const r = await validateCI({ x: 1 }, { fields: [field('x', { validationScript: 'throw new Error("boom")' })] })
    expect(r.valid).toBe(false)
    expect(r.errors['x']).toBe('Error: boom')
  })

  it('a field script that passes leaves no error', async () => {
    const r = await validateCI({ port: 80 }, { fields: [field('port', { validationScript: 'if (value > 65535) throw "no"; return true' })] })
    expect(r.valid).toBe(true)
  })

  it('a field with no value skips its script: absent is not invalid', async () => {
    const r = await validateCI({}, { fields: [field('port', { validationScript: 'throw "should not run"' })] })
    expect(r.valid).toBe(true)
  })

  it('the TYPE script runs only when every field is clean, and its error is global', async () => {
    const tipo = { validationScript: 'if (input.a === input.b) throw "a and b must differ"', fields: [field('a'), field('b')] }
    const r = await validateCI({ a: 1, b: 1 }, tipo)
    expect(r).toMatchObject({ valid: false, globalError: 'a and b must differ' })

    // With a field error the type script does not run: one message at a time.
    const conErrore = await validateCI({ a: 1, b: 1 }, { ...tipo, fields: [field('a', { required: true }), field('b'), field('c', { required: true })] })
    expect(conErrore.globalError).toBeUndefined()
    expect(conErrore.errors['c']).toBeTruthy()
  })

  it('a type script that passes keeps the input valid', async () => {
    expect((await validateCI({ a: 1 }, { validationScript: 'return 1', fields: [field('a')] })).valid).toBe(true)
  })
})

describe('isFieldVisible', () => {
  const tipo = { fields: [{ name: 'serial', visibilityScript: 'return input.kind === "hw"' }, { name: 'name' }] }

  it('a field with no script is visible, and so is a field that does not exist', async () => {
    expect(await isFieldVisible('name', {}, tipo)).toBe(true)
    expect(await isFieldVisible('missing', {}, tipo)).toBe(true)
  })

  it('the script decides, on the current input', async () => {
    expect(await isFieldVisible('serial', { kind: 'hw' }, tipo)).toBe(true)
    expect(await isFieldVisible('serial', { kind: 'sw' }, tipo)).toBe(false)
  })

  it('a script that throws is an error naming the field, never a silent "visible"', async () => {
    const rotto = { fields: [{ name: 'serial', visibilityScript: 'throw "bad"' }] }
    await expect(isFieldVisible('serial', {}, rotto)).rejects.toThrow('visibility_script of field "serial" failed: bad')
    const oggetto = { fields: [{ name: 'serial', visibilityScript: 'throw { code: 1 }' }] }
    await expect(isFieldVisible('serial', {}, oggetto)).rejects.toThrow(/"code":1/)
  })
})

describe('getFieldDefault', () => {
  const tipo = { fields: [{ name: 'env', defaultScript: 'return input.region === "eu" ? "prod-eu" : "prod"' }, { name: 'x' }] }

  it('no script means no default', async () => {
    expect(await getFieldDefault('x', {}, tipo)).toBeNull()
    expect(await getFieldDefault('missing', {}, tipo)).toBeNull()
  })

  it('the script computes the default from the input', async () => {
    expect(await getFieldDefault('env', { region: 'eu' }, tipo)).toBe('prod-eu')
    expect(await getFieldDefault('env', {}, tipo)).toBe('prod')
  })

  it('a script that throws is an error naming the field, never a silent null', async () => {
    const rotto = { fields: [{ name: 'env', defaultScript: 'throw "nope"' }] }
    await expect(getFieldDefault('env', {}, rotto)).rejects.toThrow('default_script of field "env" failed: nope')
    const oggetto = { fields: [{ name: 'env', defaultScript: 'throw [1]' }] }
    await expect(getFieldDefault('env', {}, oggetto)).rejects.toThrow(/\[1\]/)
  })
})

/*
 * Review of 23 Sep 2026: the scripts run at every keystroke, on the main
 * thread, and had no limit — `while (!input.port) {}` as a default script
 * froze «New server» for every operator. Real QuickJS, real deadline.
 */
describe('a script that never ends', () => {
  it('a default script that loops is stopped and becomes the field\'s error, not a frozen tab', async () => {
    const started = Date.now()
    await expect(getFieldDefault('port', {}, { fields: [{ name: 'port', defaultScript: 'while (!input.port) {}' }] }))
      .rejects.toThrow(/default_script of field "port" failed: The script ran for more than \d+ ms and was stopped/)
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('a validation script that loops is the field\'s error', async () => {
    const r = await validateCI({ x: 1 }, { fields: [field('x', { validationScript: 'for (;;) {}' })] })
    expect(r.valid).toBe(false)
    expect(r.errors['x']).toMatch(/was stopped/)
  })
})
