#!/usr/bin/env node
/**
 * check-i18n — guardia CI per le traduzioni dell'app web (apps/web).
 *
 *   node scripts/check-i18n.mjs            # errori → exit 1, warning → exit 0
 *   node scripts/check-i18n.mjs --strict   # anche le chiavi inutilizzate sono errori
 *
 * Controlli:
 *  (a) it.json ed en.json hanno lo STESSO insieme di chiavi (e nessun valore vuoto).
 *  (b) ogni chiave usata da t('…') / i18n.t('…') / i18next.t('…') esiste (i plurali
 *      `_one/_other` contano come la chiave base). Chiavi dinamiche con template
 *      (t(`pages.x.severity.${sev}`)) → il prefisso statico deve corrispondere ad
 *      almeno una chiave definita.
 *  (c) chiavi definite e mai referenziate nel sorgente → warning (errore con --strict).
 *  (d) letterali sospetti:
 *      - toast.success|error|warning|info('…') / template literal → errore ovunque;
 *      - <button>testo</button> / <Button>testo</Button> con testo letterale nelle
 *        directory già migrate (MIGRATED_DIRS) → errore.
 *
 * Nessuna dipendenza: solo fs + regex. Esclusi test (*.test.ts[x], src/test/**).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB_SRC = path.join(ROOT, 'apps/web/src')
const LOCALES = path.join(WEB_SRC, 'i18n/locales')
const STRICT = process.argv.includes('--strict')

/** Directory/file in cui la migrazione i18n è completa: qui i letterali nei bottoni sono errori. */
const MIGRATED_DIRS = [
  'components/ui',
  'pages/ci',
  'pages/cmdb',
  'pages/dashboard',
  'pages/topology',
  'pages/anomaly',
  'pages/DashboardPage.tsx',
  'pages/tasks/components/ReviewTaskForm.tsx',
  'pages/tasks/components/ValidationTaskForm.tsx',
  'components/Modal.tsx',
  'components/EmptyState.tsx',
  'components/QueryError.tsx',
  'components/PageLoader.tsx',
  'components/ExportCsvButton.tsx',
  'components/AttachmentsSection.tsx',
  'components/WatcherBar.tsx',
  'components/InternalChatPanel.tsx',
  'components/RichTextEditor.tsx',
  'components/ErrorBoundary.tsx',
  'components/ConditionRowEditor.tsx',
  'components/CIDynamicForm.tsx',
  'components/CIGraph.tsx',
  'components/topology/TopologyGraph.tsx',
  'components/ReportChartRenderer.tsx',
  'components/WidgetBody.tsx',
]

/** Prefissi ammessi per chiavi passate a t() come variabile (non template). */
const DYNAMIC_KEY_ALLOWLIST_NOTE = 'chiavi passate come variabile (es. t(item.labelKey)) sono verificate tramite il letterale della chiave nel sorgente'

// ── util ─────────────────────────────────────────────────────────────────────

const errors = []
const warnings = []
const err = (m) => errors.push(m)
const warn = (m) => warnings.push(m)

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object') flatten(v, key, out)
    else out[key] = v
  }
  return out
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'test' && path.relative(WEB_SRC, dir) === '') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

const rel = (p) => path.relative(WEB_SRC, p)
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length
const isMigrated = (relPath) => MIGRATED_DIRS.some((d) => relPath === d || relPath.startsWith(d + '/'))

// ── (a) locale allineati ─────────────────────────────────────────────────────

const it = flatten(JSON.parse(fs.readFileSync(path.join(LOCALES, 'it.json'), 'utf8')))
const en = flatten(JSON.parse(fs.readFileSync(path.join(LOCALES, 'en.json'), 'utf8')))
const itKeys = new Set(Object.keys(it))
const enKeys = new Set(Object.keys(en))
for (const k of itKeys) if (!enKeys.has(k)) err(`[locale] chiave solo in it.json: ${k}`)
for (const k of enKeys) if (!itKeys.has(k)) err(`[locale] chiave solo in en.json: ${k}`)
for (const [k, v] of Object.entries(it)) if (typeof v !== 'string' || v.trim() === '') err(`[locale] it.${k}: valore vuoto o non stringa`)
for (const [k, v] of Object.entries(en)) if (typeof v !== 'string' || v.trim() === '') err(`[locale] en.${k}: valore vuoto o non stringa`)

const defined = new Set([...itKeys, ...enKeys])
/** chiave base dei plurali/contesti: time.minutesAgo_one → time.minutesAgo */
const baseOf = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '')
const definedBases = new Set([...defined].map(baseOf))

function keyExists(k) {
  return defined.has(k) || definedBases.has(k)
}

// ── (b)(c)(d) scansione sorgenti ─────────────────────────────────────────────

const files = walk(WEB_SRC)
const usedKeys = new Set()
const usedPrefixes = new Set()

// t('key') / t("key") / i18n.t('key') / i18next.t('key') — anche con opzioni dopo la virgola
const RE_T_LITERAL = /(?:^|[^A-Za-z0-9_$.])(?:i18n(?:ext)?\.)?t\(\s*(['"])([^'"`\n]+?)\1/g
// t(`prefix.${x}`) — chiave dinamica: si valida il prefisso statico
const RE_T_TEMPLATE = /(?:^|[^A-Za-z0-9_$.])(?:i18n(?:ext)?\.)?t\(\s*`([^`$]*)\$\{/g
// qualsiasi letterale stringa che coincide con una chiave definita (labelKey: 'roles.admin', ecc.)
const RE_ANY_LITERAL = /(['"`])((?:[A-Za-z0-9_]+\.)+[A-Za-z0-9_]+)\1/g
// toast.success('…') / toast.error(`…`)
const RE_TOAST_LITERAL = /toast\.(success|error|warning|info)\(\s*(['"`])/g
// <button …>testo</button> con testo letterale (non un'espressione {…})
const RE_BUTTON_LITERAL = /<(button|Button)\b[^>]*>\s*([^<{\s][^<{]*?)\s*<\/\1>/g

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  const r = rel(file)

  for (const m of src.matchAll(RE_T_LITERAL)) {
    const key = m[2]
    if (!/^[A-Za-z0-9_.:-]+$/.test(key)) continue // non è una chiave (es. `t('…')` in un commento)
    usedKeys.add(key)
    if (!keyExists(key)) err(`[missing] ${r}:${lineOf(src, m.index)} chiave non definita: ${key}`)
  }
  for (const m of src.matchAll(RE_T_TEMPLATE)) {
    const prefix = m[1]
    usedPrefixes.add(prefix)
    if (!prefix) { err(`[dynamic] ${r}:${lineOf(src, m.index)} t(\`\${…}\`) senza prefisso statico: non verificabile`); continue }
    const hit = [...defined].some((k) => k.startsWith(prefix))
    if (!hit) err(`[dynamic] ${r}:${lineOf(src, m.index)} nessuna chiave con prefisso "${prefix}"`)
  }
  for (const m of src.matchAll(RE_ANY_LITERAL)) {
    if (keyExists(m[2])) usedKeys.add(m[2])
  }
  for (const m of src.matchAll(RE_TOAST_LITERAL)) {
    err(`[toast] ${r}:${lineOf(src, m.index)} toast.${m[1]}() con stringa letterale: usa t('toast.<dominio>.<nome>')`)
  }
  if (isMigrated(r)) {
    for (const m of src.matchAll(RE_BUTTON_LITERAL)) {
      const text = m[2].trim()
      if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(text)) continue // solo simboli/numeri (×, ←, +, ✕)
      err(`[button] ${r}:${lineOf(src, m.index)} <${m[1]}> con testo letterale "${text}"`)
    }
  }
}

// (c) chiavi mai usate: coperte da un uso letterale o da un prefisso dinamico
for (const k of [...defined].sort()) {
  const base = baseOf(k)
  const used = usedKeys.has(k) || usedKeys.has(base)
    || [...usedPrefixes].some((p) => k.startsWith(p) || base.startsWith(p))
  if (!used) (STRICT ? err : warn)(`[unused] chiave definita e mai usata: ${k}`)
}

// ── (d) valori italiani identici all'inglese ─────────────────────────────────
//
// Terza revisione. `it.json` conteneva `pages.dictionary.title = "Dictionary
// Designer"`: la chiave esisteva, quindi ogni controllo passava, e la pagina
// mostrava un titolo inglese in un prodotto italiano. Nessuno verificava che il
// valore italiano fosse italiano.
//
// Il criterio qui e OGGETTIVO e non indovina la lingua: un valore identico in
// it e en e sospetto. Molti lo sono legittimamente (nomi propri, sigle, gergo
// che in italiano si dice in inglese), e stanno nell'elenco qui sotto — che e
// una FOTOGRAFIA del 13 settembre 2026, non un permesso a vita. Diversi di
// quelli sono difetti veri (`Sync triggered`, `Heap Memory`, `Auto-refresh
// 10s`, `External ID`): l'elenco puo solo accorciarsi.
const IT_EN_IDENTICHE_ACCETTATE = new Set([
  'admin.integrations.apiKeys',
  'admin.integrations.columns.url',
  'admin.integrations.entityChange',
  'admin.integrations.entityIncident',
  'admin.integrations.entityProblem',
  'admin.integrations.form.url',
  'admin.integrations.test',
  'admin.integrations.webhookIn',
  'admin.integrations.webhookOut',
  'anomaly.rules.spof',
  'bulk.team',
  'ciTypeDesigner.chain',
  'common.no',
  'common.reset',
  'components.widgetBody.label',
  'conditionEditor.teamPlaceholder',
  'detail.sections.incidentInformation',
  'detail.sections.problemInformation',
  'detail.team',
  'events.aliases.kind.fqdn',
  'events.aliases.kind.hostname',
  'events.aliases.kind.ip',
  'events.columns.ci',
  'events.columns.incident',
  'events.detail.acknowledgedBy',
  'events.policy.groupByOptions.ci',
  'events.policy.openFrom.info',
  'events.severity.info',
  'itilDesigner.title',
  'monitoring.edit.tokenTitle',
  'monitoring.errors.invalidJson',
  'monitoring.health.columns.ci',
  'monitoring.mapper.inWord',
  'monitoring.mapper.resourceKinds.fqdn',
  'monitoring.mapper.resourceKinds.hostname',
  'monitoring.services.columns.owner',
  'monitoring.services.detail.fields.owner',
  'monitoring.services.explain.cause',
  'monitoring.services.explain.causeVia',
  'monitoring.services.explain.sentence',
  'monitoring.services.map.nodeLabel',
  'monitoring.tools.alertmanager.name',
  'monitoring.tools.datadog.name',
  'monitoring.tools.dynatrace.name',
  'monitoring.tools.grafana.name',
  'monitoring.tools.zabbix.name',
  'monitoring.wizard.token',
  'notificationRules.category.change',
  'notificationRules.category.digest',
  'notificationRules.category.discovery',
  'notificationRules.category.escalation',
  'notificationRules.category.incident',
  'notificationRules.category.problem',
  'notificationRules.category.sla',
  'notificationRules.channels.email',
  'notificationRules.channels.inApp',
  'notificationRules.channels.slack',
  'notificationRules.channels.teams',
  'notificationRules.eventGroupStandard',
  'notificationRules.severity.info',
  'pages.aiAnalysis.title',
  'pages.audit.colIp',
  'pages.audit.title',
  'pages.changeCalendar.score',
  'pages.changeCatalog.defaultWorkflow',
  'pages.changeCatalogAdmin.colWorkflow',
  'pages.changeCatalogAdmin.default',
  'pages.changeCatalogAdmin.workflow',
  'pages.changes.count_one',
  'pages.cmdb.count_one',
  'pages.dashboard.badgeTeam',
  'pages.dashboard.cols_one',
  'pages.dashboard.entity.application',
  'pages.dashboard.entity.businessApplication',
  'pages.dashboard.entity.certificate',
  'pages.dashboard.entity.change',
  'pages.dashboard.entity.database',
  'pages.dashboard.entity.incident',
  'pages.dashboard.entity.networkDevice',
  'pages.dashboard.entity.problem',
  'pages.dashboard.entity.server',
  'pages.dashboard.entity.serviceRequest',
  'pages.dashboard.entity.vm',
  'pages.dashboard.fieldType.enum',
  'pages.dashboard.statusCaption',
  'pages.dashboard.timeRange.24h',
  'pages.dashboard.title',
  'pages.dashboard.widgetFallback',
  'pages.dashboard.widgetType.chartBar',
  'pages.dashboard.widgetType.chartDonut',
  'pages.dashboard.widgetType.chartLine',
  'pages.dashboard.widgetType.chartPie',
  'pages.dashboard.widgetType.counter',
  'pages.dashboard.widgetType.gauge',
  'pages.dashboard.widgetTypeDesc.chartLine',
  'pages.dictionary.defaultBadge',
  'pages.dictionary.labelLabel',
  'pages.dictionary.scopeCmdb',
  'pages.dictionary.scopeItil',
  'pages.dictionary.scopeLabel',
  'pages.import.apiKey',
  'pages.import.colExternalId',
  'pages.import.columnsIncidents',
  'pages.import.columnsKb',
  'pages.import.dryRun',
  'pages.incidents.count_one',
  'pages.incidents.impactedApplications.pathNodeFallback',
  'pages.kb.no',
  'pages.kb.title',
  'pages.kbAdmin.title',
  'pages.logs.autoRefresh',
  'pages.logs.count_one',
  'pages.logs.refresh',
  'pages.logs.timestamp',
  'pages.monitoring.health.keycloak',
  'pages.monitoring.health.neo4j',
  'pages.monitoring.health.redis',
  'pages.monitoring.health.uptime',
  'pages.monitoring.neo4j.title',
  'pages.monitoring.process.cpu',
  'pages.monitoring.process.memory',
  'pages.monitoring.process.pid',
  'pages.monitoring.process.rss',
  'pages.monitoring.process.version',
  'pages.monitoring.title',
  'pages.monitoring.tracing.title',
  'pages.problems.count_one',
  'pages.profile.account',
  'pages.profile.english',
  'pages.profile.italian',
  'pages.queueStats.group.itsm',
  'pages.queueStats.payload',
  'pages.sync.modeInline',
  'pages.sync.sourceCreated',
  'pages.sync.syncTriggered',
  'pages.teams.count_one',
  'pages.topology.hops_one',
  'pages.users.email',
  'pages.users.password',
  'pages.whatIf.riskScore',
  'pages.whatIf.title',
  'pages.workflow.title',
  'roles.admin',
  'search.groups.kbArticles',
  'sidebar.admin',
  'sidebar.aiAnalysis',
  'sidebar.auditLog',
  'sidebar.businessRules',
  'sidebar.ciTypeDesigner',
  'sidebar.cmdb',
  'sidebar.dashboard',
  'sidebar.database',
  'sidebar.itilDesigner',
  'sidebar.kbAdmin',
  'sidebar.knowledgeBase',
  'sidebar.platformMonitoring',
  'sidebar.reportBuilder',
  'sidebar.reporting',
  'sidebar.server',
  'sidebar.whatIf',
  'sidebar.workflowDesigner',
  'sidebar.workspace',
  'sla.title',
  'time.lessThanMinute',
  'time.minutes_one',
  'time.minutes_other',
  'toast.integration.testOk',
])

{
  // `it` ed `en` sono gia appiattiti in cima al file.
  for (const [k, v] of Object.entries(it)) {
    if (en[k] !== v) continue
    if (IT_EN_IDENTICHE_ACCETTATE.has(k)) continue
    // Solo simboli, numeri o interpolazioni: non e una frase da tradurre.
    if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(v.replace(/\{\{[^}]*\}\}/g, ''))) continue
    err(`[lingua] ${k}: il valore italiano e identico all'inglese ("${v}"). `
      + `Traducilo, oppure aggiungilo a IT_EN_IDENTICHE_ACCETTATE in scripts/check-i18n.mjs spiegando perche`)
  }
}

// ── report ───────────────────────────────────────────────────────────────────

for (const w of warnings) console.warn(`WARN  ${w}`)
for (const e of errors) console.error(`ERROR ${e}`)
console.log(`\ncheck-i18n: ${files.length} file, ${defined.size} chiavi, ${usedPrefixes.size} prefissi dinamici (${[...usedPrefixes].sort().join(', ') || '—'})`)
console.log(`  ${errors.length} errori, ${warnings.length} warning${STRICT ? ' (strict)' : ''}. ${DYNAMIC_KEY_ALLOWLIST_NOTE}.`)
process.exit(errors.length ? 1 : 0)
