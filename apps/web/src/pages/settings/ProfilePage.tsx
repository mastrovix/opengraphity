import { useState } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'

const GET_ME = gql`
  query Me {
    me { id email name slackId }
  }
`

const LINK_SLACK = gql`
  mutation LinkSlack($slackId: String!) {
    linkSlackAccount(slackId: $slackId) { id slackId }
  }
`

const UNLINK_SLACK = gql`
  mutation UnlinkSlack {
    linkSlackAccount(slackId: "") { id slackId }
  }
`

export default function ProfilePage() {
  const [input, setInput] = useState('')
  const [saved, setSaved] = useState(false)

  const { data, refetch } = useQuery<{ me: { id: string; email: string; name: string; slackId?: string } }>(GET_ME)
  const slackId = data?.me?.slackId

  const [linkSlack, { loading: linking }] = useMutation(LINK_SLACK, {
    onCompleted: () => { setSaved(true); setInput(''); refetch() },
  })
  const [unlinkSlack, { loading: unlinking }] = useMutation(UNLINK_SLACK, {
    onCompleted: () => { refetch() },
  })

  const card: React.CSSProperties = {
    background:   '#fff',
    border:       '1px solid #e2e6f0',
    borderRadius: 10,
    padding:      '24px 28px',
    maxWidth:     480,
  }
  const label: React.CSSProperties = {
    display:    'block',
    fontSize:   12,
    fontWeight: 600,
    color:      '#374151',
    marginBottom: 6,
  }
  const inputStyle: React.CSSProperties = {
    width:        '100%',
    padding:      '8px 12px',
    border:       '1px solid #d1d5db',
    borderRadius: 6,
    fontSize:     13,
    outline:      'none',
    boxSizing:    'border-box',
  }
  const btn: React.CSSProperties = {
    padding:      '8px 18px',
    borderRadius: 6,
    border:       'none',
    background:   '#4f46e5',
    color:        '#fff',
    fontSize:     13,
    fontWeight:   600,
    cursor:       'pointer',
  }
  const btnGhost: React.CSSProperties = {
    ...btn,
    background: 'transparent',
    border:     '1px solid #d1d5db',
    color:      '#374151',
  }

  return (
    <div style={{ padding: '32px 40px', maxWidth: 640 }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, color: '#0f1629', margin: '0 0 24px' }}>
        Profilo
      </h1>

      <div style={card}>
        <h2 style={{ fontSize: 15, fontWeight: 700, color: '#0f1629', margin: '0 0 6px' }}>
          Integrazione Slack
        </h2>
        <p style={{ fontSize: 13, color: '#6b7280', margin: '0 0 20px', lineHeight: 1.5 }}>
          Collega il tuo account Slack per poter eseguire azioni sugli incident
          direttamente da Slack.
        </p>

        {slackId ? (
          <div>
            <div style={{
              display:      'flex',
              alignItems:   'center',
              gap:          8,
              padding:      '10px 14px',
              background:   '#f0fdf4',
              border:       '1px solid #bbf7d0',
              borderRadius: 6,
              marginBottom: 12,
            }}>
              <span style={{ fontSize: 13, color: '#15803d', fontWeight: 500 }}>
                ✓ Account collegato: <code style={{ fontFamily: 'monospace' }}>{slackId}</code>
              </span>
            </div>
            <button
              style={btnGhost}
              disabled={unlinking}
              onClick={() => unlinkSlack()}
            >
              {unlinking ? 'Scollegamento…' : 'Scollega'}
            </button>
          </div>
        ) : (
          <div>
            <label style={label}>Il tuo Slack User ID</label>
            <input
              style={inputStyle}
              value={input}
              onChange={(e) => { setInput(e.target.value); setSaved(false) }}
              placeholder="U0123456789"
            />
            <p style={{ fontSize: 11, color: '#9ca3af', margin: '5px 0 16px' }}>
              Trovalo in Slack → click sul tuo avatar → Profilo → ⋮ → Copia ID membro
            </p>
            {saved && (
              <p style={{ fontSize: 12, color: '#15803d', margin: '0 0 10px' }}>
                ✓ Salvato
              </p>
            )}
            <button
              style={btn}
              disabled={linking || !input.trim()}
              onClick={() => linkSlack({ variables: { slackId: input.trim() } })}
            >
              {linking ? 'Salvataggio…' : 'Salva'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
