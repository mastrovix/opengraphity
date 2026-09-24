/**
 * EVERY BUTTON GIVES ITS PROMISE BACK (review of 23 Sep 2026).
 *
 * The shared `Button` disables itself while the promise its `onClick` returns
 * is pending — the guard against a double click that created two SLA
 * policies, two triggers, two channels. It can guard only what it is given:
 * `onClick={() => void save()}` throws the promise away, and the button stays
 * clickable while the save runs. 63 handlers were written that way; this test
 * keeps the next one out.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function tsx(dir = SRC, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'test') tsx(p, out); continue }
    if (e.name.endsWith('.tsx') && !e.name.includes('.test.')) out.push(p)
  }
  return out
}

/** The `<Button …>` opening tags whose `onClick` discards a promise with `void`. */
export function buttonsDiscardingPromises(source: string): number[] {
  const lines: number[] = []
  for (const m of source.matchAll(/onClick=\{\(\) => void /g)) {
    const opener = source.lastIndexOf('<', m.index)
    const tag = /^<([A-Za-z][\w.]*)/.exec(source.slice(opener))?.[1]
    if (tag === 'Button') lines.push(source.slice(0, m.index).split('\n').length)
  }
  return lines
}

describe('the Button click handlers', () => {
  it('the scan sees the pattern it guards against, and only on a Button', () => {
    expect(buttonsDiscardingPromises('<Button size="xs" onClick={() => void save()}>Save</Button>')).toEqual([1])
    expect(buttonsDiscardingPromises('<button onClick={() => void save()}>Save</button>')).toEqual([])
    expect(buttonsDiscardingPromises('<Button\n  variant="primary"\n  onClick={() => void save()}\n>')).toEqual([3])
  })

  it('no Button in the app throws its promise away', () => {
    const offenders = tsx().flatMap((file) =>
      buttonsDiscardingPromises(fs.readFileSync(file, 'utf8')).map((line) => `${path.relative(SRC, file)}:${line}`))
    expect(offenders, 'onClick={() => void …} on a Button: return the promise, `onClick={() => save()}`, so the button can hold a second click').toEqual([])
  })
})
