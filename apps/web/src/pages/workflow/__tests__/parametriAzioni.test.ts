/**
 * QUELLO CHE SI SCRIVE IN UN'AZIONE DEL PASSO SI SALVA (20 set 2026).
 *
 * `buildActionParams` traduce quello che c'è nell'editor in quello che
 * finisce nel grafo, con un ramo per tipo. Il ramo mancante non dava nessun
 * errore: l'azione si salvava con `params: {}`, cioè configurata a metà e
 * muta. È successo **due volte** — la prima con `create_approval_request`
 * (titolo e approvatori persi, c'è ancora il commento), la seconda con
 * `create_task`, trovata solo provando nel browser: il compito nasceva senza
 * titolo e senza squadra.
 *
 * Il fallback silenzioso è stato tolto (ora quello che non ha un ramo passa
 * così com'è), e questo test tiene chiusa la classe: per OGNI tipo che il
 * disegnatore offre, quello che si scrive si ritrova.
 */
import { describe, it, expect } from 'vitest'
import { buildActionParams, paramsToRaw } from '../workflow-panel-helpers'
import { WORKFLOW_STEP_ACTION_TYPES } from '@/lib/automationOperators'

/** Un valore plausibile per ogni parametro che gli editor sanno scrivere. */
const SCRITTI: Record<string, string> = {
  sla_type:          'resolve',
  entity_type:       'problem',
  title_template:    'Un titolo scritto a mano',
  link_to_current:   'true',
  target_type:       'team',
  target_id:         'team-1',
  field:             'severity',
  value:             'high',
  url:               'https://esempio.test/hook',
  method:            'POST',
  payload_template:  '{"a":1}',
  approver_role:     'admin',
  approval_type:     'any',
  approver_user_ids: 'u-1,u-2',
  team_id:           'team-desk',
  due_in_days:       '2',
  description:       'Cosa c’è da fare',
}

describe('i parametri delle azioni di un passo', () => {
  it('nessun tipo offerto dal disegnatore perde quello che ci si scrive', () => {
    const persi: string[] = []
    for (const tipo of WORKFLOW_STEP_ACTION_TYPES) {
      const salvati = buildActionParams(tipo, SCRITTI)
      // `params: {}` è il sintomo esatto del difetto: un'azione che sembra
      // configurata e non porta niente.
      if (Object.keys(salvati).length === 0) persi.push(tipo)
    }
    expect(persi, 'Questi tipi si salvano con params vuoti: manca il loro ramo in buildActionParams').toEqual([])
  })

  it('il titolo scritto si ritrova, per ogni tipo che ne ha uno', () => {
    for (const tipo of WORKFLOW_STEP_ACTION_TYPES) {
      const salvati = buildActionParams(tipo, SCRITTI)
      if ('title_template' in salvati) {
        expect(salvati['title_template'], `${tipo} perde il titolo`).toBe('Un titolo scritto a mano')
      }
    }
  })

  it('un tipo SENZA ramo tiene comunque i suoi parametri, invece di svuotarli', () => {
    // Il fallback silenzioso di prima avrebbe risposto {}.
    expect(buildActionParams('un_tipo_del_futuro', { qualcosa: 'che conta' })).toEqual({ qualcosa: 'che conta' })
    expect(paramsToRaw('un_tipo_del_futuro', { qualcosa: 'che conta', quanti: 3 }))
      .toEqual({ qualcosa: 'che conta', quanti: '3' })
  })

  describe('create_task', () => {
    it('salva titolo, squadra, giorni e descrizione', () => {
      expect(buildActionParams('create_task', SCRITTI)).toEqual({
        title_template: 'Un titolo scritto a mano',
        team_id:        'team-desk',
        description:    'Cosa c’è da fare',
        due_in_days:    2,
      })
    })

    it('quello che non è stato scritto NON si salva: un parametro vuoto sembra configurato', () => {
      expect(buildActionParams('create_task', { title_template: 'Solo il titolo', team_id: '  ', due_in_days: '' }))
        .toEqual({ title_template: 'Solo il titolo' })
    })

    it('i giorni tornano un numero, non la stringa che l\'editor tiene', () => {
      const p = buildActionParams('create_task', { title_template: 'X', due_in_days: '3' })
      expect(p['due_in_days']).toBe(3)
    })

    it('riaprendo l\'azione si rilegge quello che c\'è dentro', () => {
      const raw = paramsToRaw('create_task', { title_template: 'X', team_id: 'team-1', due_in_days: 2 })
      expect(raw['title_template']).toBe('X')
      expect(raw['team_id']).toBe('team-1')
      expect(raw['due_in_days']).toBe('2')
    })
  })
})
