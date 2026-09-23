/**
 * APOLLO DROPS WHAT A CALLBACK RETURNS (tour of 23 Sep 2026).
 *
 * `useMutation` calls `onCompleted` and `onError` without awaiting them. An
 * `async onCompleted` that awaited a refetch turned a failed reload into an
 * unhandled rejection, and what came after the await — the success toast,
 * closing the dialog, opening the new ticket — never happened, although the
 * change was done. Twenty of them were found across the web.
 *
 * A callback does its work and returns: a reload goes through
 * `reloadQueries` (lib/reloadQueries.ts), and a step that must wait for
 * another mutation lives in a named function that catches its failure.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOTS = [
  path.resolve(HERE, '..'),                                 // apps/web/src
  path.resolve(HERE, '../../../portal/src'),                // apps/portal/src
  path.resolve(HERE, '../../../../packages/web-core/src'),  // packages/web-core/src
]

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '__tests__' && entry.name !== 'test') sources(full, out)
    } else if (/\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

/** The code without its comments: a comment may tell the story of the defect. */
const withoutComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const ASYNC_CALLBACK = /\b(onCompleted|onError)\s*(:|=\{)\s*async\b/g

describe('Apollo callbacks', () => {
  it('no onCompleted or onError is async: Apollo does not wait for it, and a failure after an await is lost', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of sources(root)) {
        const src = withoutComments(fs.readFileSync(file, 'utf8'))
        for (const m of src.matchAll(ASYNC_CALLBACK)) {
          const line = src.slice(0, m.index).split('\n').length
          offenders.push(`${path.relative(path.resolve(HERE, '../../../..'), file)}:${line}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('the guard sees the pattern it forbids', () => {
    expect('useMutation(M, { onCompleted: async () => { await refetch() } })'.match(ASYNC_CALLBACK)).toHaveLength(1)
    expect('<Q onError={async (e) => { await x(e) }} />'.match(ASYNC_CALLBACK)).toHaveLength(1)
    expect('useMutation(M, { onCompleted: () => { reloadQueries(refetch) } })'.match(ASYNC_CALLBACK)).toBeNull()
  })
})
