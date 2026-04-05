interface Props {
  body:        string
  authorName:  string
  authorEmail: string
  createdAt:   string
  isOwn:       boolean   // true = utente corrente (destra), false = agente IT (sinistra)
}

function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('it-IT', {
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso))
  } catch {
    return iso
  }
}

export function CommentBubble({ body, authorName, createdAt, isOwn }: Props) {
  return (
    <div style={{
      display:       'flex',
      flexDirection: 'column',
      alignItems:    isOwn ? 'flex-end' : 'flex-start',
      marginBottom:  12,
    }}>
      <div style={{
        fontSize:  11,
        color:     '#94A3B8',
        marginBottom: 4,
        textAlign: isOwn ? 'right' : 'left',
      }}>
        {authorName || 'Agente IT'} · {fmtDate(createdAt)}
      </div>
      <div style={{
        maxWidth:        '75%',
        padding:         '10px 14px',
        borderRadius:    isOwn ? '12px 4px 12px 12px' : '4px 12px 12px 12px',
        backgroundColor: isOwn ? '#F0F9FF' : '#F1F5F9',
        color:           '#0F172A',
        fontSize:        14,
        lineHeight:      1.6,
        whiteSpace:      'pre-wrap',
        wordBreak:       'break-word',
      }}>
        {body}
      </div>
    </div>
  )
}
