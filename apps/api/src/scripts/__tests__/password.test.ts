import { describe, it, expect } from 'vitest'
import { Readable } from 'node:stream'
import {
  PASSWORD_STDIN_FLAG, assertNoPasswordInArgv, generateTemporaryPassword,
  printOneTimePassword, readPasswordFromStdin, resolvePassword,
} from '../lib/password.js'
import { ScriptArgError } from '../lib/scriptArgs.js'

describe('assertNoPasswordInArgv', () => {
  it('accepts argv without password options', () => {
    expect(() => assertNoPasswordInArgv(['--slug', 'x', PASSWORD_STDIN_FLAG])).not.toThrow()
  })
  it.each([
    ['--password', 'x'],
    ['--password=x'],
    ['--admin-password', 'x'],
    ['--admin-password=x'],
  ])('rejects %s', (...argv) => {
    expect(() => assertNoPasswordInArgv(argv)).toThrow(ScriptArgError)
    expect(() => assertNoPasswordInArgv(argv)).toThrow(/non è ammesso/)
  })
  it('does not confuse --password-stdin with --password', () => {
    expect(() => assertNoPasswordInArgv(['--password-stdin'])).not.toThrow()
  })
})

describe('generateTemporaryPassword', () => {
  it('is random, url-safe and long enough', () => {
    const a = generateTemporaryPassword()
    const b = generateTemporaryPassword()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]{24}$/)
  })
})

describe('readPasswordFromStdin', () => {
  it('reads the whole stream and strips only the final newline', async () => {
    await expect(readPasswordFromStdin(Readable.from(['ab', 'c\n']))).resolves.toBe('abc')
    await expect(readPasswordFromStdin(Readable.from(['p w d\r\n']))).resolves.toBe('p w d')
    await expect(readPasswordFromStdin(Readable.from([' spaced ']))).resolves.toBe(' spaced ')
  })
  it('fails on empty input', async () => {
    await expect(readPasswordFromStdin(Readable.from([]))).rejects.toThrow(ScriptArgError)
    await expect(readPasswordFromStdin(Readable.from(['\n']))).rejects.toThrow(/nessuna password/)
  })
})

describe('resolvePassword', () => {
  it('reads from stdin (non temporary) when the flag is present', async () => {
    await expect(resolvePassword([PASSWORD_STDIN_FLAG], Readable.from(['secret\n'])))
      .resolves.toEqual({ value: 'secret', source: 'stdin', temporary: false })
  })
  it('generates a temporary password otherwise', async () => {
    const r = await resolvePassword([], Readable.from([]))
    expect(r).toMatchObject({ source: 'generated', temporary: true })
    expect(r.value).toHaveLength(24)
  })
  it('refuses a password in argv', async () => {
    await expect(resolvePassword(['--password=x'], Readable.from([]))).rejects.toThrow(ScriptArgError)
  })
})

describe('printOneTimePassword', () => {
  it('prints generated passwords exactly once with a warning', () => {
    const lines: string[] = []
    printOneTimePassword('mario@acme.com', { value: 'PWD123', source: 'generated', temporary: true }, l => lines.push(l))
    const joined = lines.join('\n')
    expect(joined).toContain('PASSWORD TEMPORANEA per mario@acme.com')
    expect(joined.split('PWD123')).toHaveLength(2)
    expect(joined).toMatch(/cambio al primo login/)
  })
  it('prints nothing for stdin-supplied passwords', () => {
    const lines: string[] = []
    printOneTimePassword('x', { value: 'PWD123', source: 'stdin', temporary: false }, l => lines.push(l))
    expect(lines).toEqual([])
  })
})
