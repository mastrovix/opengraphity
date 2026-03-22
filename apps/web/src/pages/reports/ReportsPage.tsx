import { useState, useRef, useEffect, useCallback } from 'react'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { keycloak } from '@/lib/keycloak'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { BarChart2, X } from 'lucide-react'
import { SkeletonLine } from '@/components/SkeletonLoader'
import { EmptyState } from '@/components/EmptyState'

// ── GraphQL ────────────────────────────────────────────────────────────────

const GET_CONVERSATIONS = gql`
  query GetReportConversations {
    reportConversations {
      id title createdAt updatedAt
      messages { id role content createdAt }
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

// ── Component ──────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { data, refetch } = useQuery<{ reportConversations: ReportConversation[] }>(GET_CONVERSATIONS)
  const [deleteConv]                  = useMutation(DELETE_CONVERSATION)

  const [activeId, setActiveId]       = useState<string | null>(null)
  const [input, setInput]             = useState('')
  const [localMessages, setLocalMessages] = useState<ReportMessage[]>([])
  const [isStreaming, setIsStreaming]  = useState(false)
  const [streamingText, setStreamingText] = useState('')
  const [toolStatus, setToolStatus]   = useState<string | null>(null)
  const messagesEndRef                = useRef<HTMLDivElement>(null)
  const textareaRef                   = useRef<HTMLTextAreaElement>(null)
  const abortRef                      = useRef<AbortController | null>(null)
  const suppressSyncRef               = useRef(false)

  const conversations = data?.reportConversations ?? []
  const active = conversations.find((c) => c.id === activeId) ?? null

  // Sync local messages when user switches conversation — suppressed during/after streaming
  useEffect(() => {
    if (suppressSyncRef.current) return
    if (active) setLocalMessages(active.messages)
  }, [activeId, active?.messages.length])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [localMessages, isStreaming, streamingText])

  useEffect(() => {
    return () => { abortRef.current?.abort() }
  }, [])

  const handleSend = useCallback(async (question: string) => {
    if (!question.trim() || isStreaming) return
    setInput('')

    const isNewConv = !activeId

    const userMsg: ReportMessage = {
      id: `tmp-${Date.now()}`,
      role: 'user',
      content: question,
      createdAt: new Date().toISOString(),
    }
    setLocalMessages((prev) => [...prev, userMsg])
    setIsStreaming(true)
    setStreamingText('')
    setToolStatus(null)

    const abort = new AbortController()
    abortRef.current = abort

    const apiUrl = import.meta.env['VITE_API_BASE_URL'] ?? 'http://localhost:4000'
    const token = keycloak.token ?? ''

    try {
      const res = await fetch(`${apiUrl}/api/report/stream`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: token ? `Bearer ${token}` : '',
        },
        body: JSON.stringify({ question, conversationId: activeId }),
        signal: abort.signal,
      })

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let pendingConvId: string | null = null
      let accumulatedText = ''
      let donePayload: { message: ReportMessage; conversationId?: string } | null = null
      let errorOccurred = false

      // Parse SSE with event names
      const processSSEChunk = (block: string) => {
        const lines = block.split('\n')
        let currentEvent = ''
        let lastEventWasError = false
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7).trim()
            lastEventWasError = currentEvent === 'error'
          } else if (line.startsWith('data: ')) {
            if (lastEventWasError) {
              try {
                const errorData = JSON.parse(line.slice(6)) as { message?: string }
                errorOccurred = true
                setIsStreaming(false)
                setStreamingText('')
                setLocalMessages((prev) => prev.filter((m) => !m.id.startsWith('tmp-')))
                toast.error(
                  errorData.message?.includes('overloaded')
                    ? 'Servizio AI temporaneamente sovraccarico. Riprova tra qualche secondo.'
                    : (errorData.message ?? 'Errore durante la generazione della risposta'),
                )
              } catch { /* ignore */ }
              lastEventWasError = false
              currentEvent = ''
              return
            }
            try {
              const payload = JSON.parse(line.slice(6)) as {
                text?: string
                description?: string
                conversationId?: string
                message?: ReportMessage
              }
              if (currentEvent === 'chunk' && payload.text) {
                accumulatedText += payload.text
                setStreamingText((prev) => prev + payload.text!)
              } else if (currentEvent === 'tool' && payload.description) {
                setToolStatus(payload.description)
              } else if (currentEvent === 'conversation' && payload.conversationId) {
                // Don't call setActiveId here — it triggers useEffect that wipes localMessages
                if (isNewConv) pendingConvId = payload.conversationId
              } else if (currentEvent === 'done' && payload.message) {
                donePayload = { message: payload.message, conversationId: payload.conversationId }
              }
            } catch { /* ignore */ }
            currentEvent = ''
            lastEventWasError = false
          }
        }
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        buffer += chunk
        const blocks = buffer.split('\n\n')
        buffer = blocks.pop() ?? ''
        for (const block of blocks) {
          processSSEChunk(block)
        }
      }
      if (buffer.trim()) processSSEChunk(buffer)

      // TS 5.4 narrows closure-assigned vars to null — use explicit cast to restore union type
      type DonePayload = { message: ReportMessage; conversationId?: string }
      const doneFinal = donePayload as DonePayload | null
      if (!errorOccurred && doneFinal) {
        const finalConvId = doneFinal.conversationId ?? pendingConvId
        const assistantMsg: ReportMessage = {
          id: doneFinal.message.id,
          role: 'assistant',
          content: accumulatedText || doneFinal.message.content,
          createdAt: doneFinal.message.createdAt,
        }

        // Suppress the sync-from-Apollo effect until refetch settles
        suppressSyncRef.current = true
        setLocalMessages((prev) => {
          const withoutTmp = prev.filter((m) => !m.id.startsWith('tmp-'))
          return [...withoutTmp, userMsg, assistantMsg]
        })
        setStreamingText('')
        if (isNewConv && finalConvId) setActiveId(finalConvId)
        void (refetch() as Promise<unknown>).then(() => { suppressSyncRef.current = false })
      } else if (!errorOccurred) {
        setLocalMessages((prev) => prev.filter((m) => !m.id.startsWith('tmp-')))
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('[reports] stream error:', err)
        setLocalMessages((prev) => prev.filter((m) => !m.id.startsWith('tmp-')))
      }
    } finally {
      setIsStreaming(false)
      setStreamingText('')
      setToolStatus(null)
      abortRef.current = null
    }
  }, [activeId, isStreaming, refetch])

  const loading = isStreaming

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
    <div style={{ display: 'flex', height: '100vh', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>

      {/* ── Sidebar sinistra ────────────────────────────────────────────── */}
      <div style={{
        width: 240, flexShrink: 0, background: '#f9fafb',
        borderRight: '1px solid #e5e7eb', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: '#0f172a' }}>Report</span>
          <button
            onClick={handleNewConversation}
            style={{ fontSize: 18, fontWeight: 400, color: '#0284c7', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1, padding: '2px 6px', borderRadius: 4 }}
            title="Nuova conversazione"
          >+</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
          {conversations.length === 0 ? (
            <EmptyState icon={<BarChart2 size={24} />} title="Nessuna conversazione" description="Fai la prima domanda per iniziare." />
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
                  <div style={{ fontSize: 14, color: '#0f172a', fontWeight: activeId === c.id ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
                    {c.title.length > 40 ? c.title.slice(0, 40) + '…' : c.title}
                  </div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 1 }}>{relativeTime(c.updatedAt)}</div>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); void handleDelete(c.id) }}
                  style={{ color: '#d1d5db', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 3, flexShrink: 0, display: 'flex', alignItems: 'center' }}
                  title="Elimina"
                ><X size={13} /></button>
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
              <div style={{ fontSize: 24, fontWeight: 600, color: '#0f172a', marginBottom: 6 }}>Analisi ITSM</div>
              <div style={{ fontSize: 14, color: '#94a3b8' }}>Fai domande sui tuoi dati in linguaggio naturale</div>
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
                  color: msg.role === 'user' ? '#fff' : '#0f172a',
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
                              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>{children}</table>
                            </div>
                          ),
                          thead: ({ children }) => <thead style={{ background: '#f8fafc' }}>{children}</thead>,
                          tr: ({ children }) => <tr style={{ transition: 'background 0.1s' }}>{children}</tr>,
                          th: ({ children }) => (
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '2px solid #e2e8f0', whiteSpace: 'nowrap' }}>{children}</th>
                          ),
                          td: ({ children }) => (
                            <td style={{ padding: '7px 12px', borderBottom: '1px solid #f1f5f9', color: '#1f2937', fontSize: 14, verticalAlign: 'top' }}>{children}</td>
                          ),
                          p: ({ children }) => (
                            <p style={{ margin: '4px 0 8px 0', lineHeight: 1.65, color: '#64748b', fontSize: 14 }}>{children}</p>
                          ),
                          strong: ({ children }) => (
                            <strong style={{ fontWeight: 600, color: '#0f172a' }}>{children}</strong>
                          ),
                          h2: ({ children }) => (
                            <h2 style={{ fontSize: 15, fontWeight: 600, color: '#1e3a5f', margin: '16px 0 8px 0', paddingBottom: 4, borderBottom: '1px solid #e5e7eb' }}>{children}</h2>
                          ),
                          h3: ({ children }) => (
                            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#64748b', margin: '12px 0 6px 0' }}>{children}</h3>
                          ),
                          ul: ({ children }) => (
                            <ul style={{ margin: '4px 0 8px 0', paddingLeft: 20, color: '#64748b', fontSize: 14 }}>{children}</ul>
                          ),
                          li: ({ children }) => <li style={{ margin: '3px 0' }}>{children}</li>,
                          code: ({ children }) => (
                            <code style={{ background: '#f1f5f9', padding: '1px 6px', borderRadius: 4, fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: '#1e3a5f' }}>{children}</code>
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

            {isStreaming && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{
                  maxWidth: '85%',
                  background: '#f9fafb',
                  color: '#0f172a',
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  padding: '10px 14px',
                  fontSize: 14,
                  lineHeight: 1.6,
                }}>
                  {toolStatus && !streamingText && (
                    <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ animation: 'pulse 1.5s infinite' }}>⚙</span>
                      {toolStatus}
                    </div>
                  )}
                  {streamingText ? (
                    <div className="report-markdown">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          table: ({ children }) => (
                            <div style={{ overflowX: 'auto', margin: '12px 0' }}>
                              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>{children}</table>
                            </div>
                          ),
                          thead: ({ children }) => <thead style={{ background: '#f8fafc' }}>{children}</thead>,
                          tr: ({ children }) => <tr style={{ transition: 'background 0.1s' }}>{children}</tr>,
                          th: ({ children }) => (
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 12, fontWeight: 600, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '2px solid #e2e8f0', whiteSpace: 'nowrap' }}>{children}</th>
                          ),
                          td: ({ children }) => (
                            <td style={{ padding: '7px 12px', borderBottom: '1px solid #f1f5f9', color: '#1f2937', fontSize: 14, verticalAlign: 'top' }}>{children}</td>
                          ),
                          p: ({ children }) => (
                            <p style={{ margin: '4px 0 8px 0', lineHeight: 1.65, color: '#64748b', fontSize: 14 }}>{children}</p>
                          ),
                          strong: ({ children }) => (
                            <strong style={{ fontWeight: 600, color: '#0f172a' }}>{children}</strong>
                          ),
                          h2: ({ children }) => (
                            <h2 style={{ fontSize: 15, fontWeight: 600, color: '#1e3a5f', margin: '16px 0 8px 0', paddingBottom: 4, borderBottom: '1px solid #e5e7eb' }}>{children}</h2>
                          ),
                          h3: ({ children }) => (
                            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#64748b', margin: '12px 0 6px 0' }}>{children}</h3>
                          ),
                          ul: ({ children }) => (
                            <ul style={{ margin: '4px 0 8px 0', paddingLeft: 20, color: '#64748b', fontSize: 14 }}>{children}</ul>
                          ),
                          li: ({ children }) => <li style={{ margin: '3px 0' }}>{children}</li>,
                          code: ({ children }) => (
                            <code style={{ background: '#f1f5f9', padding: '1px 6px', borderRadius: 4, fontSize: 12, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", color: '#1e3a5f' }}>{children}</code>
                          ),
                        }}
                      >
                        {streamingText}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <SkeletonLine width="90%" height={12} />
                      <SkeletonLine width="70%" height={12} />
                      <SkeletonLine width="50%" height={12} />
                    </div>
                  )}
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
                resize: 'none', fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", lineHeight: 1.5,
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
                fontSize: 14, fontWeight: 600, padding: '10px 18px',
                background: loading || !input.trim() ? '#e5e7eb' : '#0284c7',
                color: loading || !input.trim() ? '#94a3b8' : '#fff',
                border: 'none', borderRadius: 8, cursor: loading || !input.trim() ? 'default' : 'pointer',
                whiteSpace: 'nowrap', transition: 'background 0.15s',
              }}
            >
              {loading ? '…' : 'Invia'}
            </button>
          </div>
          <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 6 }}>Enter per inviare · Shift+Enter per andare a capo</div>
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
  fontSize: 12, color: '#94a3b8', background: '#f9fafb',
  border: '1px solid #e5e7eb', borderRadius: 5,
  padding: '4px 10px', cursor: 'pointer',
}
