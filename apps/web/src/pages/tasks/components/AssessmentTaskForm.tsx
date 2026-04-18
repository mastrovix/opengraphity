/**
 * Pure form for filling assessment questions. The task's current responses
 * come from the server; every answer change fires `onSubmitAnswer`, and
 * "complete" is only enabled when the count matches the catalog.
 */
import { TASK_STATUS } from '@/lib/taskStatus'
import type { AssessmentTaskData, QuestionData } from '@/types/change'
import { StickyAction, inputStyle } from './shared'

interface CatalogEntry { weight: number; sortOrder: number; question: QuestionData }

export function AssessmentTaskForm({ task, catalog, canEdit, onSubmitAnswer, onComplete }: {
  task: AssessmentTaskData
  catalog: CatalogEntry[]
  canEdit: boolean
  onSubmitAnswer: (questionId: string, optionId: string) => void
  onComplete: () => void
}) {
  return (
    <div>
      {catalog.map((entry) => {
        const q = entry.question
        const selectedId = task.responses.find(r => r.question.id === q.id)?.selectedOption.id ?? null
        return (
          <div key={q.id} style={{ marginBottom: 16, paddingBottom: 16, borderBottom: '1px solid #f3f4f6' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8 }}>
              <span style={{ fontSize: 'var(--font-size-body)', fontWeight: 500, color: 'var(--color-slate-dark)', flex: 1 }}>{q.text}</span>
              <span style={{ fontSize: 'var(--font-size-label)', fontWeight: 600, padding: '2px 6px', borderRadius: 4, backgroundColor: '#f1f5f9', color: 'var(--color-slate)', whiteSpace: 'nowrap' }}>W:{entry.weight}</span>
            </div>
            <select
              disabled={!canEdit || task.status === TASK_STATUS.COMPLETED}
              value={selectedId ?? ''}
              onChange={(e) => { if (e.target.value) onSubmitAnswer(q.id, e.target.value) }}
              style={{ ...inputStyle, maxWidth: 400 }}
            >
              <option value="">— Seleziona —</option>
              {q.options.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </div>
        )
      })}
      {task.status !== TASK_STATUS.COMPLETED && (
        <StickyAction
          label={`Completa (${task.responses.length}/${catalog.length})`}
          disabled={!canEdit || task.responses.length < catalog.length}
          blockReason={!canEdit ? 'Non sei nel team corretto per completare questa task' : undefined}
          onClick={onComplete}
        />
      )}
    </div>
  )
}
