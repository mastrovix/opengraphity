import { Resend } from 'resend'
import { brandedFrom } from '@opengraphity/types'

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

/**
 * `EMAIL_SEND_DISABLED`: QUESTA INSTALLAZIONE NON MANDA POSTA (18 set 2026).
 *
 * Mancava, e si è visto: su uno stack di prova l'unico modo di fermare le
 * e-mail era spegnere a mano ogni regola di notifica di ogni tenant — e un
 * tenant creato il giorno dopo ricominciava, perché il provisioning semina
 * `digest.daily` attiva. Togliere la chiave non è un modo: in produzione
 * `assertEmailConfigured` si rifiuta di avviare, di proposito, perché una
 * chiave mancante è un errore di configurazione e non una modalità.
 *
 * Questo interruttore È una modalità, e per questo va DICHIARATA: si scrive
 * nell'ambiente, si annuncia all'avvio e ogni messaggio soppresso lascia una
 * riga con destinatario e oggetto. Un interruttore del genere fa danno in un
 * modo solo — che qualcuno scopra fra sei mesi che le notifiche non uscivano —
 * e quel modo si chiude parlando.
 *
 * Un valore che non è né vero né falso NON diventa «falso» in silenzio: è un
 * errore di configurazione, e scegliere per conto di chi l'ha scritto vorrebbe
 * dire mandare posta a un'installazione che credeva di averla spenta.
 */
export function leggiInterruttore(raw: string | undefined): boolean {
  if (raw === undefined || raw.trim() === '') return false
  const v = raw.trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(v)) return true
  if (['false', '0', 'no', 'off'].includes(v)) return false
  throw new Error(
    `[email] EMAIL_SEND_DISABLED must be true or false (got "${raw}"): ` +
    'an unrecognised value is not "send anyway".',
  )
}

export const EMAIL_SEND_DISABLED = leggiInterruttore(process.env['EMAIL_SEND_DISABLED'])

/** Niente invio vero: o perché è stato spento, o perché non c'è una chiave (fuori produzione). */
const isMock = EMAIL_SEND_DISABLED || !RESEND_API_KEY

const MISSING_KEY_IN_PRODUCTION = '[email] RESEND_API_KEY is not set in production — emails would be silently discarded'
const MISSING_FROM_IN_PRODUCTION = '[email] EMAIL_FROM is not set in production — emails would leave from a test address'
const isProduction = process.env['NODE_ENV'] === 'production'

// Mock mode is a dev convenience only. In production a missing API key is a
// config error, not a mode — but it is raised where email is SENT, not at
// import: processes that never send (the workers) import this package too, and
// a throw here put them in a restart loop. The API calls
// `assertEmailConfigured()` at boot, and `sendEmail` refuses at the call.
if (EMAIL_SEND_DISABLED) {
  // A voce alta e in OGNI ambiente, produzione compresa: è la riga che evita
  // la scoperta tardiva.
  console.warn('[email] EMAIL_SEND_DISABLED=true — this installation sends NO email: every message is logged and discarded')
} else if (isMock && !isProduction) {
  console.warn('[email] RESEND_API_KEY not set — running in mock mode')
}

/** Throws in production when no API key is configured. For the boot of processes that send email. */
export function assertEmailConfigured(): void {
  /*
   * Spento per scelta: non manca niente. La chiave e il mittente servono a
   * chi manda, e qui non si manda — pretenderli qui vorrebbe dire che per
   * spegnere la posta bisogna prima configurarla, che è la forma più pura di
   * una richiesta senza motivo.
   */
  if (EMAIL_SEND_DISABLED) return
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
  /** Il nome del mittente scelto dall'organizzazione (l'indirizzo resta quello della piattaforma). */
  senderName?: string
  /** Dove vanno le risposte, se l'organizzazione l'ha scelto. */
  replyTo?: string | null
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const to = Array.isArray(msg.to) ? msg.to : [msg.to]

  assertEmailConfigured()
  const platformFrom = msg.from ?? EMAIL_FROM ?? DEVELOPMENT_FROM
  const from = msg.senderName ? brandedFrom(platformFrom, msg.senderName) : platformFrom
  if (EMAIL_SEND_DISABLED) {
    // Non «mock»: la parola dice che è stato SOPPRESSO, e da quale
    // interruttore. Chi legge i log di uno stack che non manda posta deve
    // trovare il perché nella riga, non in un file di configurazione.
    console.log(`[email:disabled] suppressed (EMAIL_SEND_DISABLED) | To: ${to.join(', ')} | Subject: ${msg.subject}`)
    return
  }
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
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
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
