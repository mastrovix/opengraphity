/**
 * Il percorso in cima alla pagina prende nome e gruppo dal MENU.
 *
 * Su /reports/sla scriveva «AI Analysis / Sla»: etichette per segmento
 * d'indirizzo, e /reports è l'indirizzo di AI Analysis. Il test passa TUTTE le
 * voci del menu: sulla pagina di ciascuna il percorso finisce con il nome
 * della voce ed è preceduto dal suo gruppo, se ne ha uno.
 */
import { describe, it, expect } from 'vitest'
import { screen } from '@testing-library/react'
import i18n from 'i18next'
import { Breadcrumb } from './Topbar'
import { MENU_SECTIONS } from './menu'
import { renderWithProviders } from '@/test/utils'

function briciole(route: string): string[] {
  const { unmount } = renderWithProviders(<Breadcrumb />, { route })
  const nav = screen.getByRole('navigation')
  const testi = Array.from(nav.children).map((c) => (c.textContent ?? '').replace(/^\//, ''))
  unmount()
  return testi
}

describe('Breadcrumb: nome e gruppo dal menu', () => {
  it('SLA Report è «Reporting / SLA Report», non «AI Analysis / Sla»', () => {
    expect(briciole('/reports/sla')).toEqual(['Reporting', 'SLA Report'])
    expect(briciole('/reports/ola-uc')).toEqual(['Reporting', 'OLA / UC Report'])
    expect(briciole('/reports')).toEqual(['Reporting', 'AI Analysis'])
  })

  it.each(MENU_SECTIONS.flatMap((s) => s.items.filter((it) => it.to !== '/dashboard').map((it) => [it.to, s.groupKey, it.labelKey] as const)))(
    '%s', (to, groupKey, labelKey) => {
      const atteso = groupKey ? [i18n.t(groupKey), i18n.t(labelKey)] : [i18n.t(labelKey)]
      expect(briciole(to)).toEqual(atteso)
    },
  )

  it('una pagina di dettaglio aggiunge il suo segmento sotto la voce', () => {
    expect(briciole('/incidents/0e764d9c-6e20-473e-9b73-6736661dda3b')).toEqual(['ITIL Processes', 'Incidents', 'Detail'])
  })

  it('una pagina fuori dal menu segue i segmenti dell indirizzo', () => {
    expect(briciole('/ci/server')).toEqual(['CMDB', 'Server'])
  })

  it('«health» under /cmdb is the CMDB Health page, not the CI Health of Monitoring (24 Sep 2026)', () => {
    expect(briciole('/cmdb/health')).toEqual(['CMDB', 'CMDB Health'])
  })
})
