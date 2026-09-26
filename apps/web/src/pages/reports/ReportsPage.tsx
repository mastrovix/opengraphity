import { Textarea } from '@/components/ui/FormControls'
import { useState, useRef, useEffect, useCallback } from 'react'
import { useAIFeature } from '@/hooks/useAIFeature'
import { AIDisabledNotice } from '@/components/ai/AIDisabledNotice'
import { useQuery, useMutation } from '@apollo/client/react'
import { gql } from '@apollo/client'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { PageTitle } from '@/components/PageTitle'
import { apiUrl, authHeader } from '@/lib/apiBase'
import { exportToCsv } from '@/lib/csvExport'
import { timeAgo } from '@/lib/datetime'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { toast } from 'sonner'
import { BarChart2, BrainCircuit, X } from 'lucide-react'
import { SkeletonLine } from '@/components/SkeletonLoader'
import { EmptyState } from '@/components/EmptyState'
import { keyActivate } from '@/lib/a11y'
import { colors } from '@/lib/tokens'
import { showError } from '@/lib/showError'

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

/** A frame of the report stream, read: what it carries depends on its event. */
type ReportFrame =
  | { event: 'chunk'; text: string }
  | { event: 'tool'; description: string }
  | { event: 'conversation'; conversationId: string }
  | { event: 'done'; message: ReportMessage; conversationId?: string }
  | { event: 'error'; message: string }
  /** F-10: a frame the client could not interpret, and why — counted and reported, never dropped in silence. */
  | { event: 'unreadable'; reason: string }

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * The first table of an answer, cell by cell (tour of 23 Sep 2026). The CSV
 * used to split the rows on `|` dropping the empty cells, and to join them
 * unquoted: «Rome, Milan» became two columns, an empty cell vanished, and
 * every value after either moved one column left. The cells are now split as
 * the table is drawn — an empty cell stays, `\|` is a pipe inside a cell —
 * and `exportToCsv` quotes them.
 */
function extractTable(content: string): { headers: string[]; rows: string[][] } | null {
  const match = /\|(.+)\|\n\|[-| :]+\|\n((?:\|.+\|\n?)+)/.exec(content)
  if (!match) return null
  const cells = (inner: string) => inner.split(/(?<!\\)\|/).map((c) => c.trim().replaceAll('\\|', '|'))
  return {
    headers: cells(match[1]),
    rows: match[2].trim().split('\n').map((row) => cells(row.trim().slice(1, -1))),
  }
}

/**
 * Why the server refused the question (tour of 23 Sep 2026): the page said
 * only «HTTP 403». The report stream refuses before opening the stream, with
 * the reason in a JSON body: `{ error: '…' }` from the route and the auth
 * middleware (a missing permission, an empty question), `{ error: { code,
 * message } }` from the REST error handler and when the organisation has
 * turned the AI off — that one is said in the reader's language. A body
 * without a reason (a proxy's error page) leaves the status.
 */
async function refusalReason(res: Response, t: TFunction): Promise<string> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    // Not JSON: the status below is all there is to say.
  }
  const error = (body as { error?: unknown } | null)?.error
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object') {
    const { code, message } = error as { code?: unknown; message?: unknown }
    if (code === 'AI_DISABLED') return t('errors.ai.disabled', { feature: t('pages.organization.aiFeature.reportAnalysis') })
    // The two refusals of the review of 23 Sep 2026, in the reader's language.
    if (code === 'RATE_LIMITED') {
      const { limit, retry_after: retryAfter } = error as { limit?: unknown; retry_after?: unknown }
      return t('errors.report.rateLimited', { max: String(limit ?? ''), seconds: String(retryAfter ?? res.headers?.get('retry-after') ?? '') })
    }
    if (code === 'QUESTION_TOO_LONG') return t('errors.report.questionTooLong', { max: String((error as { max?: unknown }).max ?? '') })
    if (typeof message === 'string' && message.trim()) return message
  }
  return `HTTP ${res.status}`
}

/** An error said in the chat where the answer would be (a `tmp-` message: it is not saved). */
const errorNote = (content: string): ReportMessage => ({
  id: `tmp-err-${Date.now()}`, role: 'assistant', content, createdAt: new Date().toISOString(),
})

/**
 * The frames of one SSE block, in order: an `event: …` line names the event,
 * the `data: …` line after it carries its payload. An error frame ends the
 * block — what follows it in the same block is not read.
 */
function reportFrames(block: string, t: TFunction): ReportFrame[] {
  const frames: ReportFrame[] = []
  const lines = block.split('\n')
  let currentEvent = ''
  let lastEventWasError = false
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim()
      lastEventWasError = currentEvent === 'error'
    } else if (line.startsWith('data: ')) {
      if (lastEventWasError) {
        let errMsg = t('toast.report.streamError')
        try {
          const errorData = JSON.parse(line.slice(6)) as { message?: string }
          errMsg = errorData.message?.includes('overloaded')
            ? t('toast.report.aiOverloaded')
            : (errorData.message ?? errMsg)
        } catch {
          // Frame di errore malformato: mostriamo comunque un errore generico
          // invece di ingoiarlo in silenzio.
        }
        frames.push({ event: 'error', message: errMsg })
        // Niente da azzerare: il `return` esce da reportFrames, e le due
        // variabili nascono con ogni blocco. Le due assegnazioni che
        // stavano qui non le leggeva nessuno.
        return frames
      }
      try {
        const payload = JSON.parse(line.slice(6)) as {
          text?: string
          description?: string
          conversationId?: string
          message?: ReportMessage
        }
        if (currentEvent === 'chunk' && payload.text) {
          frames.push({ event: 'chunk', text: payload.text })
        } else if (currentEvent === 'tool' && payload.description) {
          frames.push({ event: 'tool', description: payload.description })
        } else if (currentEvent === 'conversation' && payload.conversationId) {
          frames.push({ event: 'conversation', conversationId: payload.conversationId })
        } else if (currentEvent === 'done' && payload.message) {
          frames.push({ event: 'done', message: payload.message, conversationId: payload.conversationId })
        } else {
          frames.push({ event: 'unreadable', reason: t('pages.aiAnalysis.unexpectedPayload', { event: currentEvent || '—' }) })
        }
      } catch (e) {
        frames.push({ event: 'unreadable', reason: t('pages.aiAnalysis.invalidJson', { message: e instanceof Error ? e.message : String(e) }) })
      }
      currentEvent = ''
      lastEventWasError = false
    }
  }
  return frames
}

/**
 * Reads a body of server-sent events block by block (a block ends with a
 * blank line): a block split across two packets is handed on once whole, and
 * a last block without its blank line still counts.
 */
async function readSSEBlocks(body: ReadableStream<Uint8Array>, onBlock: (block: string) => void): Promise<void> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    buffer += chunk
    const blocks = buffer.split('\n\n')
    buffer = blocks.pop() ?? ''
    for (const block of blocks) {
      onBlock(block)
    }
  }
  if (buffer.trim()) onBlock(buffer)
}

// ── Component ──────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const { t } = useTranslation()
  const reportAnalysisOn = useAIFeature('reportAnalysis')
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
  /**
   * The answer streaming INTO THE CONVERSATION ON SCREEN (tour of 23 Sep
   * 2026). Opening another conversation while an answer streamed used to
   * put the question and the answer in the messages on screen — the other
   * conversation's. Now the stream owns the screen only until the person
   * moves (`leaveStream`): it keeps running, the server saves the answer in
   * its own conversation and the list is reloaded at the end, but it draws
   * nothing more here. The ref is for the stream's callbacks, the state for
   * the render.
   */
  const onScreenStreamRef             = useRef<object | null>(null)
  const [streamOnScreen, setStreamOnScreen] = useState(false)

  const conversations = data?.reportConversations ?? []
  const active = conversations.find((c) => c.id === activeId) ?? null
  const activeRef = useRef(active)
  activeRef.current = active
  const activeMessageCount = active?.messages.length ?? 0

  // Sync local messages when user switches conversation or the server-side
  // message count changes — suppressed during/after streaming. Read through a
  // ref so a refetch that returns the same messages does not re-sync.
  useEffect(() => {
    if (suppressSyncRef.current) return
    const current = activeRef.current
    if (current) setLocalMessages(current.messages)
  }, [activeId, activeMessageCount])

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
    const stream = {}
    onScreenStreamRef.current = stream
    const onScreen = () => onScreenStreamRef.current === stream
    setStreamOnScreen(true)
    setLocalMessages((prev) => [...prev, userMsg])
    setIsStreaming(true)
    setStreamingText('')
    setToolStatus(null)

    const abort = new AbortController()
    abortRef.current = abort

    try {
      // La base comune (apiUrl) e il token (authHeader): prima una variabile di
      // build puntata sul cliente del bundle faceva rifiutare il token su ogni
      // altro cliente (giro nel browser del 14 set 2026).
      const res = await fetch(apiUrl('/api/report/stream'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeader(),
        },
        body: JSON.stringify({ question, conversationId: activeId }),
        signal: abort.signal,
      })

      if (!res.ok) throw new Error(await refusalReason(res, t))
      if (!res.body) throw new Error(`HTTP ${res.status}`)

      let pendingConvId: string | null = null
      let accumulatedText = ''
      let donePayload: { message: ReportMessage; conversationId?: string } | null = null
      let errorOccurred = false
      // F-10: frames the client could not interpret are counted and reported,
      // never dropped in silence (a truncated chunk = missing answer text).
      let droppedFrames = 0
      let firstDropReason: string | null = null

      // What each frame of a block does to the page (the frames are read by reportFrames)
      const processSSEChunk = (block: string) => {
        for (const frame of reportFrames(block, t)) {
          if (frame.event === 'error') {
            errorOccurred = true
            setIsStreaming(false)
            // Il messaggio utente resta visibile; l'errore compare in chat.
            // (In the chat of the question, if it is still on screen.)
            if (onScreen()) {
              setStreamingText('')
              setLocalMessages((prev) => [...prev, errorNote(t('pages.aiAnalysis.errorMessage', { message: frame.message }))])
            }
            showError(frame)
          } else if (frame.event === 'chunk') {
            accumulatedText += frame.text
            if (onScreen()) setStreamingText((prev) => prev + frame.text)
          } else if (frame.event === 'tool') {
            if (onScreen()) setToolStatus(frame.description)
          } else if (frame.event === 'conversation') {
            // Don't call setActiveId here — it triggers useEffect that wipes localMessages
            if (isNewConv) pendingConvId = frame.conversationId
          } else if (frame.event === 'done') {
            donePayload = { message: frame.message, conversationId: frame.conversationId }
          } else {
            droppedFrames++
            firstDropReason ??= frame.reason
          }
        }
      }

      await readSSEBlocks(res.body, processSSEChunk)

      if (droppedFrames > 0) {
        if (import.meta.env.DEV) console.warn('[reports] SSE frames dropped:', droppedFrames, firstDropReason)
        toast.warning(t('toast.report.droppedFrames', { count: droppedFrames, reason: firstDropReason }))
      }

      // TS 5.4 narrows closure-assigned vars to null — use explicit cast to restore union type
      type DonePayload = { message: ReportMessage; conversationId?: string }
      const doneFinal = donePayload as DonePayload | null
      if (!errorOccurred && doneFinal && !onScreen()) {
        // The person opened another conversation meanwhile: the answer is
        // saved in its own, which the reloaded list brings back.
        void refetch()
      } else if (!errorOccurred && doneFinal) {
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
        // Neither the answer nor an error: a proxy that cut the connection, a
        // server that stopped halfway (tour of 23 Sep 2026). The question used
        // to vanish from the chat without a word; it stays, and it is said.
        const errMsg = t('toast.report.noAnswer')
        toast.error(errMsg)
        if (onScreen()) setLocalMessages((prev) => [...prev, errorNote(t('pages.aiAnalysis.errorMessage', { message: errMsg }))])
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        if (import.meta.env.DEV) console.error('[reports] stream error:', err)
        const errMsg = err instanceof Error ? err.message : String(err)
        toast.error(errMsg)
        // Il messaggio utente resta in chat, seguito da un errore visibile.
        if (onScreen()) setLocalMessages((prev) => [...prev, errorNote(t('pages.aiAnalysis.errorMessage', { message: errMsg }))])
      }
    } finally {
      // Only the latest question says the page is idle: after an error frame
      // a new one may already be streaming.
      if (abortRef.current === abort) {
        setIsStreaming(false)
        abortRef.current = null
      }
      if (onScreen()) {
        onScreenStreamRef.current = null
        setStreamOnScreen(false)
        setStreamingText('')
        setToolStatus(null)
      }
    }
  }, [activeId, isStreaming, refetch, t])

  /**
   * The person moves to another conversation, or to a new one: the answer
   * streaming, if any, stops drawing here (see `onScreenStreamRef`).
   */
  const leaveStream = () => {
    onScreenStreamRef.current = null
    setStreamOnScreen(false)
    setStreamingText('')
    setToolStatus(null)
  }

  const openConversation = (c: ReportConversation) => {
    // Already on screen: nothing to open, and an answer streaming into it stays.
    if (c.id === activeId) return
    leaveStream()
    setActiveId(c.id)
    setLocalMessages(c.messages)
  }

  const loading = isStreaming

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend(input)
    }
  }

  const handleNewConversation = () => {
    leaveStream()
    setActiveId(null)
    setLocalMessages([])
    setInput('')
    textareaRef.current?.focus()
  }

  const handleDelete = async (id: string) => {
    try {
      await deleteConv({ variables: { id } })
    } catch (err) {
      showError(err)
      return
    }
    if (activeId === id) { leaveStream(); setActiveId(null); setLocalMessages([]) }
    void refetch()
  }

  const handleExportCSV = () => {
    const lastAsst = [...localMessages].reverse().find((m) => m.role === 'assistant')
    if (!lastAsst) return
    const table = extractTable(lastAsst.content)
    if (!table) { alert(t('pages.aiAnalysis.noTableInAnswer')); return }
    // One column per header, as the table is drawn: a row with fewer cells
    // gets empty ones, cells beyond the header are neither drawn nor exported.
    exportToCsv('report.csv', table.headers.map((label, i) => ({ key: i, label })), table.rows)
  }

  // F-04: the messages column carries `report-print-area`; the print CSS below
  // hides everything else via visibility (display:none on an ancestor would
  // hide the area too — the old rule printed a blank page).
  const handlePrint = () => {
    const previousTitle = document.title
    document.title = active?.title ?? t('pages.aiAnalysis.documentTitle')
    const restore = () => { document.title = previousTitle; window.removeEventListener('afterprint', restore) }
    window.addEventListener('afterprint', restore)
    window.print()
  }

  const hasMessages = localMessages.length > 0

  return (
    <div className="card-border" style={{ display: 'flex', height: 'calc(var(--vh-app) - 56px - 48px)', fontFamily: 'var(--font-family)', overflow: 'hidden' }}>

      {/* ── Sidebar sinistra ────────────────────────────────────────────── */}
      <div style={{
        width: 240, flexShrink: 0, background: 'var(--color-slate-bg)',
        borderRight: '1px solid var(--color-border)', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          {/**
            * L'INTESTAZIONE della pagina (giro nel browser di fine revisione).
            *
            * Era l'unica pagina dell'app senza nessun h1: il titolo del
            * benvenuto era un `div` con la misura di un titolo — a schermo si
            * vedeva, nella struttura della pagina non esisteva — e compariva
            * solo finché non c'era una conversazione attiva. Chi naviga per
            * intestazioni non trovava niente. Sta qui perché questo pannello
            * c'è sempre, e porta il nome con cui si arriva dal menu.
            */}
          <PageTitle icon={<BrainCircuit />} style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 700 }}>
            {t('sidebar.aiAnalysis')}
          </PageTitle>
          <button
            type="button"
            onClick={handleNewConversation}
            style={{ fontSize: 'var(--font-size-section-title)', fontWeight: 400, color: 'var(--color-link)', textDecoration: 'underline', textUnderlineOffset: 2, background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1, padding: '2px 6px', borderRadius: 4 }}
            title={t('pages.reportsAI.newConversation')}
          >+</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 6px' }}>
          {conversations.length === 0 ? (
            <EmptyState icon={<BarChart2 size={24} />} title={t('pages.aiAnalysis.noConversation')} description={t('pages.aiAnalysis.startQuestion')} />
          ) : (
            conversations.map((c) => (
              // role=button + keyActivate: la riga contiene il bottone "Elimina" annidato, quindi non può essere essa stessa un <button>
              <div
                key={c.id}
                role="button"
                tabIndex={0}
                aria-current={activeId === c.id ? 'true' : undefined}
                onClick={() => openConversation(c)}
                onKeyDown={keyActivate(() => openConversation(c))}
                style={{
                  padding: '8px 10px', borderRadius: 6, cursor: 'pointer', marginBottom: 2,
                  background: activeId === c.id ? colors.border : 'transparent',
                  transition: 'background 0.1s',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
                }}
                onMouseEnter={(e) => { if (activeId !== c.id) (e.currentTarget as HTMLDivElement).style.background = 'var(--color-border-light)' }}
                onMouseLeave={(e) => { if (activeId !== c.id) (e.currentTarget as HTMLDivElement).style.background = 'transparent' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)', fontWeight: activeId === c.id ? 600 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 150 }}>
                    {c.title.length > 40 ? c.title.slice(0, 40) + '…' : c.title}
                  </div>
                  <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 1 }}>{timeAgo(c.updatedAt)}</div>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void handleDelete(c.id) }}
                  style={{ color: colors.slateLight, background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px', borderRadius: 3, flexShrink: 0, display: 'flex', alignItems: 'center' }}
                  title={t('common.delete')}
                ><X size={13} /></button>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Colonna centrale ────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, background: colors.white }}>

        {!activeId && !hasMessages ? (
          /* Welcome screen */
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 40, gap: 16 }}>
            <BarChart2 size={48} color={colors.slateLight} strokeWidth={1.5} />
            <div style={{ textAlign: 'center' }}>
              {/**
                * Stato VUOTO, non una sezione: resta un `div`, come
                * `EmptyState`. Fosse un h2 ripeterebbe l'h1 del pannello, e
                * l'elenco delle intestazioni direbbe due volte la stessa cosa.
                */}
              <div style={{ fontSize: 'var(--font-size-page-title)', fontWeight: 600, color: 'var(--color-slate-dark)', marginBottom: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                <BrainCircuit size={22} color="var(--color-icon-accent)" aria-hidden="true" />
                {t('pages.aiAnalysis.title')}
              </div>
              <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)' }}>{t('pages.aiAnalysis.subtitle')}</div>
            </div>
          </div>
        ) : (
          /* Messages area */
          <div className="report-print-area" style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: 16 }}>
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
                  background: msg.role === 'user' ? colors.slateDark : 'var(--color-slate-bg)',
                  color: msg.role === 'user' ? colors.white : 'var(--color-slate-dark)',
                  border: msg.role === 'user' ? 'none' : '1px solid var(--color-border)',
                  borderRadius: 12,
                  padding: '10px 14px',
                  fontSize: 'var(--font-size-card-title)',
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
                              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--font-size-body)' }}>{children}</table>
                            </div>
                          ),
                          thead: ({ children }) => <thead style={{ background: 'var(--color-slate-bg)' }}>{children}</thead>,
                          tr: ({ children }) => <tr style={{ transition: 'background 0.1s' }}>{children}</tr>,
                          th: ({ children }) => (
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '2px solid var(--color-border)', whiteSpace: 'nowrap' }}>{children}</th>
                          ),
                          td: ({ children }) => (
                            <td style={{ padding: '7px 12px', borderBottom: '1px solid var(--color-border-light)', color: colors.slateDark, fontSize: 'var(--font-size-card-title)', verticalAlign: 'top' }}>{children}</td>
                          ),
                          p: ({ children }) => (
                            <p style={{ margin: '4px 0 8px 0', lineHeight: 1.65, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{children}</p>
                          ),
                          strong: ({ children }) => (
                            <strong style={{ fontWeight: 600, color: 'var(--color-slate-dark)' }}>{children}</strong>
                          ),
                          h2: ({ children }) => (
                            <h2 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark, margin: '16px 0 8px 0', paddingBottom: 4, borderBottom: '1px solid var(--color-border)' }}>{children}</h2>
                          ),
                          h3: ({ children }) => (
                            <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', margin: '12px 0 6px 0' }}>{children}</h3>
                          ),
                          ul: ({ children }) => (
                            <ul style={{ margin: '4px 0 8px 0', paddingLeft: 20, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{children}</ul>
                          ),
                          li: ({ children }) => <li style={{ margin: '3px 0' }}>{children}</li>,
                          code: ({ children }) => (
                            <code style={{ background: 'var(--color-slate-bg)', padding: '1px 6px', borderRadius: 4, fontSize: 'var(--font-size-body)', fontFamily: 'var(--font-family)', color: colors.slateDark }}>{children}</code>
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

            {isStreaming && streamOnScreen && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{
                  maxWidth: '85%',
                  background: 'var(--color-slate-bg)',
                  color: 'var(--color-slate-dark)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 12,
                  padding: '10px 14px',
                  fontSize: 'var(--font-size-card-title)',
                  lineHeight: 1.6,
                }}>
                  {toolStatus && !streamingText && (
                    <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
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
                              <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 'var(--font-size-body)' }}>{children}</table>
                            </div>
                          ),
                          thead: ({ children }) => <thead style={{ background: 'var(--color-slate-bg)' }}>{children}</thead>,
                          tr: ({ children }) => <tr style={{ transition: 'background 0.1s' }}>{children}</tr>,
                          th: ({ children }) => (
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 'var(--font-size-body)', fontWeight: 600, color: 'var(--color-slate)', textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '2px solid var(--color-border)', whiteSpace: 'nowrap' }}>{children}</th>
                          ),
                          td: ({ children }) => (
                            <td style={{ padding: '7px 12px', borderBottom: '1px solid var(--color-border-light)', color: colors.slateDark, fontSize: 'var(--font-size-card-title)', verticalAlign: 'top' }}>{children}</td>
                          ),
                          p: ({ children }) => (
                            <p style={{ margin: '4px 0 8px 0', lineHeight: 1.65, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{children}</p>
                          ),
                          strong: ({ children }) => (
                            <strong style={{ fontWeight: 600, color: 'var(--color-slate-dark)' }}>{children}</strong>
                          ),
                          h2: ({ children }) => (
                            <h2 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: colors.slateDark, margin: '16px 0 8px 0', paddingBottom: 4, borderBottom: '1px solid var(--color-border)' }}>{children}</h2>
                          ),
                          h3: ({ children }) => (
                            <h3 style={{ fontSize: 'var(--font-size-card-title)', fontWeight: 600, color: 'var(--color-slate)', margin: '12px 0 6px 0' }}>{children}</h3>
                          ),
                          ul: ({ children }) => (
                            <ul style={{ margin: '4px 0 8px 0', paddingLeft: 20, color: 'var(--color-slate)', fontSize: 'var(--font-size-body)' }}>{children}</ul>
                          ),
                          li: ({ children }) => <li style={{ margin: '3px 0' }}>{children}</li>,
                          code: ({ children }) => (
                            <code style={{ background: 'var(--color-slate-bg)', padding: '1px 6px', borderRadius: 4, fontSize: 'var(--font-size-body)', fontFamily: 'var(--font-family)', color: colors.slateDark }}>{children}</code>
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
        <div style={{ borderTop: '1px solid var(--color-border)', padding: '12px 24px', background: colors.white }}>
          {/* Analisi AI spenta dall'organizzazione (ondata 6 di «Nulla cablato»): lo si dice al posto della domanda. */}
          {reportAnalysisOn === false ? <AIDisabledNotice feature="reportAnalysis" /> : <>
          {hasMessages && (
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <button type="button" onClick={handlePrint} style={exportBtnStyle}>↓ PDF</button>
              <button type="button" onClick={handleExportCSV} style={exportBtnStyle}>↓ CSV</button>
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={t('pages.aiAnalysis.placeholder')}
              aria-label={t('pages.aiAnalysis.title')}
              rows={1}
              onInput={(e) => {
                const t = e.currentTarget
                t.style.height = 'auto'
                t.style.height = Math.min(t.scrollHeight, 96) + 'px'
              }}
              style={{ flex: 1, resize: 'none', lineHeight: 1.5, maxHeight: 96, overflowY: 'auto' }}
            />
            <button
              type="button"
              onClick={() => void handleSend(input)}
              disabled={loading || !input.trim()}
              style={{
                fontSize: 'var(--font-size-card-title)', fontWeight: 600, padding: '10px 18px',
                background: loading || !input.trim() ? colors.border : 'var(--color-brand)',
                color: loading || !input.trim() ? 'var(--color-slate-light)' : colors.white,
                border: 'none', borderRadius: 8, cursor: loading || !input.trim() ? 'default' : 'pointer',
                whiteSpace: 'nowrap', transition: 'background 0.15s',
              }}
            >
              {loading ? '…' : t('pages.reportsAI.send')}
            </button>
          </div>
          <div style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', marginTop: 6 }}>{t('pages.reportsAI.sendHint')}</div>
          </>}
        </div>
      </div>

      <style>{`
        @media print {
          body * { visibility: hidden !important; }
          .report-print-area, .report-print-area * { visibility: visible !important; }
          .report-print-area {
            position: absolute !important; left: 0 !important; top: 0 !important;
            width: 100% !important; height: auto !important; overflow: visible !important;
            padding: 16px !important; background: var(--color-white) !important;
          }
        }
        .report-markdown p { margin: 0 0 8px; }
        .report-markdown p:last-child { margin-bottom: 0; }
        .report-markdown table { border-collapse: collapse; width: 100%; font-size: 13px; margin: 8px 0; }
        .report-markdown th, .report-markdown td { border: 1px solid var(--color-border); padding: 6px 10px; text-align: left; }
        .report-markdown th { background: var(--color-surface-2); font-weight: 600; }
        .report-markdown code { background: var(--color-surface-2); padding: 1px 5px; border-radius: 3px; font-size: 12px; }
        .report-markdown pre { background: var(--color-surface-2); padding: 10px; border-radius: 6px; overflow-x: auto; }
        .report-markdown ul, .report-markdown ol { margin: 4px 0 8px; padding-left: 20px; }
        .report-markdown li { margin-bottom: 2px; }
        @keyframes pulse { 0%, 100% { opacity: 1 } 50% { opacity: 0.3 } }
      `}</style>
    </div>
  )
}

const exportBtnStyle: React.CSSProperties = {
  fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', background: 'var(--color-slate-bg)',
  border: '1px solid var(--color-border)', borderRadius: 5,
  padding: '4px 10px', cursor: 'pointer',
}
