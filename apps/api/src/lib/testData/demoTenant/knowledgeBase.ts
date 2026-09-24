/**
 * THE KNOWLEDGE BASE OF THREE YEARS (tour of 23 Sep 2026, D16).
 *
 * The tour found it empty: not one article in three years — the only one was
 * the AI draft written during the tour. A service desk that has run for three
 * years has written two kinds of articles, and both are here:
 *  - a KNOWN ERROR written up once the problem found its workaround: the
 *    symptoms, the workaround, the cause, and the problem's number;
 *  - HOW-TOs and FAQs for the employees, read from the portal: the VPN, the
 *    password, Outlook, the Wi-Fi — the things people open incidents about.
 *
 * Each article lives as the product runs it (resolvers/knowledgeBase.ts,
 * approval.ts, the «KB Article Lifecycle» workflow): created as a draft,
 * edited (every edit keeps the previous text as a version), sent for review —
 * which asks the administrators for an approval — approved and published, now
 * and then sent back with a note first; read by people (views, helpful or
 * not), and after a year or two some are archived. An article written from
 * incidents is linked to them (`WRITTEN_FROM`, what the coverage page counts).
 * The step moves of an article leave their history row and nothing else: the
 * step-entered note and audit are for tickets only.
 */
import type { Rng } from './random.js'
import { DAY, HOUR, MINUTE } from './clock.js'
import { arrivalInstants } from './arrivals.js'
import { TicketTrail } from './trail.js'
import type { World } from './world.js'
import type { PlannedUser } from './people.js'
import type { DemoWriter } from './writer.js'
import { auditRow } from './writeReference.js'

/** What a known-error article is written from: the problem, once it had its workaround. */
export interface KnownErrorFact {
  problemId: string
  number: string
  title: string
  description: string
  workaround: string
  rootCause: string
  ciName: string
  ciLabel: string
  category: string
  /** The person who worked the problem: they write the article. */
  authorId: string
  knownAtMs: number
  incidentIds: string[]
}

interface HowTo {
  title: string
  category: 'how-to' | 'faq'
  /** The portal incidents it answers (`INCIDENT_STORIES.portal` keys). */
  story: string
  steps: string[]
  tags: string[]
}

/** The questions people ask the service desk the most, answered once for all. */
const HOW_TOS: readonly HowTo[] = [
  { title: 'Reset your password from the portal', category: 'how-to', story: 'portal.account', tags: ['password', 'account'],
    steps: ['Open the portal and choose «Forgot password».', 'Enter your company e-mail and the code sent to your phone.', 'Choose a new password of at least 12 characters.', 'Lock and unlock your laptop so that it picks up the new password.'] },
  { title: 'Unlock your account after too many attempts', category: 'faq', story: 'portal.account', tags: ['account', 'lockout'],
    steps: ['Wait fifteen minutes: the lock is released on its own.', 'If it locks again at once, an old password is saved somewhere — usually on your phone\'s mail app.', 'Update the password on the phone, then try again.'] },
  { title: 'Register a new phone for multi-factor authentication', category: 'how-to', story: 'portal.account', tags: ['mfa', 'phone'],
    steps: ['From a company laptop, open «Security info» in your profile.', 'Add the new phone and scan the code with the authenticator app.', 'Remove the old phone from the list.'] },
  { title: 'Connect to the VPN from home', category: 'how-to', story: 'portal.vpn', tags: ['vpn', 'remote work'],
    steps: ['Start the VPN client from the tray and choose the «Company» profile.', 'Sign in with your company account and approve the request on your phone.', 'Wait for the green icon before opening the internal applications.'] },
  { title: 'VPN error 809: what it means and how to fix it', category: 'faq', story: 'portal.vpn', tags: ['vpn', 'error'],
    steps: ['Error 809 means that your network blocks the VPN protocol.', 'Switch to the «SSL» profile in the VPN client.', 'If it still fails, restart your home router and try again.'] },
  { title: 'Recreate your Outlook profile', category: 'how-to', story: 'portal.outlook', tags: ['outlook', 'e-mail'],
    steps: ['Close Outlook.', 'Open «Mail» in the Control Panel and choose «Show profiles».', 'Add a new profile with your company address and set it as the default.', 'Start Outlook: it downloads the mailbox again.'] },
  { title: 'Outlook crashes at startup: disable the add-ins', category: 'how-to', story: 'portal.outlook', tags: ['outlook', 'add-in'],
    steps: ['Start Outlook in safe mode (hold Ctrl while opening it).', 'Open «File → Options → Add-ins» and disable the ones you do not use.', 'Restart Outlook normally.'] },
  { title: 'Open a shared folder you were given access to', category: 'how-to', story: 'portal.drive', tags: ['shared drive', 'access'],
    steps: ['Access is granted to your account, not to your session: sign out and in again.', 'Open the folder from its full path, for example \\\\fs01\\finance\\reports.', 'Still denied? Check with your manager that the request was approved.'] },
  { title: 'Request access to a team folder', category: 'faq', story: 'portal.drive', tags: ['shared drive', 'request'],
    steps: ['Use «Shared Folder Access» in the catalog.', 'Give the full path and the level you need.', 'The folder\'s owner approves it; the access works from your next sign-in.'] },
  { title: 'Connect to the office Wi-Fi', category: 'how-to', story: 'portal.wifi', tags: ['wi-fi', 'network'],
    steps: ['Choose the «CORP» network, not «GUEST».', 'Sign in with your company account.', 'Accept the certificate of the company when it is shown the first time.'] },
  { title: 'Wi-Fi keeps dropping: update the driver', category: 'how-to', story: 'portal.wifi', tags: ['wi-fi', 'driver'],
    steps: ['Open «Software Center».', 'Install the update «Wireless driver» if it is listed.', 'Restart the laptop.'] },
  { title: 'Add a network printer', category: 'how-to', story: 'portal.printer', tags: ['printer'],
    steps: ['Open «Printers & scanners» and choose «Add a printer».', 'Pick the printer by the label on it (floor and area).', 'Print a test page.'] },
  { title: 'Clear a stuck print queue', category: 'how-to', story: 'portal.printer', tags: ['printer', 'queue'],
    steps: ['Open the printer\'s queue and cancel every job.', 'Turn the printer off and on again.', 'Send the document again.'] },
  { title: 'Fix audio and camera in video meetings', category: 'how-to', story: 'portal.meetings', tags: ['meetings', 'audio'],
    steps: ['In the meeting settings choose the headset as microphone and speaker.', 'Close the other applications that use the camera.', 'Update the headset driver from Software Center if the sound drops.'] },
  { title: 'Share your screen in a meeting', category: 'faq', story: 'portal.meetings', tags: ['meetings', 'screen sharing'],
    steps: ['Choose «Share» and pick the window, not the whole screen.', 'On macOS allow screen recording for the meeting app in the privacy settings.'] },
  { title: 'Open large Excel files without freezing', category: 'how-to', story: 'portal.excel', tags: ['excel'],
    steps: ['Check that you use the 64-bit version («File → Account → About Excel»).', 'If not, install «Office 64-bit» from Software Center.', 'Turn automatic calculation off while the file loads.'] },
  { title: 'Enable a signed macro', category: 'faq', story: 'portal.excel', tags: ['excel', 'macro'],
    steps: ['Only macros signed by the company run.', 'Ask the owner of the file to have it signed through the «New Report» request.'] },
  { title: 'Set up a second monitor on the docking station', category: 'how-to', story: 'portal.screen', tags: ['monitor', 'docking station'],
    steps: ['Connect the monitor to the docking station, not to the laptop.', 'Open «Display settings» and choose «Extend these displays».', 'If it stays black, update the dock firmware (see the related article).'] },
  { title: 'Update the docking station firmware', category: 'how-to', story: 'portal.screen', tags: ['docking station', 'firmware'],
    steps: ['Connect the laptop to the dock and to power.', 'Install «Dock firmware» from Software Center.', 'Do not unplug the dock until the lights stop blinking.'] },
  { title: 'Re-enrol your company phone for e-mail', category: 'how-to', story: 'portal.phone', tags: ['phone', 'e-mail'],
    steps: ['Open the company portal app on the phone.', 'Choose «Check status» and follow the steps it shows.', 'Your mail profile is pushed again within ten minutes.'] },
  { title: 'Move the authenticator app to a new phone', category: 'how-to', story: 'portal.phone', tags: ['mfa', 'phone'],
    steps: ['Before you change phone, register the new one in «Security info».', 'Sign in once with the new phone.', 'Remove the old phone from the list.'] },
  { title: 'The timesheet page shows an error', category: 'faq', story: 'portal.app', tags: ['timesheet', 'browser'],
    steps: ['Disable the browser extensions for the company site.', 'Clear the cache and sign in again.', 'If the error says «missing role», open a request: your profile needs it after a reorganisation.'] },
  { title: 'Report a suspicious e-mail', category: 'how-to', story: 'portal.phishing', tags: ['security', 'phishing'],
    steps: ['Do not click links or open attachments.', 'Use the «Report phishing» button in Outlook.', 'Delete the e-mail after reporting it.'] },
  { title: 'You clicked a phishing link: what to do now', category: 'faq', story: 'portal.phishing', tags: ['security', 'phishing'],
    steps: ['Change your password at once from the portal.', 'Open an incident with category «Security» and say what you entered.', 'Security revokes your sessions and checks your mailbox.'] },
  { title: 'Your laptop does not start: first checks', category: 'how-to', story: 'portal.laptop', tags: ['laptop', 'hardware'],
    steps: ['Plug in the charger and wait five minutes.', 'Hold the power button for 15 seconds, then press it again.', 'If nothing lights up, bring it to the IT desk: a loaner is ready.'] },
  { title: 'Get a replacement laptop', category: 'faq', story: 'portal.laptop', tags: ['laptop', 'request'],
    steps: ['Use «New Laptop» in the catalog and tick «Replaces an existing laptop».', 'Your manager approves it; the IT desk calls you to hand it over.'] },
]

export interface SimulatedArticle {
  id: string
  trail: TicketTrail
  props: Record<string, unknown>
  versions: Array<Record<string, unknown>>
  approvals: Array<Record<string, unknown>>
  writtenFrom: string[]
}

const CATEGORY_OF: Readonly<Record<string, string>> = { hardware: 'hardware', software: 'software', network: 'network', security: 'security', access: 'security', other: 'general' }

/** The KB category a known error is filed under: the problem's own, an access problem under security, «other» under general. */
function kbCategoryOf(k: KnownErrorFact): string {
  const category = CATEGORY_OF[k.category]
  if (!category) throw new Error(`planKnowledgeBase: the category "${k.category}" of ${k.number} has no knowledge base category`)
  return category
}

/** The article's own body, as markdown sections. */
function knownErrorBody(k: KnownErrorFact, full: boolean): string {
  const parts = [`## Symptoms\n${k.description}`, `## Workaround\n${k.workaround}`]
  if (full) parts.push(`## Cause\n${k.rootCause}`, `Known error ${k.number}, on ${k.ciName}.`)
  return parts.join('\n\n')
}

function howToBody(h: HowTo, full: boolean): string {
  const steps = full ? h.steps : h.steps.slice(0, Math.max(1, h.steps.length - 1))
  return steps.map((s, i) => `${String(i + 1)}. ${s}`).join('\n')
}

interface Draft {
  id: string
  title: string
  category: string
  tags: string[]
  body: (full: boolean) => string
  author: PlannedUser
  createdAtMs: number
  /** Readers a day, roughly: how-tos are read from the portal, known errors by the engineers. */
  readsPerDay: number
  writtenFrom: string[]
  /** Written with «Draft from incident»: the model wrote it from `writtenFrom[0]` (D52). */
  draftedByAI?: boolean
  /** Who it is for (24 Sep 2026): a known error for the staff, a how-to or a FAQ for everyone. */
  audience: 'staff' | 'everyone'
}

/**
 * THE AI DRAFTS (tour of 23 Sep 2026, D52).
 *
 * The organization turned the AI on some months ago, and since then most
 * known errors start from «Draft from incident» (`createKbDraftFromIncident`):
 * the model writes the article from ONE incident, the engineer edits it and
 * sends it for review. The Audit Log says so with its own entry — the one the
 * «AI actions» section of the daily-work page counts — and the article is
 * written from that incident only, as the mutation links it.
 */
export const AI_SINCE_DAYS = 270
const AI_DRAFT_SHARE = 0.6

interface Review { approver: PlannedUser; request: Record<string, unknown> }

/**
 * Sent for review (`pending_review`): the administrators get an approval
 * request, one of them will answer it — never the author, who does not
 * approve their own article (24 Sep 2026), as `createStepApprovalRequest`
 * leaves them out.
 */
function openReview(
  rng: Rng, trail: TicketTrail, d: Draft, at: number, author: ReturnType<World['actor']>,
  admins: readonly PlannedUser[], approvals: Array<Record<string, unknown>>,
): Review {
  trail.transition('pending_review', at, author, 'manual', null)
  const approvers = admins.filter((a) => a.id !== d.author.id)
  if (!approvers.length) throw new Error(`Demo tenant: the article "${d.title}" has no administrator other than its author to approve it`)
  const approver = rng.pick(approvers)
  const request = { id: rng.uuid(), entity_type: 'kb_article', entity_id: d.id, title: `Publication: ${d.title}`, description: null,
    status: 'pending', requested_by: d.author.id, requested_at: new Date(at).toISOString(), approvers: JSON.stringify(approvers.map((a) => a.id)),
    approved_by: '[]', rejected_by: null, approval_type: 'any', due_date: null, resolved_at: null, resolution_note: null }
  approvals.push(request)
  return { approver, request }
}

/** One article's life on its trail: edits, review with its approval, publication, reading, archiving. */
function liveArticle(rng: Rng, w: World, d: Draft, admins: readonly PlannedUser[]): SimulatedArticle {
  const def = w.workflows.forTicket('kb_article', null)
  const trail = new TicketTrail(w.trail, 'kb_article', d.id, def, d.createdAtMs)
  const now = w.clock.nowMs
  const cap = now - 10 * MINUTE
  const author = w.actor(d.author.id)
  const versions: Array<Record<string, unknown>> = []
  const approvals: Array<Record<string, unknown>> = []
  let editor = { id: d.author.id, name: d.author.email, at: d.createdAtMs }
  let full = false
  trail.audit(d.createdAtMs, author, 'kb_article.created')
  if (d.draftedByAI) trail.audit(d.createdAtMs, author, 'kb_article.drafted_by_ai', { incidentId: d.writtenFrom[0] })
  /** `updateKBArticle`: the text as it was becomes a version, the article moves on. */
  const edit = (at: number, by: PlannedUser): void => {
    versions.push({ id: rng.uuid(), article_id: d.id, version: versions.length + 1, title: d.title, body: d.body(full), category: d.category,
      tags: JSON.stringify(d.tags), edited_by: editor.id, edited_by_name: editor.name, edited_at: new Date(editor.at).toISOString() })
    full = true
    editor = { id: by.id, name: by.email, at }
    trail.updatedAtMs = at
    trail.lastEventMs = Math.max(trail.lastEventMs, at)
    trail.audit(at, w.actor(by.id), 'kb_article.updated')
  }
  const age = now - d.createdAtMs
  let t = Math.min(d.createdAtMs + rng.int(1, 48) * HOUR, cap)
  if (age > 2 * DAY || rng.chance(0.5)) edit(t, d.author)
  let publishedAt: number | null = null
  const review = (at: number): Review => openReview(rng, trail, d, at, author, admins, approvals)
  if (age > 5 * DAY || rng.chance(0.4)) {
    t = Math.max(Math.min(t + rng.int(2, 72) * HOUR, cap), trail.lastEventMs + MINUTE)
    let r = review(t)
    // Sent back now and then: the reviewer asks for one more thing, the author adds it.
    if (age > 10 * DAY && rng.chance(0.1)) {
      t = Math.min(t + rng.int(4, 48) * HOUR, cap)
      const note = rng.pick(['Add the steps for the Mac users.', 'Say who to call if it does not work.', 'Remove the internal server names.'])
      Object.assign(r.request, { status: 'rejected', rejected_by: r.approver.id, resolved_at: new Date(t).toISOString(), resolution_note: note })
      trail.transition('draft', t, w.actor(r.approver.id), 'manual', note)
      trail.audits.push(auditRow(rng, r.approver, 'approval.rejected', 'ApprovalRequest', r.request['id'] as string, t))
      trail.audit(t, w.actor(r.approver.id), 'kb_article.publication_rejected')
      t = Math.min(t + rng.int(2, 72) * HOUR, cap)
      edit(t, d.author)
      t = Math.max(Math.min(t + rng.int(1, 24) * HOUR, cap), trail.lastEventMs + MINUTE)
      r = review(t)
    }
    if (age > 7 * DAY || rng.chance(0.5)) {
      t = Math.max(Math.min(t + rng.int(2, 96) * HOUR, cap), trail.lastEventMs + MINUTE)
      Object.assign(r.request, { status: 'approved', approved_by: JSON.stringify([r.approver.id]), resolved_at: new Date(t).toISOString() })
      trail.audits.push(auditRow(rng, r.approver, 'approval.approved', 'ApprovalRequest', r.request['id'] as string, t))
      trail.transition('published', t, w.actor(r.approver.id), 'manual', null)
      publishedAt = t
    }
  }
  // An old article nobody needs any more is archived; a few more are corrected while published.
  if (publishedAt !== null && now - publishedAt > 540 * DAY && rng.chance(0.08)) {
    t = Math.max(publishedAt + rng.int(300, 500) * DAY, trail.lastEventMs + MINUTE)
    if (t < cap) trail.transition('archived', t, w.actor(rng.pick(admins).id), 'manual', null)
  } else if (publishedAt !== null && rng.chance(0.2)) {
    t = Math.max(Math.min(publishedAt + rng.int(20, 400) * DAY, cap), trail.lastEventMs + MINUTE)
    if (t < cap) edit(t, d.author)
  }
  const liveDays = publishedAt === null ? 0 : (now - publishedAt) / DAY
  const views = Math.round(liveDays * d.readsPerDay * rng.float(0.5, 1.6))
  const props = {
    id: d.id, title: d.title, slug: `${d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${d.id.slice(0, 8)}`,
    body: d.body(full), category: d.category, tags: JSON.stringify(d.tags), status: trail.current.name, audience: d.audience,
    author_id: d.author.id, author_name: d.author.email, views, helpful_count: Math.round(views * rng.float(0.04, 0.12)),
    not_helpful_count: Math.round(views * rng.float(0.005, 0.02)), version: versions.length + 1,
    last_edited_by: editor.id, last_edited_by_name: editor.name, last_edited_at: new Date(editor.at).toISOString(),
    created_at: new Date(d.createdAtMs).toISOString(), updated_at: new Date(Math.max(trail.updatedAtMs, d.createdAtMs)).toISOString(),
    published_at: publishedAt === null ? null : new Date(publishedAt).toISOString(),
  }
  return { id: d.id, trail, props, versions, approvals, writtenFrom: d.writtenFrom }
}

export function planKnowledgeBase(
  rng: Rng, w: World, knownErrors: readonly KnownErrorFact[],
  portalIncidents: ReadonlyArray<{ id: string; storyKey: string; createdAtMs: number }>,
): SimulatedArticle[] {
  const admins = w.people.users.filter((u) => u.role === 'admin')
  const now = w.clock.nowMs
  const drafts: Draft[] = []
  // Known errors: about half are written up, a few days after the workaround —
  // once per title: two problems with the same symptoms share the article
  // already written (tour of 24 Sep 2026, G5: two «Workaround: Certificates
  // renewed too late»).
  const written = new Set<string>()
  for (const k of knownErrors) {
    if (!rng.chance(0.45)) continue
    if (written.has(k.title)) continue
    const createdAtMs = Math.min(k.knownAtMs + rng.int(1, 10) * DAY, now - HOUR)
    if (createdAtMs <= k.knownAtMs) continue
    const category = k.ciLabel === 'Database' || k.ciLabel === 'DatabaseInstance' ? 'database' : kbCategoryOf(k)
    const draftedByAI = createdAtMs >= now - AI_SINCE_DAYS * DAY && k.incidentIds.length > 0 && rng.chance(AI_DRAFT_SHARE)
    written.add(k.title)
    drafts.push({
      id: rng.uuid(), title: `Workaround: ${k.title}`, category, tags: ['known error', k.ciLabel.toLowerCase()],
      body: (full) => knownErrorBody(k, full), author: w.usersById.get(k.authorId)!, createdAtMs, readsPerDay: rng.float(0.05, 0.6),
      writtenFrom: draftedByAI ? k.incidentIds.slice(0, 1) : k.incidentIds.slice(0, 3), draftedByAI, audience: 'staff',
    })
  }
  // How-tos: the service desk writes one for each question people keep asking, over the years.
  const desks = w.supportTeams.filter((t) => t.area === 'Service Desk')
  const at = arrivalInstants(rng, w.clock, HOW_TOS.length, w.clock.startMs + 30 * DAY, now - 2 * DAY)
  HOW_TOS.forEach((h, i) => {
    const createdAtMs = at[i]!
    const desk = rng.pick(desks.length ? desks : w.supportTeams)
    const answered = portalIncidents.filter((p) => p.storyKey === h.story && p.createdAtMs < createdAtMs).slice(-rng.int(1, 3)).map((p) => p.id)
    drafts.push({
      id: rng.uuid(), title: h.title, category: h.category, tags: h.tags, body: (full) => howToBody(h, full),
      author: w.memberOf(rng, desk.id, createdAtMs), createdAtMs, readsPerDay: rng.float(1, 8), writtenFrom: answered, audience: 'everyone',
    })
  })
  return drafts.sort((a, b) => a.createdAtMs - b.createdAtMs).map((d) => liveArticle(rng.fork(`kb/${d.id}`), w, d, admins))
}

export async function writeKnowledgeBase(w: DemoWriter, articles: readonly SimulatedArticle[]): Promise<void> {
  await w.nodes(['KBArticle'], articles.map((a) => a.props))
  await w.nodes(['WorkflowInstance'], articles.map((a) => a.trail.instanceProps()))
  await w.relationships('KBArticle', 'HAS_WORKFLOW', 'WorkflowInstance', articles.map((a) => ({ from: a.id, to: a.trail.instanceId })))
  await w.relationships('WorkflowInstance', 'CURRENT_STEP', 'WorkflowStep', articles.map((a) => ({ from: a.trail.instanceId, to: a.trail.current.id })))
  await w.children('WorkflowInstance', 'STEP_HISTORY', ['WorkflowStepExecution'],
    articles.flatMap((a) => a.trail.executions.map((e) => ({ parent: a.trail.instanceId, props: { ...e } }))))
  await w.children('KBArticle', 'HAS_VERSION', ['KBArticleVersion'], articles.flatMap((a) => a.versions.map((v) => ({ parent: a.id, props: v }))))
  await w.nodes(['ApprovalRequest'], articles.flatMap((a) => a.approvals))
  await w.relationships('KBArticle', 'WRITTEN_FROM', 'Incident', articles.flatMap((a) => a.writtenFrom.map((i) => ({ from: a.id, to: i }))))
  await w.nodes(['AuditEntry'], articles.flatMap((a) => a.trail.audits))
}
