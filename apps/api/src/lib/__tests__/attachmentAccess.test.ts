/**
 * Revisione totale del 16 set 2026 · H-3/H-14/D-14: chi può vedere o aggiungere
 * gli allegati di un'entità. Prima l'upload chiedeva solo che l'entità esistesse
 * nel tenant (un utente del portale allegava file ai ticket dello staff) e il
 * download solo un token valido del tenant.
 */
import { describe, it, expect } from 'vitest'
import { attachmentAccess, attachmentAccessCondition } from '../attachmentAccess.js'

const perms = (...p: string[]) => new Set(p)

describe('attachmentAccess', () => {
  it('lo staff legge secondo il permesso di lettura del tipo', () => {
    expect(attachmentAccess(perms('incident.read'), 'incident', 'read')).toBe('staff')
    expect(attachmentAccess(perms('incident.read'), 'change', 'read')).toBe('denied')
    expect(attachmentAccess(perms('change.read'), 'change', 'read')).toBe('staff')
    expect(attachmentAccess(perms('cmdb.read'), 'ci', 'read')).toBe('staff')
  })

  it('lo staff allega con `ticket.work` o col permesso di scrittura del tipo', () => {
    expect(attachmentAccess(perms('ticket.work'), 'change', 'write')).toBe('staff')
    expect(attachmentAccess(perms('kb.write'), 'kb_article', 'write')).toBe('staff')
    expect(attachmentAccess(perms('incident.read'), 'incident', 'write')).toBe('denied')
  })

  it('H-3: dal portale si allega solo ai propri incident e alle proprie richieste', () => {
    expect(attachmentAccess(perms('portal.submit'), 'incident', 'write')).toBe('own')
    expect(attachmentAccess(perms('portal.submit'), 'service_request', 'write')).toBe('own')
    for (const t of ['change', 'problem', 'ci', 'team', 'task', 'kb_article']) {
      expect(attachmentAccess(perms('portal.submit'), t, 'write'), t).toBe('denied')
    }
  })

  it('H-14: dal portale si scarica dai propri ticket e dagli articoli pubblicati', () => {
    expect(attachmentAccess(perms('portal.read'), 'incident', 'read')).toBe('own')
    expect(attachmentAccess(perms('portal.read'), 'kb_article', 'read')).toBe('published')
    expect(attachmentAccess(perms('portal.read'), 'problem', 'read')).toBe('denied')
    expect(attachmentAccess(perms(), 'incident', 'read')).toBe('denied')
    expect(attachmentAccess(perms('portal.read'), 'sconosciuto', 'read')).toBe('denied')
  })

  it('la condizione Cypher: `own` confronta created_by, `published` guarda il passo, `denied` non interroga', () => {
    expect(attachmentAccessCondition('staff')).toBe('true')
    expect(attachmentAccessCondition('own')).toBe('e.created_by = $userId')
    expect(attachmentAccessCondition('published')).toContain("category: 'published'")
    expect(attachmentAccessCondition('denied')).toBeNull()
  })
})
