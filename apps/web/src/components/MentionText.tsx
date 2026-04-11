import React from 'react'

interface Props {
  text: string
}

const mentionRegex = /@\[([^\]]+)\]\(([^)]+)\)/g

const badgeStyle: React.CSSProperties = {
  background: '#e0f2fe',
  color: '#0369a1',
  padding: '1px 4px',
  borderRadius: 4,
  fontWeight: 600,
  fontSize: 'var(--font-size-body)',
}

export function MentionText({ text }: Props) {
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // Reset regex state
  mentionRegex.lastIndex = 0

  while ((match = mentionRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index))
    }
    const name = match[1]
    const userId = match[2]
    parts.push(
      <span key={`${userId}-${match.index}`} style={badgeStyle} title={userId}>
        {name}
      </span>
    )
    lastIndex = match.index + match[0].length
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return <span>{parts}</span>
}
