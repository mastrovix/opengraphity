const TEAMS_WEBHOOK_URL = process.env['TEAMS_WEBHOOK_URL']

if (!TEAMS_WEBHOOK_URL) {
  console.warn('[teams] TEAMS_WEBHOOK_URL not set — Teams notifications disabled')
}

export interface TeamsCard {
  title: string
  message: string
  /** Hex color: FF0000=critical, FFA500=high, FFFF00=medium, 00AA00=ok, 0078D4=info */
  color: 'FF0000' | 'FFA500' | 'FFFF00' | '00AA00' | '0078D4'
  facts?: Array<{ name: string; value: string }>
  link?: { text: string; url: string }
}

interface MessageCardSection {
  activityText: string
  facts?: Array<{ name: string; value: string }>
}

interface MessageCard {
  '@type': 'MessageCard'
  '@context': string
  summary: string
  themeColor: string
  title: string
  sections: MessageCardSection[]
  potentialAction?: Array<{
    '@type': 'OpenUri'
    name: string
    targets: Array<{ os: string; uri: string }>
  }>
}

export async function sendTeamsCard(card: TeamsCard): Promise<void> {
  if (!TEAMS_WEBHOOK_URL) {
    console.warn(`[teams] Skipping card "${card.title}" — webhook URL not configured`)
    return
  }

  const body: MessageCard = {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    summary: card.title,
    themeColor: card.color,
    title: card.title,
    sections: [
      {
        activityText: card.message,
        ...(card.facts ? { facts: card.facts } : {}),
      },
    ],
    ...(card.link
      ? {
          potentialAction: [
            {
              '@type': 'OpenUri',
              name: card.link.text,
              targets: [{ os: 'default', uri: card.link.url }],
            },
          ],
        }
      : {}),
  }

  // Fail-loud: a non-2xx or network error propagates — the calling job must
  // fail (and retry), not log "sent" on an HTTP 400.
  const res = await fetch(TEAMS_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`[teams] Webhook rejected card "${card.title}": HTTP ${res.status}`)
  }
  console.log(`[teams] Card sent: "${card.title}" — HTTP ${res.status}`)
}
