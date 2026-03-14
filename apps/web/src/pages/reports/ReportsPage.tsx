import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { BarChart2 } from 'lucide-react'

// ── GraphQL ────────────────────────────────────────────────────────────────

const GET_CONVERSATIONS = gql`
  query GetReportConversations {
    reportConversations {
      id title createdAt updatedAt
      messages { id role content createdAt }
    }
  }
`

const ASK_REPORT = gql`
  mutation AskReport($question: String!, $conversationId: ID) {
    askReport(question: $question, conversationId: $conversationId) {
      conversationId
      message { id role content createdAt }
    }
  }
`

const DELETE_CONVERSATION = gql`
  mutation DeleteReportConversation($id: ID!) {
    deleteReportConversation(id: $id)
  }
`

// ── Types ──────────────────────────────────────────────────────────────────

interface ReportMessage {
  id: string
  role: string
  content: string
  createdAt: string
}

interface ReportConversation {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  messages: ReportMessage[]
}

// ── Helpers ────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)   return 'ora'
  if (mins < 60)  return `${mins} min fa`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)   return `${hrs} ore fa`
  return `${Math.floor(hrs / 24)} giorni fa`
}

function extractCSV(content: string): string | null {
  const tableRegex = /\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/g
  const match = tableRegex.exec(content)
  if (!match) return null
  const headers = match[1].split('|').map((h) => h.trim()).filter(Boolean)
  const rows = match[2].trim().split('\n').map((row) =>
    row.split('|').map((c) => c.trim()).filter(Boolean),
  )
  const lines = [headers.join(','), ...rows.map((r) => r.join(','))]
  return lines.join('\n')
}

const SUGGESTIONS = [
  'Quanti incident sono aperti oggi?',
  'Quali CI hanno avuto più problemi questo mese?',
  'Report change della settimana scorsa',
  'Qual è il MTTR medio per severity?',
]

// ── Component ──────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { data, refetch } = useQuery<{ reportConversations: ReportConversation[] }>(GET_CONVERSATIONS)
  const [askReport, { loading }]      = useMutation<{ askReport: { conversationId: string; message: ReportMessage } }>(ASK_REPORT)
  const [deleteConv]                  = useMutation(DELETE_CONVERSATION)

  const [activeId, setActiveId]       = useState<string | null>(null)
  const [input, setInput]             = useState('')
  const [localMessages, setLocalMessages] = useState<ReportMessage[]>([])
  const messagesEndRef                = useRef<HTMLDivElement>(null)
  const textareaRef                   = useRef<HTMLTextAreaElement>(null)

  const conversations = data?.reportConversations ?? []
  const active = conversations.find((c) => c.id === activeId) ?? null

  // Sync local messages when active conversation changes
  useEffect(() => {
    if (active) setLocalMessages(active.messages)
  }, [activeId, active?.messages.length])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [localMessages, loading])

  const handleSend = useCallback(async (question: string) => {
    if (!question.trim() || loading) return
    setInput('')

    const userMsg: ReportMessage = {
      id: `tmp-${Date.now()}`,
      role: 'user',
      content: question,
      createdAt: new Date().toISOString(),
    }
    setLocalMessages((prev) => [...prev, userMsg])

    try {
      const result = await askReport({ variables: { question, conversationId: activeId } })
      console.log('[SEND] result:', result)
      const data = result.data?.askReport
      if (data) {
        if (!activeId) setActiveId(data.conversationId)
        setLocalMessages((prev) => {
          const withoutTmp = prev.filter((m) => !m.id.startsWith('tmp-'))
          return [...withoutTmp, userMsg, data.message]
        })
        void refetch()
      }
    } catch (err) {
      console.error('[SEND] error:', err)
      setLocalMessages((prev) =>
        prev.filter((m) => !m.id.startsWith('tmp-'))
      )
    }
  }, [activeId, loading, askReport, refetch])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend(input)
    }
  }

  const handleNewConversation = () => {
    setActiveId(null)
    setLocalMessages([])
    setInput('')
    textareaRef.current?.focus()
  }

  const handleDelete = async (id: string) => {
    await deleteConv({ variables: { id } })
    if (activeId === id) { setActiveId(null); setLocalMessages([]) }
    void refetch()
  }

  const handleExportCSV = () => {
    const lastAsst = [...localMessages].reverse().find((m) => m.role === 'assistant')
    if (!lastAsst) return
    const csv = extractCSV(lastAsst.content)
    if (!csv) { alert('Nessuna tabella trovata nella risposta'); return }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = 'report.csv'; a.click()
    URL.revokeObjectURL(url)
  }

  const handlePrint = () => {
    const conv = active ?? (activeId ? null : null)
    document.title = conv?.title ?? 'Report ITSM'
    window.print()
  }

  const hasMessages = localMessages.length > 0

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'inherit' }}>

      {/* ── Sidebar sinistra ────────────────────────────────────────────── */}
      <div style={{
        width: 240, flexShrink: 0, background: '#f9fafb',
        borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#111827' }}>Report</span>
          <button
            onClick={handleNewConversation}
            style={{ fontSize: 18, fontWeight: 400, color: '#4f46e5', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1, padding: '2px 6px', borderRadius: 4 }}
            title="Nuova conversazione"
          >+</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
          {conversations.length === 0 ? (
            <div style={{ fontSize: 12, color: '#9ca3af', padding: '12px 8px' }}>Nessuna conversazione</div>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                onClick={() => { setActiveId(c.id); setLocalMessages(c.messages) }}
                style={{
                  padding: '8px 10px', borderRadius: 6, cursor: 'pointer', marginBottom: 2,
                  background: activeId === c.id ? '#e5e7eb' : 'transparent',
                  transition: 'background 0.1s',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                }}
                onMouseEnter={(e) => { if (activeId !== c.id) (e.currentTarget as HTMLDivElement).style.background = '#f3f4f6' }}
                onMouseLeave={(e) => { if (activeId !== c.id) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: '#111827', fontWeight: activeId === c.id ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
                    {c.title.length > 40 ? c.title.slice(0, 40) + '…' : c.title}
                  </div>
                  <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 1 }}>{relativeTime(c.updatedAt)}</div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); void handleDelete(c.id) }}
                  style={{ fontSize: 14, color: '#d1d5db', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 3, flexShrink: 0, lineHeight: 1 }}
                  title="Elimina"
                >×</button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Colonna centrale ────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: '#fff' }}>

        {!activeId && !hasMessages ? (
          /* Welcome screen */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 16 }}>
            <BarChart2 size={48} color="#d1d5db" strokeWidth={1.5} />
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 22, fontWeight: 700, color: '#111827', marginBottom: 6 }}>Analisi ITSM</div>
              <div style={{ fontSize: 14, color: '#6b7280' }}>Fai domande sui tuoi dati in linguaggio naturale</div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 8, width: '100%', maxWidth: 520 }}>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void handleSend(s)}
                  style={{
                    fontSize: 13, color: '#374151', background: '#f9fafb',
                    border: '1px solid #e5e7eb', borderRadius: 8,
                    padding: '10px 14px', cursor: 'pointer', textAlign: 'left',
                    transition: 'background 0.1s',
                  }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '#f3f4f6')}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = '#f9fafb')}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          /* Messages area */
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
            {localMessages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                <div style={{
                  maxWidth: msg.role === 'user' ? '70%' : '85%',
                  background: msg.role === 'user' ? '#1e3a5f' : '#f9fafb',
                  color: msg.role === 'user' ? '#fff' : '#111827',
                  border: msg.role === 'user' ? 'none' : '1px solid #e5e7eb',
                  borderRadius: 12,
                  padding: '10px 14px',
                  fontSize: 14,
                  lineHeight: 1.6,
                }}>
                  {msg.role === 'user' ? (
                    <span style={{ whiteSpace: 'pre-wrap' }}>{msg.content}</span>
                  ) : (
                    <div className="report-markdown">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          table: ({ children }) => (
                            <div style={{ overflowX: 'auto', margin: '12px 0' }}>
                              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 13 }}>{children}</table>
                            </div>
                          ),
                          thead: ({ children }) => <thead style={{ background: '#f8fafc' }}>{children}</thead>,
                          tr: ({ children }) => <tr style={{ transition: 'background 0.1s' }}>{children}</tr>,
                          th: ({ children }) => (
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '2px solid #e2e8f0', whiteSpace: 'nowrap' }}>{children}</th>
                          ),
                          td: ({ children }) => (
                            <td style={{ padding: '7px 12px', borderBottom: '1px solid #f1f5f9', color: '#1f2937', fontSize: 13, verticalAlign: 'top' }}>{children}</td>
                          ),
                          p: ({ children }) => (
                            <p style={{ margin: '4px 0 8px 0', lineHeight: 1.65, color: '#374151', fontSize: 14 }}>{children}</p>
                          ),
                          strong: ({ children }) => (
                            <strong style={{ fontWeight: 600, color: '#111827' }}>{children}</strong>
                          ),
                          h2: ({ children }) => (
                            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#1e3a5f', margin: '16px 0 8px 0', paddingBottom: 4, borderBottom: '1px solid #e5e7eb' }}>{children}</h2>
                          ),
                          h3: ({ children }) => (
                            <h3 style={{ fontSize: 13, fontWeight: 600, color: '#374151', margin: '12px 0 6px 0' }}>{children}</h3>
                          ),
                          ul: ({ children }) => (
                            <ul style={{ margin: '4px 0 8px 0', paddingLeft: 20, color: '#374151', fontSize: 14 }}>{children}</ul>
                          ),
                          li: ({ children }) => <li style={{ margin: '3px 0' }}>{children}</li>,
                          code: ({ children }) => (
                            <code style={{ background: '#f1f5f9', padding: '1px 6px', borderRadius: 4, fontSize: 12, fontFamily: 'monospace', color: '#1e3a5f' }}>{children}</code>
                          ),
                        }}
                      >
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{ background: '#f9fafb', border: '1px solid #e5e7eb', borderRadius: 12, padding: '10px 16px', fontSize: 18, color: '#9ca3af', letterSpacing: 4 }}>
                  <span style={{ animation: 'pulse 1.2s infinite' }}>•••</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* Input area */}
        <div style={{ borderTop: '1px solid #e5e7eb', padding: '12px 24px', background: '#fff' }}>
          {hasMessages && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <button onClick={handlePrint} style={exportBtnStyle}>↓ PDF</button>
              <button onClick={handleExportCSV} style={exportBtnStyle}>↓ CSV</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Fai una domanda sui tuoi dati ITSM..."
              rows={1}
              style={{
                flex: 1, fontSize: 14, padding: '10px 14px',
                border: '1px solid #d1d5db', borderRadius: 8,
                resize: 'none', fontFamily: 'inherit', lineHeight: 1.5,
                maxHeight: 96, overflowY: 'auto', outline: 'none',
              }}
              onInput={(e) => {
                const t = e.currentTarget
                t.style.height = 'auto'
                t.style.height = Math.min(t.scrollHeight, 96) + 'px'
              }}
            />
            <button
              onClick={() => void handleSend(input)}
              disabled={loading || !input.trim()}
              style={{
                fontSize: 13, fontWeight: 600, padding: '10px 18px',
                background: loading || !input.trim() ? '#e5e7eb' : '#4f46e5',
                color: loading || !input.trim() ? '#9ca3af' : '#fff',
                border: 'none', borderRadius: 8, cursor: loading || !input.trim() ? 'default' : 'pointer',
                whiteSpace: 'nowrap', transition: 'background 0.15s',
              }}
            >
              {loading ? '…' : 'Invia'}
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>Enter per inviare · Shift+Enter per andare a capo</div>
        </div>
      </div>

      <style>{`
        @media print {
          body > * { display: none !important; }
          .report-print-area { display: block !important; }
        }
        .report-markdown p { margin: 0 0 8px; }
        .report-markdown p:last-child { margin-bottom: 0; }
        .report-markdown table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
        .report-markdown th, .report-markdown td { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
        .report-markdown th { background: #f3f4f6; font-weight: 600; }
        .report-markdown code { background: #f3f4f6; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
        .report-markdown pre { background: #f3f4f6; padding: 10px; border-radius: 6px; overflow-x: auto; }
        .report-markdown ul, .report-markdown ol { margin: 4px 0 8px; padding-left: 20px; }
        .report-markdown li { margin-bottom: 2px; }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }
      `}</style>
    </div>
  )
}

const exportBtnStyle: React.CSSProperties = {
  fontSize: 12, color: '#6b7280', background: '#f9fafb',
  border: '1px solid #e5e7eb', borderRadius: 5,
  padding: '4px 10px', cursor: 'pointer',
}
