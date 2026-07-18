import { Resend } from 'resend'

const DEFAULT_FROM = process.env['EMAIL_FROM'] || 'OpenGrafo <onboarding@resend.dev>'
const RESEND_API_KEY = process.env['RESEND_API_KEY']

let _resend: Resend | null = null

const isMock = !RESEND_API_KEY

// Mock mode is a dev convenience only. In production a missing API key would
// silently route every email to the console with a single startup warn —
// that is a config error, not a mode.
if (isMock && process.env['NODE_ENV'] === 'production') {
  throw new Error('[email] RESEND_API_KEY is not set in production — emails would be silently discarded')
}
if (isMock) {
  console.warn('[email] RESEND_API_KEY not set — running in mock mode')
}

function getResend(): Resend {
  if (!_resend) {
    _resend = new Resend(RESEND_API_KEY)
  }
  return _resend
}

export interface EmailMessage {
  to: string | string[]
  subject: string
  html: string
  from?: string
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const from = msg.from ?? DEFAULT_FROM
  const to = Array.isArray(msg.to) ? msg.to : [msg.to]

  if (isMock) {
    console.log(`[email:mock] To: ${to.join(', ')} | Subject: ${msg.subject}`)
    return
  }

  try {
    const { error } = await getResend().emails.send({
      from,
      to,
      subject: msg.subject,
      html: msg.html,
    })

    if (error) {
      throw new Error(error.message)
    }

    console.log(`[email] Sent to ${to.join(', ')} | Subject: ${msg.subject}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[email] Failed to send to ${to.join(', ')} | Subject: ${msg.subject} — ${message}`)
    throw err
  }
}
