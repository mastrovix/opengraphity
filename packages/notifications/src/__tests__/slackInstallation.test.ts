/**
 * WHICH SLACK WORKSPACE BELONGS TO WHICH ORGANIZATION.
 *
 * There used to be one platform-wide Slack token: every organization's
 * messages went out from the same bot, and an incoming `/og` command was
 * attributed to an organization only through the linked Slack user. Now each
 * organization connects its own workspace, and `loadSlackInstallationByTeam`
 * is what turns an incoming command into "this is customer X" — a tenant
 * boundary, decided before any authorization runs.
 *
 * The secrets come back decrypted, so the two of them are read exactly where
 * they are needed and nowhere else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  queries: [] as Array<{ cypher: string; params: Record<string, unknown> }>,
  closed: 0,
}))

vi.mock('@opengraphity/neo4j', () => ({
  getSession: () => ({
    executeRead: async (fn: (tx: { run: (c: string, p: Record<string, unknown>) => Promise<unknown> }) => Promise<unknown>) =>
      fn({
        run: async (cypher: string, params: Record<string, unknown>) => {
          state.queries.push({ cypher, params })
          return { records: state.rows.map((r) => ({ get: (k: string) => r[k] })) }
        },
      }),
    close: async () => { state.closed += 1 },
  }),
}))

// The secret box is the real one: "the token comes back decrypted" is only
// worth asserting against the encryption actually used.
process.env['SECRETS_ENCRYPTION_KEY'] = 'a'.repeat(64)
const { encryptSecret } = await import('../secretBox.js')
const { loadSlackInstallation, loadSlackInstallationByTeam, slackBotToken } = await import('../slackInstallation.js')

const row = (over: Record<string, unknown> = {}) => ({
  tenantId: 'c-one', teamId: 'T123', teamName: 'Acme', mode: 'app',
  botUserId: 'U999', installedAt: '2026-09-01T10:00:00Z', installedByName: 'Anna',
  botTokenEnc: encryptSecret('xoxb-real-token'), signingSecretEnc: null,
  ...over,
})

beforeEach(() => { state.rows = [row()]; state.queries = []; state.closed = 0 })

describe('loadSlackInstallation — the view without secrets', () => {
  it('returns the installation of the organization and no token anywhere in it', async () => {
    const i = await loadSlackInstallation('c-one')
    expect(i).toEqual({
      tenantId: 'c-one', teamId: 'T123', teamName: 'Acme', mode: 'app',
      botUserId: 'U999', installedAt: '2026-09-01T10:00:00Z', installedByName: 'Anna',
    })
    expect(JSON.stringify(i)).not.toContain('xoxb')
    expect(state.queries[0]!.params).toEqual({ tenantId: 'c-one' })
    expect(state.closed).toBe(1)
  })

  it('no Slack connected is null, not an error: most organizations have none', async () => {
    state.rows = []
    expect(await loadSlackInstallation('c-two')).toBeNull()
  })

  it('the optional fields read as empty or null instead of undefined', async () => {
    state.rows = [row({ teamName: null, botUserId: null, installedByName: null })]
    expect(await loadSlackInstallation('c-one')).toMatchObject({ teamName: '', botUserId: null, installedByName: null })
  })

  it('a mode outside the two known ones is refused, naming the organization and the value', async () => {
    // `app` and `token` decide which signing secret validates an incoming
    // command: a third value would mean validating against nothing.
    for (const mode of ['oauth', null, undefined, 42]) {
      state.rows = [row({ mode })]
      await expect(loadSlackInstallation('c-one')).rejects.toThrow(/SlackInstallation of c-one has an unknown mode/)
    }
  })
})

describe('loadSlackInstallationByTeam — from a workspace to its organization', () => {
  it('looks up by team_id and brings the decrypted bot token', async () => {
    const i = await loadSlackInstallationByTeam('T123')
    expect(state.queries[0]!.params).toEqual({ teamId: 'T123' })
    expect(state.queries[0]!.cypher).toContain('MATCH (s:SlackInstallation {team_id: $teamId})')
    expect(i?.botToken).toBe('xoxb-real-token')
    expect(i?.tenantId).toBe('c-one')
  })

  it('in `app` mode there is no per-organization signing secret: the platform app signs', async () => {
    expect((await loadSlackInstallationByTeam('T123'))?.signingSecret).toBeNull()
  })

  it('in `token` mode the organization\'s own signing secret comes back decrypted', async () => {
    state.rows = [row({ mode: 'token', signingSecretEnc: encryptSecret('sig-of-their-app') })]
    const i = await loadSlackInstallationByTeam('T123')
    expect(i?.mode).toBe('token')
    expect(i?.signingSecret).toBe('sig-of-their-app')
  })

  it('an unknown workspace is null: nothing is attributed to a guessed organization', async () => {
    state.rows = []
    expect(await loadSlackInstallationByTeam('T-unknown')).toBeNull()
  })
})

describe('slackBotToken', () => {
  it('returns the decrypted token of the organization', async () => {
    expect(await slackBotToken('c-one')).toBe('xoxb-real-token')
  })

  it('without Slack connected it is an error that says where to connect it', async () => {
    // The caller is about to send a message: returning null here would turn
    // into a TypeError far from the actual cause.
    state.rows = []
    await expect(slackBotToken('c-two'))
      .rejects.toThrow('Slack is not connected for organization c-two: connect the workspace in External connections → Integrations')
  })

  it('a token sealed with another key surfaces as a key problem, not as a missing installation', async () => {
    state.rows = [row({ botTokenEnc: 'v1:bm90LWEtcmVhbC1jaXBoZXJ0ZXh0LWF0LWFsbC1ub3Bl' })]
    await expect(slackBotToken('c-one')).rejects.toThrow(/cannot be decrypted|corrupted/)
  })
})
