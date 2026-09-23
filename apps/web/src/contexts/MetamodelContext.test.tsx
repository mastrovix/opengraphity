/**
 * THE CI METAMODEL AS THE PAGES READ IT.
 *
 * The provider loads the CI types once and hands them to every page with the
 * labels in the reader's language: a type, field or relation shipped with the
 * product is translated as long as it is the shipped one, and left as it is
 * once the customer renamed it (it is theirs, in any language). Outside the
 * provider the metamodel says it is loading and knows no type — a page must
 * wait, not declare «type not found».
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import i18n from '@/i18n/i18n'
import { apolloFinto } from '@/test/apolloFinto'
import { MetamodelProvider, useMetamodel } from './MetamodelContext'

vi.mock('@apollo/client/react', async () => (await import('@/test/apolloFinto')).moduloApollo())

const TYPES = [
  {
    id: 't1', name: 'database_instance', label: 'Database Instance', icon: 'database', color: '#000', active: true,
    scope: 'base', tenantId: 'system', validationScript: null, chainFamilies: [], serviceRole: null, systemRelations: [],
    fields: [{ id: 'f1', name: 'ip_address', label: 'IP address', fieldType: 'string', required: false, enumValues: [], order: 1, isSystem: false, validationScript: null, visibilityScript: null, defaultScript: null }],
    relations: [
      { id: 'r1', name: 'dependencies', label: 'Dependencies', relationshipType: 'DEPENDS_ON', targetType: 'server', cardinality: 'many', direction: 'outgoing', order: 1 },
      { id: 'r2', name: 'dependents', label: 'Consumers', relationshipType: 'DEPENDS_ON', targetType: 'application', cardinality: 'many', direction: 'incoming', order: 2 },
      { id: 'r3', name: 'runsOn', label: 'Runs on', relationshipType: 'HOSTED_ON', targetType: 'server', cardinality: 'one', direction: 'outgoing', order: 3 },
    ],
  },
]

const wrapper = ({ children }: { children: ReactNode }) => <MetamodelProvider>{children}</MetamodelProvider>
const read = () => renderHook(() => useMetamodel(), { wrapper }).result.current

beforeEach(() => {
  apolloFinto.reset()
  apolloFinto.risposte['GetCITypes'] = { ciTypes: TYPES }
})
afterEach(async () => { await i18n.changeLanguage('en') })

describe('MetamodelProvider', () => {
  it('hands the types to the pages, found by name', () => {
    const m = read()
    expect(m.loading).toBe(false)
    expect(m.error).toBeNull()
    expect(m.getCIType('database_instance')?.label).toBe('Database Instance')
    expect(m.getCIType('router')).toBeUndefined()
  })

  it('in Italian, the shipped labels are translated and the customer\'s own ones are kept', async () => {
    await i18n.changeLanguage('it')
    const type = read().getCIType('database_instance')!
    expect(type.label).toBe('Istanza di database')
    expect(type.relations.map((r) => r.label)).toEqual(['Dipendenze', 'Consumers', 'Runs on'])
    expect(type.fields[0]!.label).toBe('IP address')
  })

  it('a metamodel that fails to load says so', () => {
    apolloFinto.erroriQuery['GetCITypes'] = new Error('metamodel down')
    const m = read()
    expect(m.error?.message).toBe('metamodel down')
    expect(m.ciTypes).toEqual([])
  })
})

describe('useMetamodel outside the provider', () => {
  function Probe() {
    const m = useMetamodel()
    return <span>{`${m.loading ? 'loading' : 'ready'} / ${m.getCIType('server') ? 'known' : 'unknown'}`}</span>
  }

  it('says it is loading and knows no type', () => {
    render(<Probe />)
    expect(screen.getByText('loading / unknown')).toBeInTheDocument()
  })
})
