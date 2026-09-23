/**
 * AN HTTP HANDLER THAT FAILS DOES NOT END THE PROCESS (review of 23 Sep 2026).
 *
 * On Node 24 an unhandled rejection or an unlistened stream 'error' ends the
 * process. The REST routes and server.ts run an async body through
 * `runRoute` and stream files through `sendFile` (rest/routeSafety.ts): a bare
 * `void (async () => …)()`, a `void handle(req, res)` and a `.pipe(res)` are
 * refused here.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FILES = [
  path.join(SRC, 'server.ts'),
  ...fs.readdirSync(path.join(SRC, 'rest')).filter((f) => f.endsWith('.ts') && f !== 'routeSafety.ts').map((f) => path.join(SRC, 'rest', f)),
]

const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const FORBIDDEN: Array<[string, RegExp]> = [
  ['an async body with no catch: use runRoute', /void\s*\(\s*async\s*\(/],
  ['an async handler with no catch: use runRoute', /=>\s*void\s+handle\w*\(/],
  ['a file piped with no error listener: use sendFile', /\.pipe\(\s*res\s*\)/],
]

describe('REST routes', () => {
  it.each(FORBIDDEN)('have no %s', (_what, re) => {
    const offenders = FILES.filter((f) => re.test(withoutComments(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('the patterns see what they forbid', () => {
    expect(FORBIDDEN[0]![1].test('void (async () => { await x() })()')).toBe(true)
    expect(FORBIDDEN[1]![1].test('(req, res) => void handleSlackCommands(req, res)')).toBe(true)
    expect(FORBIDDEN[2]![1].test('fs.createReadStream(p).pipe(res)')).toBe(true)
  })
})
