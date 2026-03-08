import { createHmac } from 'crypto'

export interface WebhookSubscription {
  id: string
  tenantId: string
  event: string
  url: string
  secret?: string
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex')
}

export async function dispatchWebhook(
  sub: WebhookSubscription,
  payload: unknown,
): Promise<void> {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }

  if (sub.secret) {
    headers['X-OpenGraphity-Signature'] = `sha256=${signPayload(body, sub.secret)}`
  }

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 10_000)

  try {
    const res = await fetch(sub.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    })

    console.log(
      `[webhook] Dispatched subscriptionId=${sub.id} url=${sub.url} event=${sub.event} — HTTP ${res.status}`,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(
      `[webhook] Failed subscriptionId=${sub.id} url=${sub.url} event=${sub.event} — ${message}`,
    )
    // Fire-and-forget: do not rethrow
  } finally {
    clearTimeout(timeoutId)
  }
}
