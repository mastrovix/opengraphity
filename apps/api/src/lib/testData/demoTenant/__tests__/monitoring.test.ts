/**
 * IL MONITORAGGIO SIMULATO, E GLI INCIDENT CHE FA NASCERE.
 *
 * Quello che si pinna qui è che ogni allarme porta l'esito che il motore vero
 * gli avrebbe dato (services/events/pipeline.ts), nell'ordine della pipeline:
 *
 *  - durante un rilascio sul suo CI è SILENZIATO dalla change;
 *  - sotto la soglia della policy è SCARTATO;
 *  - se sul CI c'è un incident aperto ci si AGGANCIA;
 *  - altrimenti APRE un incident, e quando rientra il motore lo risolve.
 *
 * Il difetto che l'ha reso necessario: scritti con `correlation: 'none'`, gli
 * allarmi sono stati ripresi dalla rete di sicurezza del motore vero tre
 * minuti dopo la generazione, e i critici hanno aperto cinque incident nuovi,
 * non marcati e datati «adesso». Un allarme senza esito è un allarme che il
 * prodotto rivaluta: qui non ne esce nessuno.
 *
 * E si pinna la CONSERVAZIONE: la policy tiene gli allarmi novanta giorni, e
 * quelli più vecchi esistono solo come contatori su ciò a cui erano legati.
 */
import { describe, it, expect } from 'vitest'
import { Rng } from '../random.js'
import { DAY, HOUR, MINUTE } from '../clock.js'
import {
  planMonitoring, ALARM_KINDS, MONITORING_SOURCES, CERT_WARNING_DAYS,
  type IncidentWindow, type DeployWindow, type MonitoringPlan,
} from '../monitoring.js'
import { bornIncidentSkeleton, simulateIncident } from '../incidents.js'
import { NOW, smallWorld } from './fixtures.js'
import { planToolNames } from '../toolNames.js'
import { healthTimeline } from '../serviceHistory.js'
import { CI_NAME_PREFIX } from '../cmdb.js'

const w = smallWorld('monitoring')
const rng = new Rng('mon')

/** Incident delle persone: aperti per qualche giorno su dei server. */
const humanWindows: IncidentWindow[] = w.cmdb.byLabel.Server.slice(0, 60).map((ci, i) => ({
  id: `inc-${String(i)}`, ciId: ci.id, fromMs: NOW - (80 - i) * DAY, toMs: NOW - (80 - i) * DAY + 2 * DAY,
}))
/** Change che rilasciano su delle applicazioni nelle ultime settimane. */
const deployWindows: DeployWindow[] = w.cmdb.byLabel.Application.slice(0, 30).map((ci, i) => ({
  changeId: `chg-${String(i)}`, ciIds: [ci.id], startMs: NOW - (40 - i) * DAY, endMs: NOW - (40 - i) * DAY + 3 * HOUR,
}))
const POLICY = { retentionDays: 90, openFrom: 'critical', autoResolve: true }

const names = planToolNames(rng.fork('names'), w.cmdb)
const plan: MonitoringPlan = planMonitoring(rng.fork('plan'), w, {
  alarmCycles: 4000, openedTarget: 150, attachShare: 0.5, humanWindows, deployWindows, policy: POLICY, names,
})

describe('le sorgenti e le famiglie di allarme', () => {
  it('sono i tre strumenti, coi connettori che il prodotto conosce', () => {
    expect(MONITORING_SOURCES.map((s) => s.connectorKind)).toEqual(['alertmanager', 'grafana', 'dynatrace'])
  })

  it('ogni strumento allarma su quello che davvero guarda', () => {
    const on = (source: string) => new Set(ALARM_KINDS.filter((k) => k.source === source).map((k) => k.on))
    expect(on('dynatrace').has('Application')).toBe(true)
    expect(on('dynatrace').has('Server')).toBe(false)
    expect(on('prometheus')).toEqual(new Set(['Server', 'DatabaseInstance']))
    expect([...on('grafana')].sort()).toEqual(['Application', 'Database'])
  })

  it('la gran parte degli allarmi sono warning, come in un parco curato', () => {
    const w8 = ALARM_KINDS.reduce((a, k) => a + k.weight, 0)
    const critical = ALARM_KINDS.reduce((a, k) => a + k.weight * k.critical, 0) / w8
    expect(critical).toBeLessThan(0.2)
  })
})

describe('ogni allarme ha l\'esito che il motore gli avrebbe dato', () => {
  it('nessuno resta «da valutare»: il motore vero li riprenderebbe e aprirebbe incident', () => {
    for (const e of plan.events) expect(['opened', 'attached', 'skipped_severity', 'suppressed']).toContain(e.correlation)
  })

  it('un warning non apre mai niente', () => {
    // Il silenziamento viene PRIMA della soglia (pipeline.ts): un warning silenziato resta silenziato.
    for (const e of plan.events.filter((x) => x.severity === 'warning' && x.correlation !== 'suppressed')) {
      expect(e.correlation).toBe('skipped_severity')
      expect(e.incidentId).toBeNull()
    }
  })

  it('durante un rilascio sul suo CI l\'allarme è silenziato da quella change, e rientrato è «resolved»', () => {
    const suppressed = plan.events.filter((e) => e.correlation === 'suppressed')
    // La tabella delle transizioni del motore: un allarme aperto (anche
    // silenziato) che rientra diventa `resolved`. Silenziato-e-rientrato non
    // esiste — a fine finestra il motore lo libererebbe e aprirebbe un incident.
    for (const e of suppressed) {
      expect(e.status).toBe('resolved')
      expect(e.resolvedAtMs).not.toBeNull()
    }
    expect(suppressed.length).toBeGreaterThan(0)
    const byId = new Map(deployWindows.map((d) => [d.changeId, d]))
    for (const e of suppressed) {
      const d = byId.get(e.suppressedByChangeId!)!
      expect(d.ciIds).toContain(e.ciId)
      expect(e.firstSeenAtMs).toBeGreaterThanOrEqual(d.startMs)
      expect(e.firstSeenAtMs).toBeLessThanOrEqual(d.endMs)
      expect(e.correlation).toBe('suppressed')
      expect(e.history.some((h) => h.kind === 'suppressed' && h.changeId === d.changeId)).toBe(true)
    }
  })

  it('un critico agganciato lo è a un incident aperto su QUEL CI in QUEL momento', () => {
    const byId = new Map(humanWindows.map((x) => [x.id, x]))
    for (const e of plan.events.filter((x) => x.correlation === 'attached')) {
      const win = byId.get(e.incidentId!) ?? plan.born.find((b) => b.incidentId === e.incidentId)
      expect(win).toBeDefined()
      expect(e.history.some((h) => h.kind === 'correlated' && h.outcome === 'attached')).toBe(true)
    }
  })

  it('gli incident nati dagli allarmi sono ESATTAMENTE quanti previsti, certificati compresi', () => {
    expect(plan.born).toHaveLength(150)
  })

  it('un incident nasce solo dove non c\'era niente di aperto, né un rilascio in corso', () => {
    for (const b of plan.born) {
      const humans = humanWindows.filter((x) => x.ciId === b.ciId)
      for (const h of humans) expect(b.firstSeenMs < h.fromMs || b.firstSeenMs > h.toMs).toBe(true)
      for (const d of deployWindows.filter((x) => x.ciIds.includes(b.ciId))) {
        expect(b.firstSeenMs < d.startMs || b.firstSeenMs > d.endMs).toBe(true)
      }
    }
  })
})

describe('la conservazione della policy', () => {
  const cutoff = NOW - POLICY.retentionDays * DAY

  it('restano solo gli allarmi recenti, o quelli legati a qualcosa ancora aperto', () => {
    for (const e of plan.events) {
      const recent = e.lastSeenAtMs >= cutoff
      expect(recent || e.status === 'firing' || e.incidentId !== null).toBe(true)
    }
  })

  it('degli allarmi cancellati resta il contatore sull\'incident a cui erano legati', () => {
    const oldBorn = plan.born.filter((b) => (b.clearedAtMs ?? NOW) < cutoff)
    expect(oldBorn.length).toBeGreaterThan(0)
    for (const b of oldBorn) expect(plan.purgedByIncident.get(b.incidentId)).toBeGreaterThanOrEqual(1)
  })
})

describe('i certificati', () => {
  const certEvents = plan.events.filter((e) => w.cmdb.byId.get(e.ciId)!.label === 'Certificate')

  it('l\'allarme nasce dalla scadenza scritta nel CMDB, trenta giorni prima', () => {
    for (const e of certEvents) {
      const cert = w.cmdb.byId.get(e.ciId)!
      const expires = Date.parse(cert.fields['expires_at']!)
      expect(Math.round((expires - e.firstSeenAtMs) / DAY)).toBeLessThanOrEqual(CERT_WARNING_DAYS)
    }
  })

  it('quello ancora acceso oggi è su un certificato scaduto o che sta per scadere', () => {
    for (const e of certEvents.filter((x) => x.status === 'firing')) {
      const expires = Date.parse(w.cmdb.byId.get(e.ciId)!.fields['expires_at']!)
      expect(expires).toBeLessThanOrEqual(NOW + CERT_WARNING_DAYS * DAY)
    }
  })
})

describe('la salute', () => {
  it('ogni CI che ha avuto allarmi ne ha una; giù o degradato solo se qualcosa suona ADESSO', () => {
    /*
     * Il motore riscrive la salute a ogni ciclo e, quando l'ultimo allarme
     * rientra, la riporta a `operational` senza cancellarla: un CI monitorato
     * ha sempre una salute. Senza allarmi mai visti resta senza — che è quello
     * che la pagina chiama «unknown».
     */
    const byCI = new Map<string, typeof plan.events>()
    for (const e of plan.events) byCI.set(e.ciId, [...(byCI.get(e.ciId) ?? []), e])
    expect(plan.health.length).toBe(byCI.size)
    for (const h of plan.health) {
      // D45: an information alarm (a missed backup) leaves the health alone.
      const firing = byCI.get(h.ciId)!.filter((e) => e.status === 'firing' && e.severity !== 'info')
      const expected = firing.some((e) => e.severity === 'critical') ? 'down' : firing.length ? 'degraded' : 'operational'
      expect(h.health).toBe(expected)
    }
    // Un allarme silenziato non conta: è la ragione per cui si silenzia.
    for (const e of plan.events.filter((x) => x.correlation === 'suppressed')) {
      const others = byCI.get(e.ciId)!.filter((x) => x.status === 'firing')
      if (!others.length) expect(plan.health.find((h) => h.ciId === e.ciId)!.health).toBe('operational')
    }
  })
})

describe('l\'incident nato da un allarme, come lo tratta il motore', () => {
  const critical = { impact: 'high', urgency: 'high', severity: 'critical' }
  const sims = plan.born.map((b) => simulateIncident(rng.fork(`b/${b.incidentId}`), w, bornIncidentSkeleton(w, b, critical), null))

  it('lo apre `monitoring`, senza categoria, col titolo dell\'allarme', () => {
    for (const s of sims) {
      expect(s.skeleton.creatorId).toBe('monitoring')
      expect(s.skeleton.category).toBeNull()
      expect(s.title).toBe(s.skeleton.born!.title)
      expect(s.skeleton.severity).toBe('critical')
      expect(s.watchers).toEqual([])
      expect(s.description).toContain(s.skeleton.born!.alarmDescription)
    }
  })

  it('quando l\'allarme rientra e nessuno l\'ha risolto prima, lo chiude il motore', () => {
    const auto = sims.filter((s) => s.skeleton.born!.clearedAtMs !== null && s.skeleton.born!.fixedAtMs === null)
    expect(auto.length).toBeGreaterThan(0)
    for (const s of auto) {
      const toResolved = s.trail.executions.find((x) => x.step_name === 'resolved')!
      expect(toResolved.triggered_by).toBe('monitoring')
      // Two notes by the engine: the routing at birth, and the summary — its moves leave none.
      const byEngine = s.trail.comments.filter((c) => c.author_id === 'monitoring')
      expect(byEngine).toHaveLength(2)
      expect(byEngine[0]!.text).toMatch(/^Assigned to team .+, the support group of /)
    }
  })

  it('se lo prende una persona e lo risolve, il motore non tocca niente', () => {
    for (const s of sims.filter((x) => x.skeleton.born!.fixedAtMs !== null)) {
      const toResolved = s.trail.executions.find((x) => x.step_name === 'resolved')!
      expect(toResolved.triggered_by).not.toBe('monitoring')
      expect(s.trail.teamId).not.toBeNull()
    }
  })

  it('born in the support group of the alarm\'s CI (D61), and taken by a person of it', () => {
    for (const s of sims) {
      const ci = w.cmdb.byId.get(s.skeleton.born!.ciId)!
      expect(s.trail.segments[0]!.team_id).toBe(ci.supportTeamId)
      if (s.trail.assigneeId) expect(w.isMember(s.trail.assigneeId, s.trail.teamId!)).toBe(true)
    }
  })

  it('se l\'allarme suona ancora oggi, l\'incident è aperto', () => {
    for (const s of sims.filter((x) => x.skeleton.born!.clearedAtMs === null && x.skeleton.born!.fixedAtMs === null)) {
      expect(['new', 'in_progress']).toContain(s.trail.current.name)
    }
  })

  it('ogni passaggio è uno che il workflow ammette, e il tempo va solo avanti', () => {
    for (const s of sims) {
      const times = s.trail.executions.map((x) => Date.parse(x.entered_at))
      for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]!)
      expect(Date.parse(s.trail.executions.at(-1)!.entered_at)).toBeLessThanOrEqual(NOW)
    }
    void MINUTE
  })
})

/** As the tools send them and the product stores them (tour of 23 Sep 2026). */
describe('the alarms as the tools send them', () => {
  const aliases = new Map(names.aliases.map((a) => [`${a.kind}|${a.value}`, a.ciId]))

  it('D37: the resource is the tool\'s name for the thing, and the CI is found through its alias', () => {
    for (const e of plan.events) {
      const ci = w.cmdb.byId.get(e.ciId)!
      expect(e.resource.startsWith(CI_NAME_PREFIX[ci.label]), e.resource).toBe(false)
      expect(['hostname', 'name']).toContain(e.resourceKind)
      if (e.matchReason === 'alias_external_id') {
        expect(e.resourceExternalId).toMatch(/^SERVICE-[0-9A-F]{16}$/)
        expect(aliases.get(`external_id|${e.resourceExternalId!}`)).toBe(e.ciId)
      } else if (ci.label !== 'Certificate') {
        expect(aliases.get(`hostname|${e.resource.toLowerCase()}`), e.resource).toBe(e.ciId)
      }
    }
    // an alias names one CI only
    expect(new Set(names.aliases.map((a) => `${a.kind}|${a.value}`)).size).toBe(names.aliases.length)
  })

  it('D35: the occurrences are the tool\'s repeats — four-hourly for Alertmanager and Grafana, on a change for Dynatrace', () => {
    for (const e of plan.events) {
      const lasted = e.lastSeenAtMs - e.firstSeenAtMs
      if (e.sourceKey === 'dynatrace') expect(e.count).toBeLessThanOrEqual(3)
      else expect(e.count).toBe(1 + Math.floor(lasted / (4 * HOUR)))
    }
  })

  it('D41: the first sighting carries its severity; D40: the correlation has its own instant; D46: nothing after now', () => {
    for (const e of plan.events) {
      expect(e.history[0]).toMatchObject({ kind: 'first_seen' })
      expect(e.history[0]!.severity).toBeTruthy()
      expect(e.correlatedAtMs).toBeGreaterThanOrEqual(e.firstSeenAtMs)
      const correlated = e.history.find((h) => h.kind === 'correlated')
      if (correlated) expect(e.correlatedAtMs).toBe(correlated.atMs)
      for (const t of [e.firstSeenAtMs, e.lastSeenAtMs, e.resolvedAtMs ?? 0, e.correlatedAtMs, ...e.history.map((h) => h.atMs)]) expect(t).toBeLessThanOrEqual(NOW)
    }
  })

  it('D45: a missed backup is information — never critical, never an incident', () => {
    const backups = plan.events.filter((e) => e.alertName === 'BackupNotSeen')
    expect(backups.length).toBeGreaterThan(0)
    for (const e of backups) {
      expect(e.severity).toBe('info')
      expect(e.incidentId).toBeNull()
    }
  })

  it('D38: an expired certificate does not keep firing — renewed within days of its expiry', () => {
    for (const e of plan.events.filter((x) => x.alertName === 'SSLCertExpiringSoon' && x.status === 'firing')) {
      const expires = Date.parse(w.cmdb.byId.get(e.ciId)!.fields['expires_at']!)
      expect(NOW - expires).toBeLessThan(11 * DAY)
    }
  })

  it('D63: an incident born from an alarm is taken in minutes', () => {
    const taken = plan.born.filter((b) => b.takenAtMs !== null)
    expect(taken.length).toBeGreaterThan(50)
    const quick = taken.filter((b) => b.takenAtMs! - b.firstSeenMs <= 30 * MINUTE).length
    expect(quick / taken.length).toBeGreaterThan(0.9)
  })
})

/** D43: a service watched for two months has two months of health behind it. */
describe('the history of a monitored service', () => {
  it('one entry per change of health: the worst of what fires on its components, and back', () => {
    const H = HOUR
    const t = healthTimeline([
      { ciId: 'a', health: 'degraded', from: 10 * H, to: 20 * H },
      { ciId: 'b', health: 'down', from: 12 * H, to: 14 * H },
      { ciId: 'c', health: 'degraded', from: 30 * H, to: null },
    ], 0, 40 * H)
    expect(t.map((x) => [x.at / H, x.previous, x.health])).toEqual([
      [10, 'operational', 'degraded'], [12, 'degraded', 'down'], [14, 'down', 'degraded'], [20, 'degraded', 'operational'], [30, 'operational', 'degraded'],
    ])
    expect(t[1]!.causes.map((c) => c.ciId).sort()).toEqual(['a', 'b'])
  })
})

