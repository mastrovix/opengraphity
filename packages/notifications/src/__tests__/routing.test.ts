/**
 * Instradamento (revisione 2, D3.1/D3.2): la tabella dei canali instradabili
 * per tipo di evento e quella `entity_type → percorso` sono la sorgente unica
 * per dispatcher, resolver, interfaccia e migrazione. Qui si pinnano i valori
 * e il contratto delle funzioni; la coerenza con il dispatcher reale è nel
 * test dispatcherChannels (Slack/Teams solo dove c'è un formatter).
 */
import { describe, it, expect } from 'vitest'
import {
  NOTIFICATION_CHANNELS, DEFAULT_ROUTABLE_CHANNELS, ROUTABLE_CHANNELS_BY_EVENT,
  routableChannels, unroutableChannels, assertRoutableChannels, isNotificationChannel,
  NOTIFICATION_ENTITY_PATHS, notificationEntityPath, isNotificationEntityType,
} from '../routing.js'

describe('canali instradabili per tipo di evento', () => {
  /**
   * Revisione totale · E-18: le change hanno anche la card Teams
   * (`formatTeamsChange`/`formatTeamsChangeTask`), perché la pagina Canali
   * offriva quegli eventi a un canale Teams che non riceveva mai niente.
   * G-8: le notifiche dei PASSI hanno la loro riga esplicita, che la
   * validazione al salvataggio legge.
   */
  it('Slack/Teams dove esiste un formatter: incident (4 tipi), sla.breached, change e attività di change', () => {
    expect(Object.keys(ROUTABLE_CHANNELS_BY_EVENT).sort()).toEqual([
      'change.approved', 'change.task_assigned',
      'digest.daily',
      'incident.assigned', 'incident.created', 'incident.escalated', 'incident.resolved',
      'sla.breached',
      'workflow.step.entered',
    ])
    for (const t of ['incident.created', 'incident.assigned', 'incident.escalated', 'incident.resolved', 'sla.breached', 'change.approved', 'change.task_assigned']) {
      expect(routableChannels(t)).toEqual(['in_app', 'email', 'slack', 'teams'])
    }
    // NT-8: il digest è un'e-mail riassuntiva, nessun altro canale.
    expect(routableChannels('digest.daily')).toEqual(['email'])
    // G-8: un passo notifica in-app o per e-mail, non su Slack/Teams.
    expect(routableChannels('workflow.step.entered')).toEqual(['in_app', 'email'])
  })

  it('ogni altro tipo (allarmi, salute del CI, servizi, sync, problem, custom) → solo in_app ed email', () => {
    expect(DEFAULT_ROUTABLE_CHANNELS).toEqual(['in_app', 'email'])
    for (const t of ['event.storm_started', 'service.incident_opened', 'ci.health_changed', 'sync.failed', 'problem.created', 'incident.closed', 'workflow.step.entered', 'my.custom.event']) {
      expect(routableChannels(t)).toEqual(['in_app', 'email'])
    }
  })

  it('ogni riga dedicata contiene i canali generici e solo canali noti; la tabella è congelata', () => {
    for (const [type, channels] of Object.entries(ROUTABLE_CHANNELS_BY_EVENT)) {
      // Unica riga più stretta dei generici, dichiarata: il digest (NT-8).
      if (type !== 'digest.daily') expect(channels, type).toEqual(expect.arrayContaining([...DEFAULT_ROUTABLE_CHANNELS]))
      for (const c of channels) expect(NOTIFICATION_CHANNELS, `${type}: ${c}`).toContain(c)
    }
    expect(Object.isFrozen(ROUTABLE_CHANNELS_BY_EVENT)).toBe(true)
    expect(isNotificationChannel('slack')).toBe(true)
    expect(isNotificationChannel('sms')).toBe(false)
  })

  it('unroutableChannels: i canali non instradabili (anche sconosciuti), nell\'ordine dato, senza doppioni', () => {
    expect(unroutableChannels('event.storm_started', ['in_app', 'slack'])).toEqual(['slack'])
    // E-18: `teams` su una change ora è instradabile; resta fuori solo ciò che
    // il dispatcher non sa consegnare.
    expect(unroutableChannels('change.approved', ['teams', 'slack', 'teams', 'sms'])).toEqual(['sms'])
    expect(unroutableChannels('workflow.step.entered', ['in_app', 'slack', 'teams'])).toEqual(['slack', 'teams'])
    expect(unroutableChannels('incident.created', ['in_app', 'email', 'slack', 'teams'])).toEqual([])
    expect(unroutableChannels('incident.created', [])).toEqual([])
  })

  it('assertRoutableChannels: errore esplicito che nomina i canali rifiutati e quelli ammessi; nessun errore se tutto è instradabile', () => {
    expect(() => assertRoutableChannels('service.incident_opened', ['in_app', 'slack']))
      .toThrow('service.incident_opened notification rule requests channels [slack] that the dispatcher cannot route for this event type — routable: [in_app, email]')
    expect(() => assertRoutableChannels('sla.breached', ['slack', 'teams', 'email', 'in_app'])).not.toThrow()
  })
})

describe('entity_type → percorso (condiviso con il pannello in-app del web)', () => {
  it('ITSM, CI, allarmi, servizi e sorgenti puntano alle rotte reali di main.tsx', () => {
    expect(NOTIFICATION_ENTITY_PATHS).toEqual({
      incident:        '/incidents/:id',
      change:          '/changes/:id',
      problem:         '/problems/:id',
      request:         '/requests/:id',
      service_request: '/requests/:id',
      ci:              '/cis/:id',
      event:           '/events/:id',
      service:         '/monitoring/services/:id',
      inbound_webhook: '/monitoring/sources/:id',
    })
    expect(notificationEntityPath('service', 'map-1')).toBe('/monitoring/services/map-1')
    expect(notificationEntityPath('inbound_webhook', 'src-1')).toBe('/monitoring/sources/src-1')
    expect(notificationEntityPath('event', 'ev-1')).toBe('/events/ev-1')
    expect(notificationEntityPath('ci', 'ci-1')).toBe('/cis/ci-1')
    expect(notificationEntityPath('incident', 'inc-1')).toBe('/incidents/inc-1')
    expect(notificationEntityPath('service_request', 'req-1')).toBe('/requests/req-1')
  })

  it('senza id, senza tipo o con un tipo senza pagina (sync, portal) → null; l\'id viene codificato per l\'URL', () => {
    expect(notificationEntityPath('incident', undefined)).toBeNull()
    expect(notificationEntityPath(undefined, 'x')).toBeNull()
    expect(notificationEntityPath('sync', 'run-1')).toBeNull()
    expect(notificationEntityPath('portal', 'x')).toBeNull()
    expect(notificationEntityPath('incident', 'a b/c')).toBe('/incidents/a%20b%2Fc')
    expect(isNotificationEntityType('service')).toBe(true)
    expect(isNotificationEntityType('toString')).toBe(false)
  })
})
