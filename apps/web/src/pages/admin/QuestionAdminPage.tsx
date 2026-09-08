import { useState, useEffect } from 'react'
import { useQuery } from '@apollo/client/react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useMutationWithToast } from '@/hooks/useMutationWithToast'
import { useConfirm } from '@/hooks/useConfirm'
import { lookupOrError } from '@/lib/tokens'
import { HelpCircle, Plus, Trash2, X, ChevronUp, ChevronDown } from 'lucide-react'
import { PageContainer } from '@/components/PageContainer'
import { PageTitle } from '@/components/PageTitle'
import {
  GET_QUESTIONS_ADMIN,
  GET_QUESTION_CITYPE_ASSIGNMENTS,
  GET_CI_TYPES,
} from '@/graphql/queries'
import {
  CREATE_QUESTION,
  UPDATE_QUESTION,
  DELETE_QUESTION,
  ASSIGN_QUESTION_TO_CITYPE,
  REMOVE_QUESTION_FROM_CITYPE,
  SET_QUESTION_CORE,
} from '@/graphql/mutations'
import { QUESTION_CATEGORY } from '@/lib/taskStatus'
import { Pill } from '@/components/ui/Pill'
import { inputS } from '@/components/ui/styles'

type QuestionCategoryKey = typeof QUESTION_CATEGORY[keyof typeof QUESTION_CATEGORY]

interface AnswerOption {
  id?:       string
  label:     string
  score:     number
  sortOrder: number
}

interface Question {
  id:        string
  text:      string
  category:  string
  isCore:    boolean
  isActive:  boolean
  createdAt: string
  options:   AnswerOption[]
}

interface CIType {
  id:     string
  name:   string
  label:  string
  active: boolean
}

interface CITypeAssignment {
  ciTypeId:   string
  ciTypeName: string
  weight:     number
  sortOrder:  number
}

// ── Styles ────────────────────────────────────────────────────────────────────

// Shared input style (E-09); the page keeps its own uppercase small-caps label.
const inputStyle: React.CSSProperties = inputS

const labelStyle: React.CSSProperties = {
  display: 'block', fontSize: 'var(--font-size-label)', fontWeight: 600,
  color: 'var(--color-slate-light)', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 6,
}

const CATEGORY_COLORS: Record<string, { bg: string; color: string }> = {
  functional: { bg: '#dbeafe', color: '#2563eb' },
  technical:  { bg: '#dcfce7', color: 'var(--color-success)' },
}

function CategoryBadge({ category }: { category: string }) {
  // Unknown category → visible red pill + console error, not a benign grey.
  const s = lookupOrError(CATEGORY_COLORS, category, 'CATEGORY_COLORS', { bg: 'var(--color-danger)', color: '#fff' })
  return (
    <Pill bg={s.bg} color={s.color} style={{ fontSize: 'var(--font-size-label)', textTransform: 'uppercase' }}>
      {category}
    </Pill>
  )
}

/**
 * Numeric field that saves on blur/Enter only when the value changed, and is
 * disabled while the save is in flight. Saving on every keystroke sent "1"
 * then "12" and let the slower response win (E-15).
 */
function CommitNumberInput({ value, onCommit, disabled, title, min }: {
  value: number; onCommit: (v: number) => void; disabled: boolean; title: string; min: number
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  const commit = () => {
    const n = parseInt(draft, 10)
    if (Number.isNaN(n) || n < min) { setDraft(String(value)); return }
    if (n !== value) onCommit(n)
  }
  return (
    <input
      type="number"
      min={min}
      value={draft}
      disabled={disabled}
      onChange={e => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() } }}
      style={{ ...inputStyle, width: 80, opacity: disabled ? 0.6 : 1 }}
      title={title}
    />
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

export function QuestionAdminPage() {
  const { t } = useTranslation()
  const confirm = useConfirm()
  const { data: qData, refetch: refetchQuestions } = useQuery<{ assessmentQuestionsAdmin: Question[] }>(GET_QUESTIONS_ADMIN, {
    fetchPolicy: 'cache-and-network',
  })
  const { data: typesData } = useQuery<{ ciTypes: CIType[] }>(GET_CI_TYPES)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [filterCat,  setFilterCat]  = useState<string>('')

  // Editor state
  const [text,      setText]     = useState('')
  const [category,  setCategory] = useState<QuestionCategoryKey>(QUESTION_CATEGORY.FUNCTIONAL)
  const [isCore,    setIsCore]   = useState(true)
  const [isActive,  setIsActive] = useState(true)
  const [options,   setOptions]  = useState<AnswerOption[]>([])
  const [isNew,     setIsNew]    = useState(false)

  const allQuestions = qData?.assessmentQuestionsAdmin ?? []
  const questions = allQuestions.filter(q =>
    !filterCat || (q.category ?? '').toLowerCase() === filterCat.toLowerCase()
  )
  const ciTypes   = (typesData?.ciTypes ?? []).filter(t => t.active)

  const selected = questions.find(q => q.id === selectedId) ?? null

  useEffect(() => {
    if (selected) {
      setText(selected.text)
      setCategory(selected.category as QuestionCategoryKey)
      setIsCore(selected.isCore)
      setIsActive(selected.isActive)
      setOptions(selected.options.map(o => ({ id: o.id, label: o.label, score: o.score, sortOrder: o.sortOrder })))
      setIsNew(false)
    }
  }, [selectedId]) // eslint-disable-line react-hooks/exhaustive-deps

  const { data: assignData, refetch: refetchAssignments } = useQuery<{ questionCITypeAssignments: CITypeAssignment[] }>(
    GET_QUESTION_CITYPE_ASSIGNMENTS,
    { variables: { questionId: selectedId ?? '' }, skip: !selectedId || isCore },
  )
  const assignments = assignData?.questionCITypeAssignments ?? []

  // Errors → toast with the server message (useMutationWithToast).
  const [createQuestion] = useMutationWithToast<{ createAssessmentQuestion: { id: string } }>(CREATE_QUESTION, {
    successMessage: 'Domanda creata',
    onSuccess: (data) => {
      void refetchQuestions().then(() => {
        if (data?.createAssessmentQuestion?.id) setSelectedId(data.createAssessmentQuestion.id)
        setIsNew(false)
      })
    },
  })
  const [updateQuestion] = useMutationWithToast(UPDATE_QUESTION, {
    successMessage: 'Domanda aggiornata', refetch: refetchQuestions,
  })
  const [deleteQuestion] = useMutationWithToast(DELETE_QUESTION, {
    successMessage: 'Domanda eliminata', onSuccess: () => setSelectedId(null), refetch: refetchQuestions,
  })
  const [assignToCIType, { loading: assigning }] = useMutationWithToast(ASSIGN_QUESTION_TO_CITYPE, {
    refetch: refetchAssignments,
  })
  const [removeFromCIType, { loading: removing }] = useMutationWithToast(REMOVE_QUESTION_FROM_CITYPE, {
    refetch: refetchAssignments,
  })
  const [setCore] = useMutationWithToast(SET_QUESTION_CORE, {
    onSuccess: () => { void refetchQuestions(); void refetchAssignments() },
  })
  const assignmentBusy = assigning || removing

  const handleNew = () => {
    setSelectedId(null)
    setText('')
    setCategory(QUESTION_CATEGORY.FUNCTIONAL)
    setIsCore(true)
    setIsActive(true)
    setOptions([{ label: '', score: 0, sortOrder: 0 }])
    setIsNew(true)
  }

  const handleSave = () => {
    if (!text.trim()) { toast.error('Testo obbligatorio'); return }
    if (options.length === 0) { toast.error('Almeno una opzione'); return }
    const optInput = options.map(o => ({ label: o.label, score: o.score, sortOrder: o.sortOrder }))
    if (isNew) {
      void createQuestion({ variables: { input: { text: text.trim(), category, isCore, options: optInput } } })
    } else if (selectedId) {
      void updateQuestion({ variables: { id: selectedId, input: { text: text.trim(), category, isCore, isActive, options: optInput } } })
    }
  }

  const handleDelete = async () => {
    if (!selectedId) return
    if (!(await confirm({ title: t('admin.questions.deleteTitle'), body: t('admin.questions.deleteBody'), danger: true }))) return
    void deleteQuestion({ variables: { id: selectedId } })
  }

  const handleToggleCore = (newCore: boolean) => {
    if (!selectedId) { setIsCore(newCore); return }
    setIsCore(newCore)
    void setCore({ variables: { questionId: selectedId, isCore: newCore } })
  }

  const updateOption = (idx: number, patch: Partial<AnswerOption>) => {
    setOptions(p => p.map((o, i) => i === idx ? { ...o, ...patch } : o))
  }
  const addOption = () => setOptions(p => [...p, { label: '', score: 0, sortOrder: p.length }])
  const removeOption = (idx: number) => setOptions(p => p.filter((_, i) => i !== idx))
  const moveOption = (idx: number, dir: -1 | 1) => {
    setOptions(p => {
      const arr = [...p]
      const j = idx + dir
      if (j < 0 || j >= arr.length) return p
      const a = arr[idx]!; const b = arr[j]!
      arr[idx] = b; arr[j] = a
      return arr.map((o, i) => ({ ...o, sortOrder: i }))
    })
  }

  return (
    <PageContainer>
      <PageTitle icon={<HelpCircle size={22} color="var(--color-brand)" />}>
        Assessment Questions
      </PageTitle>
      <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate)', margin: '4px 0 20px' }}>
        Gestisci le domande usate nell'assessment dei change RFC e la loro assegnazione ai tipi di CI.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 20, alignItems: 'start' }}>

        {/* Left: question list */}
        <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <h3 style={{ margin: 0, fontSize: 'var(--font-size-card-title)', color: 'var(--color-slate-dark)' }}>
              Domande ({questions.length}{filterCat && questions.length !== allQuestions.length ? ` / ${allQuestions.length}` : ''})
            </h3>
            <button
              type="button"
              onClick={handleNew}
              style={{
                padding: '6px 12px', borderRadius: 6, border: 'none',
                background: 'var(--color-brand)', color: '#fff',
                fontSize: 'var(--font-size-body)', fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
            >
              <Plus size={14} /> Nuova
            </button>
          </div>

          <select
            value={filterCat}
            onChange={e => setFilterCat(e.target.value)}
            style={{ ...inputStyle, marginBottom: 12 }}
          >
            <option value="">Tutte le categorie</option>
            <option value="functional">Functional</option>
            <option value="technical">Technical</option>
          </select>

          <div style={{ maxHeight: 600, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
            {questions.map(q => {
              const active = q.id === selectedId
              return (
                <button
                  type="button"
                  key={q.id}
                  aria-pressed={active}
                  onClick={() => setSelectedId(q.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', font: 'inherit',
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: active ? '1.5px solid var(--color-brand)' : '1px solid var(--border)',
                    cursor: 'pointer',
                    background: active ? 'var(--color-brand-light)' : '#fff',
                  }}
                >
                  <div style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', marginBottom: 6, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                    {q.text}
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <CategoryBadge category={q.category} />
                    {q.isCore && (
                      <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#f1f5f9', color: 'var(--color-slate)' }}>CORE</span>
                    )}
                    {!q.isActive && (
                      <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '2px 6px', borderRadius: 4, background: '#fee2e2', color: '#b91c1c' }}>INATTIVA</span>
                    )}
                  </div>
                </button>
              )
            })}
            {questions.length === 0 && (
              <p style={{ color: 'var(--color-slate-light)', fontSize: 'var(--font-size-body)' }}>Nessuna domanda</p>
            )}
          </div>
        </div>

        {/* Right: editor panel */}
        <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 10, padding: 20 }}>
          {!selectedId && !isNew && (
            <div style={{ padding: 40, textAlign: 'center', color: 'var(--color-slate-light)' }}>
              Seleziona una domanda o creane una nuova
            </div>
          )}
          {(selectedId || isNew) && (
            <>
              <div style={{ marginBottom: 16 }}>
                <label style={labelStyle}>Testo</label>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  rows={3}
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <div>
                  <label style={labelStyle}>Categoria</label>
                  <select value={category} onChange={e => setCategory(e.target.value as QuestionCategoryKey)} style={inputStyle} title="Categoria della domanda">
                    {Object.values(QUESTION_CATEGORY).map((v) => (
                      <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label style={labelStyle}>Flags</label>
                  <div style={{ display: 'flex', gap: 16, paddingTop: 8 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                      <input type="checkbox" checked={isCore} onChange={e => handleToggleCore(e.target.checked)} />
                      Core
                    </label>
                    {!isNew && (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                        <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
                        Attiva
                      </label>
                    )}
                  </div>
                </div>
              </div>

              {/* CIType assignments — visibile direttamente quando Core è OFF */}
              {!isCore && (
                <div style={{ marginBottom: 16 }}>
                  <label style={labelStyle}>Assegnazioni CI Type</label>
                  {isNew ? (
                    <p style={{ fontSize: 'var(--font-size-body)', color: 'var(--color-slate-light)', margin: 0, padding: '8px 0' }}>
                      Salva la domanda per poterla assegnare a CI Type specifici.
                    </p>
                  ) : (
                    ciTypes.map(ct => {
                      const assign = assignments.find(a => a.ciTypeId === ct.id)
                      const assigned = !!assign
                      return (
                        <div key={ct.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderBottom: '1px solid #f3f4f6' }}>
                          <input
                            type="checkbox"
                            checked={assigned}
                            disabled={assignmentBusy}
                            onChange={e => {
                              if (e.target.checked) {
                                void assignToCIType({ variables: { questionId: selectedId, ciTypeId: ct.id, weight: 1, sortOrder: 0 } })
                              } else {
                                void removeFromCIType({ variables: { questionId: selectedId, ciTypeId: ct.id } })
                              }
                            }}
                          />
                          <span style={{ flex: 1, fontSize: 'var(--font-size-body)', color: 'var(--color-slate-dark)' }}>{ct.label}</span>
                          {assigned && (
                            <>
                              <CommitNumberInput
                                value={assign.weight}
                                min={1}
                                disabled={assignmentBusy}
                                onCommit={w => void assignToCIType({ variables: { questionId: selectedId, ciTypeId: ct.id, weight: w, sortOrder: assign.sortOrder } })}
                                title="Weight"
                              />
                              <CommitNumberInput
                                value={assign.sortOrder}
                                min={0}
                                disabled={assignmentBusy}
                                onCommit={s => void assignToCIType({ variables: { questionId: selectedId, ciTypeId: ct.id, weight: assign.weight, sortOrder: s } })}
                                title="Sort order"
                              />
                            </>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              )}

              {isCore && !isNew && (
                <div style={{ marginBottom: 16, padding: 10, background: '#f1f5f9', borderRadius: 6, fontSize: 'var(--font-size-body)', color: 'var(--color-slate)' }}>
                  Questa domanda è <strong>core</strong>: assegnata automaticamente a tutti i CI Type attivi.
                </div>
              )}

              <div style={{ marginBottom: 16 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <label style={{ ...labelStyle, marginBottom: 0 }}>Opzioni</label>
                  <button type="button" onClick={addOption} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-brand)', fontSize: 'var(--font-size-body)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Plus size={12} /> Aggiungi
                  </button>
                </div>
                {options.map((opt, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
                    <input
                      type="text"
                      value={opt.label}
                      onChange={e => updateOption(i, { label: e.target.value })}
                      placeholder="Label"
                      style={{ ...inputStyle, flex: 2 }}
                    />
                    <input
                      type="number"
                      value={opt.score}
                      onChange={e => updateOption(i, { score: parseInt(e.target.value, 10) || 0 })}
                      placeholder="Score"
                      style={{ ...inputStyle, width: 90 }}
                    />
                    <button type="button" onClick={() => moveOption(i, -1)} disabled={i === 0} style={{ background: 'none', border: '1px solid var(--border)', cursor: i === 0 ? 'not-allowed' : 'pointer', padding: 6, borderRadius: 4 }}>
                      <ChevronUp size={12} />
                    </button>
                    <button type="button" onClick={() => moveOption(i, 1)} disabled={i === options.length - 1} style={{ background: 'none', border: '1px solid var(--border)', cursor: i === options.length - 1 ? 'not-allowed' : 'pointer', padding: 6, borderRadius: 4 }}>
                      <ChevronDown size={12} />
                    </button>
                    <button type="button" onClick={() => removeOption(i)} style={{ background: 'none', border: '1px solid #fecaca', color: 'var(--color-danger)', cursor: 'pointer', padding: 6, borderRadius: 4 }}>
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #f3f4f6', paddingTop: 16 }}>
                {!isNew && selectedId && (
                  <button
                    type="button"
                    onClick={handleDelete}
                    style={{ padding: '8px 16px', borderRadius: 8, border: '1.5px solid var(--color-danger)', background: '#fff', color: 'var(--color-danger)', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
                  >
                    <Trash2 size={14} /> Elimina
                  </button>
                )}
                <div style={{ marginLeft: 'auto' }}>
                  <button
                    type="button"
                    onClick={handleSave}
                    style={{ padding: '8px 24px', borderRadius: 8, border: 'none', background: 'var(--color-brand)', color: '#fff', fontWeight: 600, cursor: 'pointer' }}
                  >
                    Salva
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </PageContainer>
  )
}
