/**
 * What the form-builder tests share: a small catalog, a field library and the
 * published forms, answered by operation name through the fake Apollo, plus
 * the few ways a test reads the canvas the way an administrator does.
 *
 * One rule matters more than the data: every answer is a STABLE object. The
 * panel reloads its draft in an effect keyed on the query result, so an answer
 * rebuilt at every render would reload the draft forever.
 */
import type { ReactElement } from 'react'
import { expect } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import type { UserEvent } from '@testing-library/user-event'
import { emptyCatalogForm, localizedText, type CatalogFormDefinition } from '@opengraphity/types'
import { apolloFinto } from '@/test/apolloFinto'
import { DomainVocabularyContext, type DomainVocabularies } from '@/contexts/DomainVocabularyContext'
import type { FormFieldRow } from '../FieldLibraryPanel'

/** A library field; shared unless the test says otherwise. */
export function libraryField(name: string, fieldType: string, label: string, extra: Partial<FormFieldRow> = {}): FormFieldRow {
  return {
    id: `f-${name}`, name, fieldType, label, labels: [], help: null, helps: [], required: false,
    vocabulary: null, inList: false, formula: null, validationScript: null, tableDefinition: null,
    usedBy: [], options: [], shared: true, ...extra,
  }
}

export const LIBRARY: FormFieldRow[] = [
  libraryField('requester', 'text', 'Requester'),
  libraryField('urgent', 'boolean', 'Urgent'),
  libraryField('cost_centre', 'enum', 'Cost centre', {
    vocabulary: 'cost_centres',
    options: [{ value: 'it', label: 'IT' }, { value: 'hr', label: 'HR' }],
    usedBy: ['New laptop', 'App access'],
  }),
  libraryField('budget', 'number', 'Budget'),
  libraryField('laptop_model', 'text', 'Laptop model'),
  libraryField('manager', 'ref_user', 'Manager'),
  // Private to the form that created it: never offered for reuse.
  libraryField('private_note', 'note', 'Private note', { shared: false }),
]

export const ITEMS = [
  { id: 'i-laptop', name: 'New laptop', active: true, category: 'hardware' },
  { id: 'i-access', name: 'App access', active: true, category: null },
  { id: 'i-old', name: 'Retired item', active: false, category: null },
]

export const LAPTOP_FORM: CatalogFormDefinition = {
  version: 1, revision: 3,
  sections: [
    { id: 'details', title: { en: 'Details', it: 'Dettagli' }, items: [{ field: 'requester' }, { field: 'urgent' }] },
    { id: 'money', title: { en: 'Money', it: 'Soldi' }, items: [{ field: 'cost_centre' }] },
  ],
}

/**
 * The stored forms, per item: `definition` as the API sends it (a JSON
 * string), so a test can also hand over one that cannot be read.
 */
export function answerForms(forms: Record<string, { revision: number; definition: CatalogFormDefinition | string }>): void {
  const answers = new Map(Object.entries(forms).map(([itemId, form]) => [itemId, {
    catalogForm: {
      itemId, itemName: ITEMS.find((i) => i.id === itemId)?.name ?? itemId, revision: form.revision,
      definition: typeof form.definition === 'string' ? form.definition : JSON.stringify(form.definition),
    },
  }]))
  apolloFinto.risposte['GetCatalogForm'] = (v?: Record<string, unknown>) => answers.get(String(v?.['itemId']))
}

/** The answer of a query that changes once a mutation has been called (a list read again after a creation). */
export function afterMutation<T>(mutation: string, before: T, after: T): () => T {
  return () => (apolloFinto.chiamate[mutation] ? after : before)
}

export function prepareApollo(): void {
  apolloFinto.reset()
  apolloFinto.risposte['GetServiceCatalogAdmin'] = { serviceCatalogItems: ITEMS }
  apolloFinto.risposte['GetTenantLanguageSettings'] = { tenantLanguageSettings: { available: ['en', 'it'] } }
  apolloFinto.risposte['GetFormFields'] = { formFields: LIBRARY }
  apolloFinto.risposte['GetEnumTypes'] = { enumTypes: [{ name: 'cost_centres', label: 'Cost centres' }] }
  apolloFinto.risposte['GetAISettings'] = { aiSettings: { features: { formDesigner: false } } }
  // The field editor reads the base CI enums: answered, so it does not log a missing metamodel.
  apolloFinto.risposte['GetBaseCIType'] = { baseCIType: { fields: [
    { name: 'status', fieldType: 'enum', enumValues: ['active'] },
    { name: 'environment', fieldType: 'enum', enumValues: ['production'] },
  ] } }
  answerForms({
    'i-laptop': { revision: 3, definition: LAPTOP_FORM },
    'i-access': { revision: 0, definition: emptyCatalogForm() },
  })
}

/** The customer's Dictionary: the categories and priorities a new request picks from. */
export const DICTIONARY: DomainVocabularies = {
  valuesOf: () => null, labelOf: () => null, colorOf: () => null, vocabularyLabelOf: () => null,
  entriesOf: (name) => {
    if (name === 'category') return [{ value: 'hardware', label: 'Hardware', labels: [] }, { value: 'access', label: '', labels: [] }]
    if (name === 'priority') {
      return [{ value: 'low', label: 'Low', labels: [] }, { value: 'high', label: 'High', labels: [] }, { value: 'critical', label: '', labels: [] }]
    }
    return null
  },
  loading: false, error: null,
}

export function withDictionary(ui: ReactElement): ReactElement {
  return <DomainVocabularyContext.Provider value={DICTIONARY}>{ui}</DomainVocabularyContext.Provider>
}

// ── Reading the canvas as an administrator does ──────────────────────────────

export async function chooseItem(user: UserEvent, name: string): Promise<void> {
  await user.selectOptions(screen.getByRole('combobox', { name: 'Service request' }), name)
}

/** The sections, in order, by the name their grip announces (an untitled one by its position). */
export function sectionOrder(): string[] {
  return screen.queryAllByRole('button', { name: /^Move the section «/ })
    .map((b) => /«(.*)»/.exec(b.getAttribute('aria-label') ?? '')?.[1] ?? '')
}

/**
 * The sections the canvas shows once the stored form of an item has landed,
 * named as their grips name them. The draft is loaded by an effect AFTER the
 * item is chosen: waiting for the item alone can read the previous draft.
 */
export function storedSections(itemId: string): string[] {
  const answer = (apolloFinto.risposte['GetCatalogForm'] as (v: Record<string, unknown>) => { catalogForm: { definition: string } } | undefined)({ itemId })
  let definition: CatalogFormDefinition
  try { definition = JSON.parse(answer?.catalogForm.definition ?? '') as CatalogFormDefinition } catch { definition = emptyCatalogForm() }
  return definition.sections.map((s, i) => localizedText(s.title, 'en', '') || String(i + 1))
}

/** Chooses an item and waits until its stored form is on the canvas. */
export async function openItem(user: UserEvent, name: string): Promise<void> {
  await chooseItem(user, name)
  const id = ITEMS.find((i) => i.name === name)?.id ?? name
  await waitFor(() => expect(sectionOrder()).toEqual(storedSections(id)))
}

/** The section whose title button reads `title`. */
export function sectionTitled(title: string): HTMLElement {
  return screen.getByRole('button', { name: title }).closest('section') as HTMLElement
}

/** The fields of a section, in order: the selectable tiles of the canvas. */
export function fieldsIn(title: string): string[] {
  return within(sectionTitled(title)).queryAllByRole('button')
    .filter((b) => b.hasAttribute('aria-pressed'))
    .map((b) => b.getAttribute('aria-label') ?? '')
}

/** The dashed «drop it here» box of a section. */
export function dropBoxOf(title: string): HTMLElement {
  return within(sectionTitled(title)).getByText('Drop it here to add it to this section.')
}

/** Publishes through the confirmation and returns the definition that was sent. */
export async function publish(user: UserEvent): Promise<CatalogFormDefinition> {
  apolloFinto.esiti['SaveCatalogForm'] ??= { data: { saveCatalogForm: { revision: 4 } } }
  const before = apolloFinto.chiamate['SaveCatalogForm']?.length ?? 0
  await user.click(screen.getByRole('button', { name: 'Save and publish' }))
  const confirmation = await screen.findByRole('dialog', { name: 'Publish this form?' })
  await user.click(within(confirmation).getByRole('button', { name: 'Confirm' }))
  await waitFor(() => expect(apolloFinto.chiamate['SaveCatalogForm']?.length ?? 0).toBe(before + 1))
  return JSON.parse(String(apolloFinto.chiamata('SaveCatalogForm')?.['definition'])) as CatalogFormDefinition
}
