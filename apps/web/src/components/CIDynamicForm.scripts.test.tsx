/**
 * CIDynamicForm — the metamodel scripts, in the cases where timing matters.
 *
 * Default and visibility scripts run in a sandbox, asynchronously, and run
 * again every time a value changes. Three things a user depends on:
 * - a default is computed only for the fields that declare one, and the
 *   defaults CONVERGE: a default that already equals the value writes
 *   nothing, otherwise the form would re-run the scripts forever;
 * - an answer that arrives for values the user has already changed is stale:
 *   it must neither overwrite what the user typed nor block the form with an
 *   error that no longer applies;
 * - a CI type without system relations (an older metamodel) still opens.
 *
 * The 300 ms debounce of the defaults runs on fake timers, so the test never
 * waits for real time.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { CITypeDef, CIFieldDef } from '@/contexts/MetamodelContext'
import { Providers } from '@/test/utils'
import { apolloFinto } from '@/test/apolloFinto'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())
const validator = vi.hoisted(() => ({
  validateCI: vi.fn(),
  isFieldVisible: vi.fn(),
  getFieldDefault: vi.fn(),
}))
vi.mock('@/lib/ciValidator', () => validator)

const { CIDynamicForm } = await import('./CIDynamicForm')

const field = (over: Partial<CIFieldDef>): CIFieldDef => ({
  id: over.name ?? 'f', name: 'f', label: 'F', fieldType: 'string', required: false,
  enumValues: [], order: 1, isSystem: false,
  validationScript: null, visibilityScript: null, defaultScript: null, ...over,
} as CIFieldDef)

const ciType = (fields: CIFieldDef[], systemRelations?: CITypeDef['systemRelations']): CITypeDef => ({
  id: 'ct-1', name: 'database', label: 'Database', icon: '', color: '', active: true,
  scope: 'base', tenantId: 'system', validationScript: null, chainFamilies: [], serviceRole: null,
  fields, relations: [], systemRelations: systemRelations as CITypeDef['systemRelations'],
})

const TYPE = ciType([
  field({ name: 'engine', label: 'Engine', order: 1 }),
  field({ name: 'port', label: 'Port', defaultScript: 'return 5432', order: 2 }),
], [])

/** A promise settled by the test, to decide when a script answers. */
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Lets the debounce elapse and every pending script answer land. */
const elapse = async (ms: number) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms) }) }

function mount(type: CITypeDef = TYPE, initial?: Record<string, unknown>) {
  return render(
    <CIDynamicForm ciType={type} initialValues={initial} onSubmit={vi.fn(async () => {})} onCancel={vi.fn()} />,
    { wrapper: ({ children }) => <Providers>{children}</Providers> },
  )
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  apolloFinto.reset()
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { fields: [
    { name: 'status', fieldType: 'enum', enumValues: ['active'] },
    { name: 'environment', fieldType: 'enum', enumValues: ['production'] },
  ] } }
  validator.validateCI.mockReset().mockResolvedValue({ valid: true, errors: {} })
  validator.isFieldVisible.mockReset().mockResolvedValue(true)
  validator.getFieldDefault.mockReset().mockResolvedValue(null)
})

afterEach(() => { vi.useRealTimers() })

describe('CIDynamicForm — default scripts', () => {
  it('a default is computed only for the fields that declare a default script', async () => {
    validator.getFieldDefault.mockResolvedValue('5432')
    mount()
    await elapse(300)
    expect(screen.getByLabelText('Port')).toHaveValue('5432')
    expect(validator.getFieldDefault.mock.calls.map((c) => c[0])).toEqual(['port'])
  })

  it('the defaults converge: a default equal to the current value writes nothing and does not run again', async () => {
    validator.getFieldDefault.mockResolvedValue('5432')
    mount(TYPE, { port: '5432' })
    await elapse(300)
    await elapse(3000)
    expect(validator.getFieldDefault).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Port')).toHaveValue('5432')
  })

  it('a default script that has nothing to propose leaves the field as it is', async () => {
    mount(TYPE, { port: '1521' })
    await elapse(300)
    await elapse(3000)
    expect(validator.getFieldDefault).toHaveBeenCalledTimes(1)
    expect(screen.getByLabelText('Port')).toHaveValue('1521')
  })

  it('a default computed for values the user has since changed is dropped, not written over the form', async () => {
    const stale = deferred<string>()
    validator.getFieldDefault
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue('3306')
    mount()
    await elapse(300)
    // The user changes a value while the first answer is still out.
    fireEvent.change(screen.getByLabelText('Engine'), { target: { value: 'mysql' } })
    await elapse(300)
    expect(screen.getByLabelText('Port')).toHaveValue('3306')
    await act(async () => { stale.resolve('5432') })
    expect(screen.getByLabelText('Port')).toHaveValue('3306')
  })

  it('a default script failing for values the user has since changed does not block the form', async () => {
    const stale = deferred<string>()
    validator.getFieldDefault
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue(null)
    mount()
    await elapse(300)
    fireEvent.change(screen.getByLabelText('Engine'), { target: { value: 'mysql' } })
    await elapse(300)
    await act(async () => { stale.reject(new Error('old default exploded')) })
    expect(screen.queryByText('old default exploded')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })
})

describe('CIDynamicForm — visibility scripts', () => {
  it('a visibility script failing for values the user has since changed does not block the form', async () => {
    const stale = deferred<boolean>()
    validator.isFieldVisible
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue(true)
    mount(ciType([field({ name: 'engine', label: 'Engine' })], []))
    // The base fields are there at once; typing the name starts a new evaluation.
    fireEvent.change(screen.getByLabelText('Name*'), { target: { value: 'db-01' } })
    await elapse(0)
    expect(screen.getByLabelText('Engine')).toBeInTheDocument()
    await act(async () => { stale.reject(new Error('old visibility crashed')) })
    expect(screen.queryByText('old visibility crashed')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })
})

describe('CIDynamicForm — an older metamodel', () => {
  it('a CI type without system relations opens, with no group to choose and no team query', async () => {
    mount(ciType([field({ name: 'engine', label: 'Engine' })], undefined))
    await elapse(0)
    expect(screen.getByLabelText('Engine')).toBeInTheDocument()
    expect(screen.queryByLabelText(/Owner group/i)).not.toBeInTheDocument()
    expect(apolloFinto.chiamate['GetTeams']).toBeUndefined()
  })
})
