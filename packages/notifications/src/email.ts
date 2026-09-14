import { Resend } from 'resend'

const EMAIL_FROM = process.env['EMAIL_FROM']
/**
 * Il mittente di sviluppo, dichiarato: vale SOLO fuori produzione. Prima era il
 * ripiego di `EMAIL_FROM` anche in produzione, cioè le e-mail di un cliente
 * partivano in silenzio da un indirizzo di prova (verifica «Cosa resta
 * cablato», ondata 1). Lo stesso contratto di `config.emailFrom` nell'API.
 */
const DEVELOPMENT_FROM = 'OpenGrafo <onboarding@resend.dev>'
const RESEND_API_KEY = process.env['RESEND_API_KEY']

let _resend: Resend | null = null

const isMock = !RESEND_API_KEY

const MISSING_KEY_IN_PRODUCTION = '[email] RESEND_API_KEY is not set in production — emails would be silently discarded'
const MISSING_FROM_IN_PRODUCTION = '[email] EMAIL_FROM is not set in production — emails would leave from a test address'
const isProduction = process.env['NODE_ENV'] === 'production'

// Mock mode is a dev convenience only. In production a missing API key is a
// config error, not a mode — but it is raised where email is SENT, not at
// import: processes that never send (the workers) import this package too, and
// a throw here put them in a restart loop. The API calls
// `assertEmailConfigured()` at boot, and `sendEmail` refuses at the call.
if (isMock && !isProduction) {
  console.warn('[email] RESEND_API_KEY not set — running in mock mode')
}

/** Throws in production when no API key is configured. For the boot of processes that send email. */
export function assertEmailConfigured(): void {
  if (isMock && isProduction) throw new Error(MISSING_KEY_IN_PRODUCTION)
  if (!EMAIL_FROM && isProduction) throw new Error(MISSING_FROM_IN_PRODUCTION)
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
  const to = Array.isArray(msg.to) ? msg.to : [msg.to]

  assertEmailConfigured()
  const from = msg.from ?? EMAIL_FROM ?? DEVELOPMENT_FROM
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
