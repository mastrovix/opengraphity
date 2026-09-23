/**
 * THE FIELDS A USER CAN FILTER ON, AND THE FIELDS AN AUTOMATION CAN TALK ABOUT.
 *
 * Every list page (incidents, problems, requests, events) builds its filter
 * panel from `useEntityFields`, and every automation editor builds its field
 * menus from `useEntityFieldMetas` / `useFormFieldMetas`. If these regress the
 * user sees it at once, and in ways that are hard to diagnose:
 *  - a vocabulary field (priority, severity) offered as free text, so a filter
 *    on "high" silently matches nothing because the value is `p1`;
 *  - the ticket status offered with raw step names instead of the tenant's
 *    workflow labels;
 *  - a numeric/boolean field offered with text operators the API rejects;
 *  - an automation menu offering a catalog-form field the server refuses to
 *    write, or a field type the condition editor cannot render;
 *  - an unknown entity type producing an empty menu with no explanation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import {
  useEntityFields, useEntityFieldMetas, useEntityFieldLookup, useFormFieldMetas,
} from './useEntityFields'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const vocab: DomainVocabularies = {
  valuesOf: () => null,
  labelOf: (name, value) => (name === 'priority' && value === 'p1' ? 'Critical' : null),
  colorOf: () => null,
  entriesOf: () => null,
  vocabularyLabelOf: () => null,
  loading: false,
  error: null,
}
const wrapper = ({ children }: { children: ReactNode }) => (
  <DomainVocabularyContext.Provider value={vocab}>{children}</DomainVocabularyContext.Provider>
)

type Raw = {
  name: string; kind?: 'SCALAR' | 'ENUM'; scalarName?: string | null; enumValues?: string[] | null
  label?: string | null; choices?: { value: string; label: string }[]; formFieldType?: string | null
  vocabulary?: string | null; multi?: boolean; rowFilter?: boolean; settableByAutomation?: boolean
}
const raw = (f: Raw) => ({
  kind: 'SCALAR', scalarName: 'String', enumValues: null, label: null, choices: [], formFieldType: null,
  vocabulary: null, multi: false, rowFilter: false, settableByAutomation: false, ...f,
})

const itilTypes = {
  itilTypes: [{
    name: 'incident',
    fields: [
      { name: 'title', label: 'Title', fieldType: 'string' },
      { name: 'priority', label: 'Priority', fieldType: 'enum', enumValues: ['p1', 'p2'], enumTypeName: 'priority' },
      { name: 'priority', label: 'Priority (dup)', fieldType: 'enum', enumValues: ['x'], enumTypeName: 'priority' },
      { name: 'root_cause', label: 'Root cause', fieldType: 'enum', enumValues: ['hw'], enumTypeName: null },
      { name: 'assigned_to', label: 'Owner', fieldType: 'user' },
    ],
  }],
}

beforeEach(() => { apolloFinto.reset() })

describe('useEntityFieldMetas', () => {
  it('returns nothing and asks nothing when no entity type is given', () => {
    const { result } = renderHook(() => useEntityFieldMetas(''), { wrapper })
    expect(result.current).toEqual({ fields: [], error: null })
    // Neither metamodel query runs: an empty entity has no fields to ask for.
    expect(apolloFinto.chiamate['GetITILTypes']).toBeUndefined()
    expect(apolloFinto.chiamate['GetCITypes']).toBeUndefined()
  })

  it('reads ITIL fields once per name and adds only the missing virtual relations', () => {
    apolloFinto.risposte['GetITILTypes'] = itilTypes
    const { result } = renderHook(() => useEntityFieldMetas('incident'), { wrapper })
    const names = result.current.fields.map((f) => f.name)
    // The duplicate "priority" is dropped; assigned_to is declared by the type
    // so only assigned_team is added.
    expect(names).toEqual(['title', 'priority', 'root_cause', 'assigned_to', 'assigned_team'])
    expect(result.current.fields.find((f) => f.name === 'assigned_to')?.fieldType).toBe('user')
    expect(result.current.fields.find((f) => f.name === 'assigned_team')?.label).toBeTruthy()
    expect(result.current.fields.find((f) => f.name === 'priority')).toMatchObject({ enumValues: ['p1', 'p2'], enumTypeName: 'priority' })
    expect(result.current.fields.find((f) => f.name === 'title')).toMatchObject({ enumValues: [], enumTypeName: null })
    expect(apolloFinto.chiamate['GetCITypes']).toBeUndefined()
  })

  it('omits the virtual relations when asked', () => {
    apolloFinto.risposte['GetITILTypes'] = itilTypes
    const { result } = renderHook(() => useEntityFieldMetas('incident', { withVirtual: false }), { wrapper })
    expect(result.current.fields.map((f) => f.name)).not.toContain('assigned_team')
  })

  it('reads CI fields from the CI metamodel', () => {
    apolloFinto.risposte['GetCITypes'] = { ciTypes: [{ name: 'server', fields: [{ name: 'os', label: 'OS', fieldType: 'string', enumValues: null }] }] }
    const { result } = renderHook(() => useEntityFieldMetas('server'), { wrapper })
    expect(result.current.fields.map((f) => f.name)).toEqual(['os', 'assigned_to', 'assigned_team'])
    expect(apolloFinto.chiamate['GetITILTypes']).toBeUndefined()
  })

  it('is empty without an error while the metamodel is still loading', () => {
    const { result } = renderHook(() => useEntityFieldMetas('server'), { wrapper })
    expect(result.current).toEqual({ fields: [], error: null })
  })

  it('says so when the type is not in the metamodel, instead of an unexplained empty menu', () => {
    apolloFinto.risposte['GetCITypes'] = { ciTypes: [] }
    const { result } = renderHook(() => useEntityFieldMetas('firewall'), { wrapper })
    expect(result.current.fields).toEqual([])
    expect(result.current.error).toMatch(/firewall/)
  })

  it('surfaces the query error of the metamodel it reads', () => {
    apolloFinto.erroriQuery['GetITILTypes'] = new Error('metamodel down')
    const { result } = renderHook(() => useEntityFieldMetas('incident'), { wrapper })
    expect(result.current).toEqual({ fields: [], error: 'metamodel down' })
  })
})

describe('useFormFieldMetas', () => {
  const formFields = {
    entityFilterFields: [
      raw({ name: 'env', label: 'Environment', formFieldType: 'enum', enumValues: ['prod'], vocabulary: 'env', settableByAutomation: true }),
      raw({ name: 'notes', formFieldType: 'textarea', enumValues: null }),
      raw({ name: 'when', label: 'When', formFieldType: 'datetime', settableByAutomation: true }),
      raw({ name: 'file', label: 'File', formFieldType: 'attachment' }),
      raw({ name: 'title', label: 'Title' }),
    ],
  }

  it('only asks for service requests, the only tickets that fill a form', () => {
    const { result } = renderHook(() => useFormFieldMetas('incident'), { wrapper })
    expect(result.current).toEqual([])
    expect(apolloFinto.chiamate['EntityFilterFields']).toBeUndefined()
  })

  it('maps form types to the automation vocabulary and drops the ones without a match', () => {
    apolloFinto.risposte['EntityFilterFields'] = formFields
    const { result } = renderHook(() => useFormFieldMetas('service_request'), { wrapper })
    expect(apolloFinto.chiamata('EntityFilterFields')).toEqual({ typeName: 'ServiceRequest' })
    // "attachment" has no automation counterpart and "title" is not a form field.
    expect(result.current).toEqual([
      { name: 'env', label: 'Environment', fieldType: 'enum', enumValues: ['prod'], enumTypeName: 'env' },
      // No server label: the name is the fallback, never an empty menu entry.
      { name: 'notes', label: 'notes', fieldType: 'string', enumValues: [], enumTypeName: null },
      { name: 'when', label: 'When', fieldType: 'date', enumValues: [], enumTypeName: null },
    ])
  })

  it('offers only writable fields to actions', () => {
    apolloFinto.risposte['EntityFilterFields'] = formFields
    const { result } = renderHook(() => useFormFieldMetas('service_request', { soloScrivibili: true }), { wrapper })
    expect(result.current.map((f) => f.name)).toEqual(['env', 'when'])
  })
})

describe('useEntityFieldLookup', () => {
  it('indexes metamodel fields and adds form fields without overriding a metamodel one', () => {
    apolloFinto.risposte['GetITILTypes'] = {
      itilTypes: [{ name: 'service_request', fields: [{ name: 'env', label: 'Env (metamodel)', fieldType: 'string' }] }],
    }
    apolloFinto.risposte['EntityFilterFields'] = {
      entityFilterFields: [
        raw({ name: 'env', label: 'Env (form)', formFieldType: 'text' }),
        raw({ name: 'region', label: 'Region', formFieldType: 'text' }),
      ],
    }
    const { result } = renderHook(() => useEntityFieldLookup('service_request'), { wrapper })
    expect(result.current.get('env')?.label).toBe('Env (metamodel)')
    expect(result.current.get('region')?.label).toBe('Region')
    expect(result.current.has('assigned_team')).toBe(true)
  })
})

describe('useEntityFields', () => {
  it('is empty while loading and passes the query error through', () => {
    apolloFinto.erroriQuery['EntityFilterFields'] = new Error('boom')
    const { result } = renderHook(() => useEntityFields('Incident'), { wrapper })
    expect(result.current.fields).toEqual([])
    expect(result.current.error?.message).toBe('boom')
  })

  it('builds the filter fields of an ITIL ticket from schema, metamodel, vocabulary and workflow', () => {
    apolloFinto.risposte['GetITILTypes'] = itilTypes
    apolloFinto.risposte['GetWorkflowDefinition'] = {
      workflowDefinition: {
        transitions: [],
        steps: [{ id: 's1', name: 'new', label: 'Brand new', labels: [], type: 'standard', isInitial: true, isTerminal: false, isOpen: true, category: null, purpose: null, order: 1 }],
      },
    }
    apolloFinto.risposte['EntityFilterFields'] = {
      entityFilterFields: [
        raw({ name: 'id', scalarName: 'ID' }),
        raw({ name: '__typename' }),
        raw({ name: 'state', kind: 'ENUM', enumValues: ['in_progress'], choices: [] }),
        raw({ name: 'kind', kind: 'ENUM', label: 'Kind', choices: [{ value: 'a', label: 'Alpha' }], multi: true, rowFilter: true }),
        raw({ name: 'status' }),
        raw({ name: 'priority' }),
        raw({ name: 'rootCause' }),
        raw({ name: 'title' }),
        raw({ name: 'reopened', scalarName: 'Boolean' }),
        raw({ name: 'count', scalarName: 'Int' }),
        raw({ name: 'score', scalarName: 'Float' }),
        raw({ name: 'createdAt' }),
        raw({ name: 'dueDate' }),
        raw({ name: 'tags', scalarName: null, multi: true, rowFilter: true }),
      ],
    }
    const { result } = renderHook(() => useEntityFields('Incident'), { wrapper })
    expect(result.current.error).toBeNull()
    const byKey = new Map(result.current.fields.map((f) => [f.key, f]))
    // Ids, typename and non-textual scalars are not filterable as text.
    expect([...byKey.keys()]).toEqual(['state', 'kind', 'status', 'priority', 'rootCause', 'title', 'createdAt', 'dueDate', 'tags'])

    // A schema enum without dictionary choices: the value, cleaned up.
    // D29: the one shared rule — a machine key becomes a sentence, not Title Case.
    expect(byKey.get('state')).toMatchObject({ label: 'State', type: 'enum', options: [{ value: 'in_progress', label: 'In progress' }] })
    expect(byKey.get('state')).not.toHaveProperty('operators')
    // A table-row enum list: list type and only the relation operators.
    expect(byKey.get('kind')).toMatchObject({ label: 'Kind', type: 'multi_enum', options: [{ value: 'a', label: 'Alpha' }] })
    expect(byKey.get('kind')?.operators).toEqual(['equals', 'contains', 'is_empty', 'is_not_empty'])
    // Status uses the tenant's workflow steps, with their labels.
    expect(byKey.get('status')).toMatchObject({ type: 'enum', options: [{ value: 'new', label: 'Brand new' }] })
    // A metamodel vocabulary field becomes a choice with the dictionary label,
    // falling back to the raw value when the dictionary has no label.
    expect(byKey.get('priority')).toMatchObject({ type: 'enum', options: [{ value: 'p1', label: 'Critical' }, { value: 'p2', label: 'p2' }] })
    // camelCase schema name matched to the snake_case metamodel field; no vocabulary name → raw value.
    expect(byKey.get('rootCause')).toMatchObject({ label: 'Root cause', type: 'enum', options: [{ value: 'hw', label: 'hw' }] })
    expect(byKey.get('title')).toMatchObject({ label: 'Title', type: 'text' })
    expect(byKey.get('createdAt')).toMatchObject({ label: 'Created At', type: 'date' })
    expect(byKey.get('dueDate')?.type).toBe('date')
    expect(byKey.get('tags')).toMatchObject({ type: 'multi_enum', operators: ['equals', 'contains', 'is_empty', 'is_not_empty'] })
  })

  it('does not consult the metamodel or workflow for a non-ITIL entity', () => {
    apolloFinto.risposte['EntityFilterFields'] = { entityFilterFields: [raw({ name: 'status' })] }
    const { result } = renderHook(() => useEntityFields('Event'), { wrapper })
    // Without a workflow, status stays a text field.
    expect(result.current.fields).toEqual([{ key: 'status', label: 'Status', type: 'text' }])
    expect(apolloFinto.chiamate['GetWorkflowDefinition']).toBeUndefined()
    expect(apolloFinto.chiamate['GetITILTypes']).toBeUndefined()
  })
})
