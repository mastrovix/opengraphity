import { fmtDateTime } from '@/lib/format'

interface Props {
  body:        string
  authorName:  string
  authorEmail: string
  createdAt:   string
  isOwn:       boolean   // true = utente corrente (destra), false = agente IT (sinistra)
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
        {authorName || 'Agente IT'} · {fmtDateTime(createdAt)}
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
