/**
 * The self-analysis workflow (.github/workflows/autoanalisi.yml): the agent
 * reads a dossier partly written by any user's browser, so it must hold
 * nothing that writes the code (review of 23 Sep 2026). Until then it ran
 * with `contents: write`, the checkout's credentials and `node:*`/`pnpm:*`
 * among its commands — injected text could push to main, which has no branch
 * protection on this plan. The pins below turn red if any of it comes back.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const text = readFileSync(join(process.cwd(), '../../.github/workflows/autoanalisi.yml'), 'utf8')
/** The text of one job, from its key to the next top-level job (or the end). */
function job(name: string): string {
  const start = text.indexOf(`\n  ${name}:\n`)
  expect(start, `job ${name} not found`).toBeGreaterThan(-1)
  const next = text.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/)
  return next === -1 ? text.slice(start) : text.slice(start, start + 1 + next)
}

describe('the self-analysis agent holds nothing that writes the code', () => {
  const agent = job('proponi')

  it('its job reads the contents and cannot mint an OIDC token (exchanged for the Claude app token, which writes)', () => {
    expect(agent).toMatch(/permissions:\n\s+contents: read\n/)
    expect(agent).not.toMatch(/contents: write/)
    expect(agent).not.toMatch(/id-token:/)
  })

  it('the checkout leaves no credentials behind, and the action gets this job\'s read-only token', () => {
    expect(agent).toMatch(/persist-credentials: false/)
    expect(agent).toMatch(/github_token: \$\{\{ secrets\.GITHUB_TOKEN \}\}/)
  })

  it('no command that runs anything: no node:*, no pnpm:*, no git push, no gh pr create', () => {
    const tools = /--allowedTools "([^"]+)"/.exec(agent)?.[1] ?? ''
    expect(tools).not.toBe('')
    for (const open of ['Bash(node:*)', 'Bash(pnpm:*)', 'Bash(git:*)', 'Bash(git push', 'Bash(gh pr create', 'Bash(gh:*)']) {
      expect(tools, open).not.toContain(open)
    }
  })
})

describe('the publishing job runs no agent code and refuses changes to the Actions', () => {
  const publish = job('pubblica')

  it('it applies a patch on an autoanalisi/* branch, refusing anything under .github/', () => {
    expect(publish).toMatch(/needs: proponi/)
    expect(publish).toMatch(/RAMO="autoanalisi\//)
    expect(publish).toMatch(/grep -E '\^\\\.github\/'/)
    expect(publish).not.toMatch(/claude-code-action/)
  })
})
