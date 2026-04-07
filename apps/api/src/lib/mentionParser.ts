/**
 * Parses @mentions from comment/message bodies.
 * Format: @[Display Name](userId)
 * Returns array of extracted userIds.
 */

const MENTION_RE = /@\[([^\]]+)\]\(([^)]+)\)/g

export function parseMentions(body: string): string[] {
  const ids: string[] = []
  let match
  while ((match = MENTION_RE.exec(body)) !== null) {
    const userId = match[2]
    if (userId && !ids.includes(userId)) ids.push(userId)
  }
  return ids
}
