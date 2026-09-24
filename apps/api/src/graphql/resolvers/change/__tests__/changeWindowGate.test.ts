/**
 * IL LINT DEL VARCO (terza revisione · C1), rewritten for wave 7 · B1.
 *
 * Il varco della finestra di rilascio era scritto bene in UN posto e
 * `autoTransitions.ts` non lo conosceva. Contando i chiamanti di
 * `workflowEngine.transition` sono venuti fuori **quattordici** cammini, non
 * tre: cinque potevano far transire un'istanza di change e nessuno dei due
 * revisori ne aveva visti più di due. This test then asked every caller to
 * declare how it stood with the gate, with a proof for each exemption.
 *
 * The review of 23 Sep 2026 counted twenty-seven, each choosing its own
 * checks. Now there is one: the pipeline of the transitions
 * (services/ticketTransition.ts) is the only caller of the engine, and the
 * gate is one of its guards for every change. What this test demands is
 * simpler and stronger: that nobody calls the engine anywhere else — a new
 * path that did would walk past the gate, the approvals and the required
 * fields at once — and that the pipeline keeps the gate.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('../../../../', import.meta.url)))
const PIPELINE = 'services/ticketTransition.ts'

/** Calls the engine to move an instance, under whatever name the engine goes by. */
const TRANSITIONS = /\b(?:workflowEngine|engine\(\)\)|engine)\.transition\s*\(/

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules' || name === 'dist') continue
      walk(full, out)
    } else if (name.endsWith('.ts')) {
      out.push(full)
    }
  }
  return out
}

const callers = walk(SRC)
  .filter((f) => TRANSITIONS.test(readFileSync(f, 'utf8')))
  .map((f) => relative(SRC, f).split('\\').join('/'))
  .sort()

describe('one way to move a ticket, and the release window on it', () => {
  it('only the pipeline of the transitions calls the engine', () => {
    expect(callers, 'These files move an instance without the pipeline: the release window, the approvals, the '
      + 'required fields and the step actions would not hold there. Call transitionTicket (services/ticketTransition.ts).',
    ).toEqual([PIPELINE])
  })

  it('the pattern still recognises the ways the engine was called (so the test above cannot pass by accident)', () => {
    for (const line of [
      'await workflowEngine.transition(session, {',
      'const res = await (await engine()).transition(',
      'engine.transition (s, input)',
    ]) expect(TRANSITIONS.test(line), line).toBe(true)
  })

  it('the pipeline asks the gate for every change: the manual one for a person, the automatic one for the rest', () => {
    const src = readFileSync(join(SRC, PIPELINE), 'utf8')
    expect(src).toContain("windowGate.js")
    expect(src).toMatch(/if \(t\.entityType === 'change'\) \{\s*const refused = await changeWindowRefusal\(/)
    expect(src).toContain('gate.assertChangeWindowGate(')
    expect(src).toContain('gate.automaticTransitionOutcome(')
    expect(src).toContain('gate.automaticTransitionAllowed(')
  })
})
