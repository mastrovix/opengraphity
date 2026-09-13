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
  // `t` RINOMINATO: le sue chiavi diventano invisibili a questo controllo.
  // Terza revisione: `ReportListView.tsx` faceva `const { t: tr } = ...` perche
  // usava `t` per i template, e cinque chiavi `pages.reportBuilder.*` mancavano
  // da ENTRAMBE le lingue senza che nessuno se ne accorgesse — la pagina
  // mostrava i nomi delle chiavi, e l'ho visto solo girando nel browser.
  // Si rinomina l'ALTRA variabile, non `t`.
  for (const m of src.matchAll(/const\s*\{\s*t\s*:\s*([A-Za-z_$][\w$]*)/g)) {
    err(`[alias] ${r}:${lineOf(src, m.index)} \`t\` rinominato in \`${m[1]}\`: le sue chiavi `
      + `diventano invisibili a questo controllo. Rinomina l'altra variabile e lascia \`t\` a \`t\``)
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

// ── (c-bis) insiemi CHIUSI dietro un prefisso dinamico ───────────────────────
//
// Un prefisso dinamico (`t(`pages.domainMatrices.kinds.${kind}.title`)`) viene
// verificato sopra solo per ESISTENZA: basta che UNA chiave con quel prefisso
// ci sia. Ma in alcuni casi l'insieme dei valori e chiuso e noto al codice, e
// allora si puo pretendere che ci siano TUTTE.
//
// Terza revisione, trovato girando nel browser: la pagina «Matrici di dominio»
// — una delle pagine centrali del programma — mostrava
// `pages.domainMatrices.kinds.change_priority_initial.title` come testo,
// perche quella matrice era stata aggiunta senza la sua etichetta. Stessa
// famiglia delle quattordici chiavi `workflow.actions.*` che non esistevano
// affatto: un prefisso dinamico che nessuno confronta con l'insieme vero.
{
  const leggi = (rel) => {
    try { return fs.readFileSync(path.join(ROOT, rel), 'utf8') } catch { return '' }
  }
  const insiemi = [
    {
      nome:    'DOMAIN_MATRIX_KINDS',
      valori:  [...leggi('apps/api/src/lib/domainMatrix.ts')
        .match(/export const DOMAIN_MATRIX_KINDS = \{([\s\S]*?)\n\} as const/)?.[1]
        .matchAll(/^\s{2}([a-z_]+):\s*\{/gm) ?? []].map((m) => m[1]),
      chiavi:  (v) => [`pages.domainMatrices.kinds.${v}.title`, `pages.domainMatrices.kinds.${v}.description`],
    },
    {
      nome:    'WORKFLOW_ACTION_TYPES',
      valori:  [...(leggi('packages/workflow/src/types.ts')
        .match(/export const WORKFLOW_ACTION_TYPES = \[([\s\S]*?)\] as const/)?.[1] ?? '')
        .matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
      chiavi:  (v) => [`workflow.actions.${v}`],
    },
  ]
  for (const ins of insiemi) {
    if (ins.valori.length === 0) {
      err(`[insieme] non riesco a leggere ${ins.nome}: il controllo delle sue chiavi non sta girando`)
      continue
    }
    for (const v of ins.valori) {
      for (const k of ins.chiavi(v)) {
        if (!keyExists(k)) err(`[insieme] ${ins.nome} contiene "${v}" ma la chiave ${k} non esiste: `
          + `l'interfaccia mostrerebbe il nome della chiave`)
      }
    }
  }
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
  // «report» in italiano e un prestito INVARIABILE: al singolare la frase
  // coincide con l'inglese, e non c'e una traduzione diversa da dare.
  'pages.reportBuilder.count_one',
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
  // «team» e la parola che il prodotto usa in italiano (Team assegnato, Team e
  // Utenti): «squadra» non e il termine del dominio.
  'admin.sla.team',
  // «deploy» e la parola che il prodotto usa in italiano: il passo del workflow
  // si chiama cosi, e «dispiegamento» non lo dice nessuno.
  'changeTasks.deploy',
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

// ── (e) PROSA LETTERALE: stringhe che nessuno ha mai passato da `t()` ────────
//
// I controlli (b) e (c) verificano le chiavi che PASSANO da `t()`. Una stringa
// che non ci e mai passata e invisibile a entrambi: non ha una chiave da
// cercare, quindi non manca niente. E' il buco da cui sono entrati i 56
// letterali trovati girando nel browser — i peggiori sono le testate dei task
// della change (`label="Functional"`, `"Technical"`, `"Planning"`,
// `"Validation"`, `"Deploy"`, `"Review"`): inglese in un'interfaccia italiana,
// e nessun guardiano che dicesse niente.
//
// Cosa si guarda: il valore LETTERALE delle prop che finiscono a schermo, e i
// nodi di testo JSX. Cosa NON e prosa, e va lasciato stare: identificatori
// (snake_case, camelCase, kebab-case), valori CSS, percorsi, chiavi i18n,
// simboli e numeri. La regola e conservativa di proposito: un guardiano che
// grida al lupo viene spento, e allora non guarda piu niente.

/** Prop il cui valore letterale finisce sotto gli occhi di qualcuno. */
const PROP_VISIBILI = ['label', 'title', 'placeholder', 'aria-label', 'description', 'emptyMessage', 'emptyTitle', 'helpText', 'tooltip']
const RE_PROP_LETTERALE = new RegExp('\\b(' + PROP_VISIBILI.join('|') + ')="([^"{}]{2,})"', 'g')
/**
 * Testo JSX fra un tag e la sua CHIUSURA: `>Qualcosa</`.
 *
 * La chiusura e obbligatoria di proposito: con il solo `<` finale entravano i
 * generici TypeScript — `Promise<void>`, `Record<string, unknown>` — e il
 * guardiano segnalava «Promise» ventiquattro volte. Un guardiano che grida al
 * lupo viene spento.
 */
const RE_TESTO_JSX = new RegExp('>([^<>{}\\n]{4,})</', 'g')

/** Un identificatore o un valore tecnico: non e prosa da tradurre. */
function tecnico(v) {
  const t = v.trim()
  if (t.length < 2) return true
  if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(t)) return true                 // solo simboli o numeri
  if (/^[a-z0-9]+([_-][a-z0-9]+)+$/.test(t)) return true         // snake_case, kebab-case
  if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(t)) return true           // camelCase
  if (/^[a-z]+(\.[a-z][A-Za-z0-9_]*)+$/.test(t)) return true     // chiave i18n: pages.foo.bar
  if (/^(var\(|--|#[0-9a-fA-F]{3,8}$|\/|https?:|\d)/.test(t)) return true  // CSS, percorsi, URL, numeri
  if (/^[A-Z][a-zA-Z0-9]*$/.test(t) && t.length <= 3) return true // sigle corte (ID, OS, CI)
  return false
}

/**
 * Prosa: due parole, oppure una parola sola abbastanza lunga da essere un
 * termine dell'interfaccia (>= 4 lettere). Con una soglia piu bassa entrano
 * `px`, `auto`, `N/D` e simili.
 */
function prosa(v) {
  const t = v.trim()
  if (tecnico(t)) return false
  // Codice travestito da testo: virgolette, punti e virgola, uguali, parentesi.
  if (/['";=()]/.test(t)) return false
  if (/\s/.test(t)) return /[A-Za-zÀ-ÖØ-öø-ÿ]{2,}\s+\S/.test(t)
  // Una parola sola: solo se comincia per maiuscola. `input`, `value`, `label`
  // sono identificatori, «Annulla» e un bottone.
  return /^[A-ZÀ-Ö][a-zà-öø-ÿ]{3,}$/.test(t)
}

{
  /**
   * IL DEBITO DICHIARATO: quanti letterali di prosa ha ancora ogni file.
   *
   * Non una lista di file «sorvegliati» che si allarga a mano — che nessuno
   * allarga — ma il contrario: il debito è enumerato e **può solo scendere**.
   * Un file che non è qui e ha un letterale è un ERRORE; un file che è qui e
   * ne ha uno in più di quanti dichiara è un errore; uno che ne ha meno lo
   * dice, così il numero si aggiorna e non resta a mentire.
   *
   * I 394 di partenza sono prosa ITALIANA corretta: si rompono solo se qualcuno
   * usa l'inglese. Gli inglesi in interfaccia italiana — le testate dei task
   * della change, «Active Tasks», «Cancel», «Save», «Order», «Label» — erano
   * difetti di oggi e sono stati chiusi.
   */
  const PROSA_DEBITO = {
  'components/ActionParamsEditor.tsx': 5,
  'components/AutomationPreview.tsx': 1,
  'components/CIChangeList.tsx': 1,
  'components/CIIncidentsCard.tsx': 1,
  'components/ReportChartConfig.tsx': 9,
  'components/ReportPreview.tsx': 1,
  'components/ReportSectionBuilder.tsx': 14,
  'components/SimilarIncidentsPanel.tsx': 1,
  'components/UnifiedLinkedTickets.tsx': 4,
  'components/ticket/AffectedCIList.tsx': 3,
  'components/ticket/WorkflowTimeline.tsx': 1,
  'hooks/useCrudModal.ts': 2,
  'main.tsx': 1,
  'pages/MyTasksPage.tsx': 5,
  'pages/admin/AutoTriggersPage.tsx': 13,
  'pages/admin/BusinessRulesPage.tsx': 16,
  'pages/admin/KBAdminPage.tsx': 9,
  'pages/admin/MonitoringPage.tsx': 2,
  'pages/admin/QuestionAdminPage.tsx': 10,
  'pages/admin/SLAPoliciesPage.tsx': 8,
  'pages/admin/ServiceCatalogAdminPage.tsx': 20,
  'pages/assistant/AssistantPage.tsx': 1,
  'pages/changes/ChangeDetailPage.tsx': 31,
  'pages/changes/CreateChangePage.tsx': 6,
  'pages/changes/components/AddCIModal.tsx': 5,
  'pages/changes/components/AuditTimeline.tsx': 2,
  'pages/changes/components/CITasksTable.tsx': 3,
  'pages/changes/components/ChangeInfoCard.tsx': 10,
  'pages/changes/components/PlanModal.tsx': 1,
  'pages/changes/components/shared.tsx': 1,
  'pages/incidents/CreateIncidentPage.tsx': 4,
  'pages/incidents/IncidentDetailPage.tsx': 7,
  'pages/problems/CreateProblemPage.tsx': 4,
  'pages/problems/ProblemDetailPage.tsx': 6,
  'pages/reports/ReportListView.tsx': 11,
  'pages/reports/ReportScheduleSettings.tsx': 14,
  'pages/reports/ReportsPage.tsx': 4,
  'pages/reports/SLAReportPage.tsx': 31,
  'pages/requests/CreateServiceRequestPage.tsx': 2,
  'pages/requests/ServiceRequestDetailPage.tsx': 9,
  'pages/settings/CITypeDesignerPage.tsx': 6,
  'pages/settings/ITILTypeFields.tsx': 1,
  'pages/settings/ITILTypeSettings.tsx': 3,
  'pages/settings/NotificationRuleForm.tsx': 3,
  'pages/settings/NotificationsPage.tsx': 11,
  'pages/settings/SyncConflictsTab.tsx': 6,
  'pages/settings/SyncHistoryTab.tsx': 2,
  'pages/settings/SyncSourcesTab.tsx': 10,
  'pages/settings/citype/CIFieldEditor.tsx': 6,
  'pages/settings/citype/CIFieldInlineEditor.tsx': 5,
  'pages/settings/citype/CIRelationEditor.tsx': 7,
  'pages/settings/citype/CITypeList.tsx': 3,
  'pages/settings/citype/CreateTypeDialog.tsx': 5,
  'pages/settings/shared/FieldRulesPanel.tsx': 1,
  'pages/tasks/TaskViewPage.tsx': 3,
  'pages/tasks/components/AssessmentTaskForm.tsx': 1,
  'pages/tasks/components/ChangeOverviewSidebar.tsx': 2,
  'pages/tasks/components/PlanTaskForm.tsx': 5,
  'pages/teams/TeamDetailPage.tsx': 5,
  'pages/teams/TeamsPage.tsx': 1,
  'pages/users/UserDetailPage.tsx': 15,
  'pages/users/UsersPage.tsx': 2,
  'pages/workflow/WorkflowCanvas.tsx': 1,
  'pages/workflow/WorkflowStepPanel.tsx': 8,
  'pages/workflow/WorkflowToolbar.tsx': 1,
  'pages/workflow/WorkflowTransitionPanel.tsx': 2,
  }
  /** Quanti ne ammette un file: zero se non è nel debito. */
  const ammessi = (rel) => PROSA_DEBITO[rel] ?? 0

  for (const file of files) {
    const rel = path.relative(WEB_SRC, file)
    const src = fs.readFileSync(file, 'utf8')
    const trovati = []
    for (const m of src.matchAll(RE_PROP_LETTERALE)) {
      if (prosa(m[2])) trovati.push({ dove: `${m[1]}="${m[2]}"`, riga: lineOf(src, m.index) })
    }
    for (const m of src.matchAll(RE_TESTO_JSX)) {
      if (prosa(m[1])) trovati.push({ dove: `testo JSX «${m[1].trim()}»`, riga: lineOf(src, m.index) })
    }
    const quota = ammessi(rel)
    if (trovati.length > quota) {
      for (const t of trovati) {
        err(`[prosa] ${rel}:${t.riga} ${t.dove} — stringa a schermo mai passata da t(): non ha una chiave, quindi nessun controllo la vede`)
      }
      if (quota > 0) {
        err(`[prosa] ${rel}: ${trovati.length} letterali, il debito dichiarato ne ammette ${quota}. `
          + `Il debito può solo SCENDERE: sposta le stringhe in i18n, non alzare il numero`)
      }
    } else {
      for (const t of trovati) warn(`[prosa] ${rel}:${t.riga} ${t.dove} — debito dichiarato, da bonificare`)
      if (trovati.length < quota) {
        warn(`[prosa] ${rel}: ${trovati.length} letterali su ${quota} dichiarati — `
          + `aggiorna PROSA_DEBITO in scripts/check-i18n.mjs, altrimenti il numero mente`)
      }
    }
  }
}

for (const w of warnings) console.warn(`WARN  ${w}`)
for (const e of errors) console.error(`ERROR ${e}`)


console.log(`\ncheck-i18n: ${files.length} file, ${defined.size} chiavi, ${usedPrefixes.size} prefissi dinamici (${[...usedPrefixes].sort().join(', ') || '—'})`)
console.log(`  ${errors.length} errori, ${warnings.length} warning${STRICT ? ' (strict)' : ''}. ${DYNAMIC_KEY_ALLOWLIST_NOTE}.`)
process.exit(errors.length ? 1 : 0)
