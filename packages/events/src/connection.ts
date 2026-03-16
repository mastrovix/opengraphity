import amqp, { ChannelModel } from 'amqplib'

const RABBITMQ_URL =
  process.env['RABBITMQ_URL'] ?? 'amqp://opengraphity:opengraphity_local@localhost:5672'

const MAX_ATTEMPTS = 10
const MAX_BACKOFF_MS = 30_000

function backoffMs(attempt: number): number {
  return Math.min(1_000 * Math.pow(2, attempt - 1), MAX_BACKOFF_MS)
}

let _model: ChannelModel | null = null
let _connectPromise: Promise<ChannelModel> | null = null
let _closing = false

async function connect(attempt = 1): Promise<ChannelModel> {
  console.log(`[rabbitmq] Connecting to ${RABBITMQ_URL} (attempt ${attempt}/${MAX_ATTEMPTS})`)

  try {
    const model = await amqp.connect(RABBITMQ_URL)

    model.on('error', (err: Error) => {
      console.error('[rabbitmq] Connection error:', err.message)
    })

    model.on('close', () => {
      _model = null
      _connectPromise = null
      if (_closing) return
      console.warn('[rabbitmq] Connection closed — scheduling reconnect...')
      setTimeout(() => {
        getConnection().catch((err: unknown) => {
          console.error('[rabbitmq] Reconnect failed:', err)
        })
      }, 1_000)
    })

    console.log('[rabbitmq] Connected successfully')
    return model
  } catch (err) {
    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(
        `[rabbitmq] Fatal: could not connect after ${MAX_ATTEMPTS} attempts. Last error: ${String(err)}`,
      )
    }
    const delay = backoffMs(attempt)
    console.warn(`[rabbitmq] Attempt ${attempt} failed, retrying in ${delay}ms...`)
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    return connect(attempt + 1)
  }
}

export async function getConnection(): Promise<ChannelModel> {
  if (_model) return _model

  if (_connectPromise) return _connectPromise

  _connectPromise = connect()
    .then((model) => {
      _model = model
      _connectPromise = null
      return model
    })
    .catch((err: unknown) => {
      _connectPromise = null
      throw err
    })

  return _connectPromise
}

let _closePromise: Promise<void> | null = null

export async function closeConnection(): Promise<void> {
  if (_closePromise) return _closePromise
  if (!_model) return

  _closing = true
  _closePromise = _model.close()
    .then(() => {
      _model = null
      _connectPromise = null
      _closePromise = null
      console.log('[rabbitmq] Connection closed')
    })
    .catch(() => {
      _model = null
      _connectPromise = null
      _closePromise = null
    })
  return _closePromise
}
