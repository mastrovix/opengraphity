/**
 * GUARDIAN: THE PROCESSES THAT PUBLISH HAVE THE OUTBOX (wave 7 · B2).
 *
 * The outbox is registered by who starts the process (lib/outbox.ts,
 * `installEventOutbox`). A process without it still publishes — straight to
 * the queues, as a script does — and nothing fails: an event lost between the
 * commit and the queue is simply lost again, and nobody would notice that the
 * outbox had stopped working. The API (index.ts) and the workers (worker.ts,
 * which is also the events worker) must install it, at module level, before
 * `main()` can start anything that publishes.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

describe.each(['index.ts', 'worker.ts'])('%s', (entry) => {
  const src = readFileSync(join(SRC, entry), 'utf8')

  it('imports and installs the outbox before main() runs', () => {
    expect(src).toContain("import { installEventOutbox } from './lib/outbox.js'")
    const install = src.search(/^installEventOutbox\(\)$/m)
    const main = src.search(/^main\(\)/m)
    expect(install, 'installEventOutbox() at module level').toBeGreaterThan(-1)
    expect(main).toBeGreaterThan(install)
  })
})
