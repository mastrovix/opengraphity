/**
 * THE ACTUAL SEND, and the three ways it does not happen.
 *
 * `emailConfig.test.ts` pins when the module refuses to send; this one pins
 * what it does when it DOES send: what reaches the provider, and what every
 * failure leaves behind.
 *
 * The recurring theme is that a message never leaves silently. Suppressed by
 * the switch, discarded in mock, or rejected by the provider — each case
 * writes a line naming recipient and subject, and the last one throws so the
 * calling job fails and can retry. An e-mail that vanishes with a green
 * checkmark is the failure mode this module exists to avoid.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const send = vi.hoisted(() => vi.fn(async () => ({ error: null as { message: string } | null })))
vi.mock('resend', () => ({ Resend: class { emails = { send } } }))

async function freshEmailModule(env: { NODE_ENV?: string; RESEND_API_KEY?: string; EMAIL_FROM?: string; EMAIL_SEND_DISABLED?: string }) {
  vi.resetModules()
  vi.stubEnv('NODE_ENV', env.NODE_ENV ?? 'test')
  vi.stubEnv('RESEND_API_KEY', env.RESEND_API_KEY ?? '')
  vi.stubEnv('EMAIL_FROM', env.EMAIL_FROM ?? '')
  vi.stubEnv('EMAIL_SEND_DISABLED', env.EMAIL_SEND_DISABLED ?? '')
  return import('../email.js')
}

/** A module configured to really send. */
const sending = () => freshEmailModule({ RESEND_API_KEY: 're_key', EMAIL_FROM: 'OpenGrafo <no-reply@opengrafo.example>' })

beforeEach(() => {
  send.mockClear()
  send.mockResolvedValue({ error: null })
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.unstubAllEnvs() })

describe('sendEmail — what reaches the provider', () => {
  it('passes recipients, subject and html, and a single recipient becomes a list', async () => {
    const { sendEmail } = await sending()
    await sendEmail({ to: 'anna@acme.example', subject: 'INC-1 assigned', html: '<p>x</p>' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      to: ['anna@acme.example'], subject: 'INC-1 assigned', html: '<p>x</p>',
      from: 'OpenGrafo <no-reply@opengrafo.example>',
    }))
  })

  it('several recipients go through as they are', async () => {
    const { sendEmail } = await sending()
    await sendEmail({ to: ['a@x.example', 'b@x.example'], subject: 's', html: 'h' })
    expect((send.mock.calls[0]![0] as { to: string[] }).to).toEqual(['a@x.example', 'b@x.example'])
  })

  it('the organization name replaces the sender NAME, never the address', async () => {
    // The address stays the platform's because that is the domain whose SPF
    // and DKIM records we control: swapping it makes every message fail
    // authentication at the receiver.
    const { sendEmail } = await sending()
    await sendEmail({ to: 'a@x.example', subject: 's', html: 'h', senderName: 'Acme Support' })
    expect((send.mock.calls[0]![0] as { from: string }).from).toBe('Acme Support <no-reply@opengrafo.example>')
  })

  it('an explicit `from` wins over EMAIL_FROM', async () => {
    const { sendEmail } = await sending()
    await sendEmail({ to: 'a@x.example', subject: 's', html: 'h', from: 'Other <other@opengrafo.example>' })
    expect((send.mock.calls[0]![0] as { from: string }).from).toBe('Other <other@opengrafo.example>')
  })

  it('reply_to is passed only when the organization chose one', async () => {
    const { sendEmail } = await sending()
    await sendEmail({ to: 'a@x.example', subject: 's', html: 'h', replyTo: 'help@acme.example' })
    expect(send.mock.calls[0]![0]).toMatchObject({ reply_to: 'help@acme.example' })

    send.mockClear()
    await sendEmail({ to: 'a@x.example', subject: 's', html: 'h', replyTo: null })
    expect(send.mock.calls[0]![0]).not.toHaveProperty('reply_to')
  })

  it('attachments are passed with their bytes, and contentType only when given', async () => {
    const { sendEmail } = await sending()
    const content = Buffer.from('report')
    await sendEmail({
      to: 'a@x.example', subject: 's', html: 'h',
      attachments: [{ filename: 'report.pdf', content, contentType: 'application/pdf' }, { filename: 'raw.csv', content }],
    })
    expect((send.mock.calls[0]![0] as { attachments: unknown[] }).attachments).toEqual([
      { filename: 'report.pdf', content, contentType: 'application/pdf' },
      { filename: 'raw.csv', content },
    ])
  })

  it('an empty attachment list is not sent as an empty array', async () => {
    const { sendEmail } = await sending()
    await sendEmail({ to: 'a@x.example', subject: 's', html: 'h', attachments: [] })
    expect(send.mock.calls[0]![0]).not.toHaveProperty('attachments')
  })

  it('outside production with no API key nothing is sent, and the mock line names the attachments too', async () => {
    // "The e-mail went out" without saying whether it carried the file is
    // half the information, and the scheduled report is exactly the case.
    const { sendEmail } = await freshEmailModule({})
    await sendEmail({ to: 'a@x.example', subject: 'Weekly report', html: 'h', attachments: [{ filename: 'r.pdf', content: Buffer.from('x') }] })
    expect(send).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[email:mock] To: a@x.example | Subject: Weekly report | Attachments: r.pdf'))
  })

  it('with the switch on nothing is sent, and the line says SUPPRESSED and by which switch', async () => {
    // Not the word "mock": whoever reads the logs of a stack that sends no
    // mail must find the reason in the line, not in a config file.
    const { sendEmail } = await freshEmailModule({ EMAIL_SEND_DISABLED: 'true', RESEND_API_KEY: 're_key' })
    await sendEmail({ to: 'a@x.example', subject: 'INC-1', html: 'h' })
    expect(send).not.toHaveBeenCalled()
    expect(console.log).toHaveBeenCalledWith('[email:disabled] suppressed (EMAIL_SEND_DISABLED) | To: a@x.example | Subject: INC-1')
  })
})

describe('sendEmail — when it fails', () => {
  it('a provider error THROWS with the provider message, after logging recipient and subject', async () => {
    send.mockResolvedValueOnce({ error: { message: 'domain is not verified' } })
    const { sendEmail } = await sending()
    await expect(sendEmail({ to: 'a@x.example', subject: 'INC-1', html: 'h' })).rejects.toThrow('domain is not verified')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('[email] Failed to send to a@x.example | Subject: INC-1 — domain is not verified'))
  })

  it('a network failure propagates too: the calling job must fail', async () => {
    send.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const { sendEmail } = await sending()
    await expect(sendEmail({ to: 'a@x.example', subject: 's', html: 'h' })).rejects.toThrow('ETIMEDOUT')
  })

  it('a rejection that is not an Error is still readable in the log line', async () => {
    send.mockRejectedValueOnce('provider gone')
    const { sendEmail } = await sending()
    await expect(sendEmail({ to: 'a@x.example', subject: 's', html: 'h' })).rejects.toBe('provider gone')
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('— provider gone'))
  })

  it('a successful send is logged with recipient and subject', async () => {
    const { sendEmail } = await sending()
    await sendEmail({ to: 'a@x.example', subject: 'INC-1', html: 'h' })
    expect(console.log).toHaveBeenCalledWith('[email] Sent to a@x.example | Subject: INC-1')
  })

  it('the Resend client is built once and reused across sends', async () => {
    // One client per message would open a new connection pool every time.
    const { sendEmail } = await sending()
    await sendEmail({ to: 'a@x.example', subject: '1', html: 'h' })
    await sendEmail({ to: 'a@x.example', subject: '2', html: 'h' })
    expect(send.mock.instances[0]).toBe(send.mock.instances[1])
  })
})
