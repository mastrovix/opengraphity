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
/**
 * Un template literal che COMPONE una chiave, anche fuori da `t(`)`
 * (revisione totale · H-23). `configurationIssueText.ts` costruisce
 * `configurationIssues.gap.${kind}` e la passa a un helper; `menu.ts` mette
 * `labelKey` in una tabella. Il prefisso entra solo se qualche chiave definita
 * comincia cosi: un template che non e una chiave (`${kind}:${id}`) non ha
 * prefisso e resta fuori.
 */
const RE_ANY_TEMPLATE_PREFIX = /`((?:[A-Za-z0-9_]+\.)+)\$\{/g

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
  for (const m of src.matchAll(RE_ANY_TEMPLATE_PREFIX)) {
    if ([...defined].some((k) => k.startsWith(m[1]))) usedPrefixes.add(m[1])
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

/*
  LE CHIAVI CHE USA L'API.

  Un errore dell'API porta una CHIAVE (`extensions.i18n`) e la frase la scrive
  il client: quelle chiavi vivono nei file di lingua del web ma non compaiono
  in nessun `t('…')` del web — le nomina il server. Senza guardare anche
  l'API, questo controllo le dichiarava tutte «mai usate»: 410 avvisi che
  nascondevano quelli veri.
*/
const API_SRC = path.join(ROOT, 'apps/api/src')
/**
 * Anche i PACCHETTI mandano chiavi (revisione totale · H-23):
 * `packages/workflow` compone `errors.workflow.condition.<nome>` e
 * `packages/notifications` ha le sue. Scansionando solo apps/api quelle chiavi
 * risultavano «definite e mai usate».
 */
const PKG_SRCS = fs.readdirSync(path.join(ROOT, 'packages'))
  .map((d) => path.join(ROOT, 'packages', d, 'src'))
  .filter((d) => fs.existsSync(d))
function sorgentiApi(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '__tests__') sorgentiApi(p, out); continue }
    if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}
for (const p of [API_SRC, ...PKG_SRCS].flatMap((d) => sorgentiApi(d))) {
  const src = fs.readFileSync(p, 'utf8')
  for (const m of src.matchAll(/key: '([A-Za-z0-9_.]+)'/g)) usedKeys.add(m[1])
  /**
   * Qualunque letterale che SIA una chiave definita (revisione totale · H-23).
   * `key: '...'` non copre tutte le forme con cui l'API manda una chiave:
   * `consequenceKey`, il ternario dentro `i18n: { key: ... }`, le chiavi nei
   * `params`. Quelle chiavi erano segnalate come «definite e mai usate»
   * mentre e l'API a mandarle — e prima del fix del prefisso vuoto il
   * controllo non parlava affatto.
   */
  for (const m of src.matchAll(/(['"`])((?:[A-Za-z0-9_]+\.)+[A-Za-z0-9_]+)\1/g)) {
    // `keyExists`, non `defined.has`: l'API manda la chiave BASE di un plurale
    // (`errors.ciType.relationUsedByServiceMaps`), e definite sono `_one`/`_other`.
    if (keyExists(m[2])) usedKeys.add(m[2])
  }
  /**
   * `errors.ciType.inUse${suffisso}`: la chiave si compone, e si valida il
   * prefisso. Un prefisso VUOTO non entra (revisione totale · H-23): non tutti
   * i `key:` dell'API sono chiavi i18n — `olaChangeUnits.ts` ha
   * `key: ${m.kind}:${p.id}:${i}`, che e l'identificativo di un tratto — e un
   * prefisso vuoto rende `k.startsWith(prefisso)` sempre vero, cioe spegne del
   * tutto il controllo (c) «chiavi definite e mai usate». Si vedeva
   * nell'intestazione: «prefissi dinamici (, admin.sla…)».
   */
  for (const m of src.matchAll(/key: `([A-Za-z0-9_.]*)\$\{/g)) {
    if (m[1].length > 0) usedPrefixes.add(m[1])
  }
  // Un template che compone una chiave anche fuori da `key:` (`consequenceKey`,
  // `errorI18n`, i `params`): il prefisso entra solo se e di chiavi vere.
  for (const m of src.matchAll(/`((?:[A-Za-z0-9_]+\.)+)\$\{/g)) {
    if ([...defined].some((k) => k.startsWith(m[1]))) usedPrefixes.add(m[1])
  }
  /**
   * RADICE IN UNA COSTANTE: `const K = 'errors.metamodelName'` e poi
   * `` `${K}.typeTaken` `` (revisione totale · H-23). E il modo con cui
   * `packages/schema-generator/src/nameValidation.ts` tiene le sue chiavi in un
   * posto solo, ed e buono — ma il template non ha prefisso statico, quindi
   * quelle 21 chiavi risultavano «mai usate». Qui si legge la costante e si
   * risolve `${NOME}.` nel suo valore.
   */
  const radici = new Map()
  for (const m of src.matchAll(/\bconst ([A-Z][A-Za-z0-9_]*) = '((?:[A-Za-z0-9_]+\.)+[A-Za-z0-9_]+)'/g)) {
    radici.set(m[1], m[2])
  }
  for (const m of src.matchAll(/`\$\{([A-Z][A-Za-z0-9_]*)\}((?:\.[A-Za-z0-9_]+)*)/g)) {
    const radice = radici.get(m[1])
    if (!radice) continue
    // `${K}.typeSyntax` e una chiave intera; `${K}.consequence.${x}` un prefisso.
    usedKeys.add(`${radice}${m[2]}`)
    usedPrefixes.add(`${radice}${m[2]}.`)
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
    /**
     * Le code dei job. Il nome di una coda (`events-maintenance`, `sla-jobs`)
     * dice a chi l'ha scritta cosa fa, e a nessun altro: la pagina Code mostra
     * sotto ogni nome la descrizione `pages.queueStats.queue.<nome>`. Il
     * perimetro e il registro UNICO delle code dell'API, non un elenco copiato
     * qui: una coda nuova la si dichiara in un posto solo e questo controllo
     * pretende subito la sua descrizione, nelle due lingue.
     */
    {
      nome:    'QUEUE_REGISTRY',
      valori:  [...(leggi('apps/api/src/lib/queueRegistry.ts')
        .match(/export const QUEUE_REGISTRY[^=]*= \[([\s\S]*?)\n\]/)?.[1] ?? '')
        .matchAll(/(?:name: '([a-z-]+)'|consumerEntry\('([a-z-]+)')/g)].map((m) => m[1] ?? m[2]),
      chiavi:  (v) => [`pages.queueStats.queue.${v}`],
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
  // «Workflow» è il nome della funzione del prodotto — il disegnatore si
  // chiama così anche in italiano, e l'intestazione di questa colonna nomina
  // lui (regola delle parole tecniche: resta inglese ciò che NOMINA).
  'pages.catalogForms.itinerary.workflow',
  // «File» è la parola italiana per un file: «archivio» vuol dire un'altra
  // cosa e «documento» pure. È il tipo di campo del modulo, non una frase
  // (regola delle parole tecniche: resta inglese ciò che NOMINA).
  'pages.catalogForms.fieldType.attachment',
  // «discovery» e il nome della funzione che scopre i CI da sola: l'origine di
  // un alias si chiama cosi anche in italiano (regola delle parole tecniche).
  // L'altra origine, «manual», e invece tradotta in «a mano» (revisione
  // totale · G-EVT-8).
  'events.aliases.source.discovery',
  // «business rule» e «trigger» sono nomi di funzioni del prodotto e restano
  // inglesi anche in italiano (regola delle parole tecniche); al singolare la
  // frase del conto coincide («1 business rule», «1 trigger»).
  'ciTypeDesigner.deleteImpact.businessRules_one',
  'ciTypeDesigner.deleteImpact.autoTriggers_one',
  // Nomi di prodotti esterni (ondata 8 di «Nulla cablato»): Slack, Microsoft
  // Entra ID e Google Workspace si chiamano così in ogni lingua.
  'admin.integrations.slack.tab',
  'pages.loginSecurity.providers.kind.microsoft',
  'pages.loginSecurity.providers.kind.google',
  // Durate compatte del badge SLA: «h» e «min» sono simboli di unita (SI),
  // uguali nelle due lingue; i giorni invece no («d» / «gg»).
  'time.short.minutes',
  'time.short.hoursMinutes',
  // «span» è il termine di OpenTelemetry per un tratto di traccia: si chiama
  // così anche in italiano (regola delle parole tecniche), e al singolare la
  // frase coincide (revisione totale · G-19).
  'pages.monitoring.spans_one',
  // «incident» e «problem» sono i nomi ITIL delle entità e restano uguali in
  // italiano, come in tutto il prodotto (regola delle parole tecniche): qui
  // servono a comporre «Risolvi incident INC…» invece del valore grezzo
  // interpolato di prima (revisione totale · F-27).
  'entities.incident',
  'entities.problem',
  // Nomi delle ENTITÀ nel costruttore dei report (revisione totale · C-18):
  // «Team», «CI», «Incident» e «Change» sono i nomi che il prodotto usa in
  // italiano, come in tutto il resto dell'interfaccia (regola delle parole
  // tecniche). Gli altri nomi dello stesso gruppo sono tradotti («Utente»,
  // «CI impattato», «Team assegnato»…), quindi non è una lista non tradotta.
  'reportBuilder.entity.team',
  'reportBuilder.entity.ci',
  'reportBuilder.entity.incident',
  'reportBuilder.entity.change',
  // «OLA / UC» sono due sigle ITIL: la stessa cosa nelle due lingue.
  // (`pages.slaReport.contracts` e `.slaSection` erano qui e sono state tolte
  // insieme alle loro chiavi, rimaste indietro dalla separazione fra SLA
  // Report e OLA/UC Report: un permesso che non serve piu e una porta aperta.)
  'sidebar.olaContracts',
  // Sigle e termini del reporting SLA, uguali nelle due lingue.
  'pages.slaReport.policy',
  'pages.slaReport.attainmentShort',
  /*
    PAROLE TECNICHE O D'USO STANDARD: in italiano si dicono in inglese, e
    tradurle rende il prodotto piu difficile da usare, non piu italiano.
    Nessuno cerca «Registro delle modifiche» in un menu: cerca «Audit Log».
    Regola: si traduce cio che DESCRIVE (una frase, un'istruzione, un errore);
    resta in inglese cio che NOMINA una cosa tecnica che si chiama cosi anche
    parlando italiano (Audit Log, Business Rules, Dry-run, Uptime, SPOF, i
    nomi dei disegnatori). Nel dubbio: come lo chiamerebbe, a voce, chi ci
    lavora?
  */
  // «CMDB» e la sigla ITIL del registro dei CI: il gruppo delle entita dei widget.
  'pages.dashboard.entityGroupCmdb',
  // «AI» e «Logo» si dicono cosi anche in italiano (ondata 6, pagina Organizzazione).
  'pages.organization.tabs.ai',
  'pages.organization.logoGroup',
  // «Root Cause Analysis» e il nome ITIL dell'analisi: in italiano si dice
  // cosi, e il campo del workflow si chiama `rootCause`.
  'pages.incidents.rootCauseAnalysis',
  // «Default» e la parola che il prodotto usa in italiano per il workflow
  // predefinito: e anche il valore che sta nel dato (`is_default`).
  'pages.workflow.defaultBadge',
  // «Bot API» e il nome del protocollo di Telegram: un nome proprio.
  'pages.notifications.channelIdProtocol',
  // «ITIL Types» e il nome del disegnatore, come `itilDesigner.title`.
  'itilDesigner.itilTypes',
  // «CMDB Sync» nomina la CMDB e l'operazione come le chiama chi ci lavora.
  'sync.title',
  // «OLA / UC» sono le sigle ITIL dei contratti (Operational Level Agreement,
  // Underpinning Contract), come nel menu e nel report OLA/UC.
  'ticketOla.title',
  // «Change Manager» e il ruolo ITIL del team che approva le change: si
  // chiama cosi anche in italiano (come `pages.teams.changeManager`).
  'changeTasks.approvalKind.change_manager',
  // «SLA Breach», «Escalation», «Timer», «Stop», «enum», «SLA Policies»: sono i
  // nomi che chi ci lavora usa parlando italiano, non frasi da tradurre. Sono
  // anche i nomi dei valori salvati (`sla_breach`, `on_timer`, `stopOnMatch`).
  // «Preview» e la parola che il prodotto usa in italiano per l'anteprima del
  // form del disegnatore: e il nome della tab, come lo chiama chi ci lavora.
  'citypeDesigner.tab.preview',
  // «Sourcing» e il termine ITIL/procurement per «da dove viene chi fa il
  // lavoro» (team interno o fornitore): scelto dal proprietario, uguale nelle due lingue.
  'pages.teams.sourcing.label',
  // «Attainment» e il termine SLA che si usa anche in italiano: e la
  // percentuale del contratto rispettata, e si chiama cosi nei report.
  'pages.slaReport.attainment',
  'admin.rules.stop',
  'admin.sla.tableLabel',
  'automation.eventFilter.onSlaBreach',
  'automation.eventFilter.onTimer',
  'automation.fieldType.enum',
  'pages.notifications.event.escalation',
  'pages.notifications.event.slaBreach',
  // «team» e la parola del dominio anche in italiano (come `admin.sla.team` e
  // `detail.team`): «squadra» non lo dice nessuno.
  'admin.sla.scopeTeam',
  'automation.fieldType.team',
  'automation.params.teamOption',
  // «min» e «h» sono le stesse abbreviazioni nelle due lingue; «g/gg» invece
  // differisce da «d», ed e tradotto (`admin.sla.unit.days_*`).
  'admin.sla.unit.hours_one',
  'admin.sla.unit.hours_other',
  'admin.sla.unit.minutes_one',
  'admin.sla.unit.minutes_other',
  'admin.integrations.test',
  'anomaly.rules.spof',
  'itilDesigner.title',
  'notificationRules.category.digest',
  'notificationRules.channels.inApp',
  'pages.audit.title',
  'pages.import.dryRun',
  'pages.kbAdmin.title',
  'pages.monitoring.health.uptime',
  'pages.monitoring.process.memory',
  'pages.monitoring.tracing.title',
  'roles.admin',
  'sidebar.admin',
  'sidebar.auditLog',
  'sidebar.businessRules',
  'sidebar.ciTypeDesigner',
  'sidebar.itilDesigner',
  'sidebar.kbAdmin',
  'sidebar.reportBuilder',
  'sidebar.reporting',
  'sidebar.workflowDesigner',
  'sidebar.workspace',
  // «Assessment» e il termine ITIL, lo stesso nelle due lingue: e il nome di una
  // fase del processo, non una frase.
  'pages.auditTimeline.cat.assessment',
  // «Area» e la stessa parola nelle due lingue: e il nome del tipo di grafico,
  // non una frase.
  'reportChart.type.area',
  // «report» in italiano e un prestito INVARIABILE: al singolare la frase
  // coincide con l'inglese, e non c'e una traduzione diversa da dare.
  'pages.reportBuilder.count_one',
  'admin.integrations.columns.url',
  'admin.integrations.entityChange',
  'admin.integrations.entityIncident',
  'admin.integrations.entityProblem',
  'admin.integrations.form.url',
  'bulk.team',
  'common.no',
  'conditionEditor.teamPlaceholder',
  'detail.team',
  // «team» e la parola che il prodotto usa in italiano (Team assegnato, Team e
  // Utenti): «squadra» non e il termine del dominio.
  'admin.sla.team',
  // «deploy» e la parola che il prodotto usa in italiano: il passo del workflow
  // si chiama cosi, e «dispiegamento» non lo dice nessuno.
  'changeTasks.deploy',
  // Stesse parole del processo change (Assessment, Review, Deploy) nei titoli dei task e nei pallini.
  'changeTasks.kind.assessment',
  'changeTasks.kind.review',
  'changeTasks.phaseName.deploy',
  'changeTasks.phaseName.review',
  'events.aliases.kind.fqdn',
  'events.aliases.kind.hostname',
  'events.aliases.kind.ip',
  'events.columns.ci',
  'events.columns.incident',
  'events.detail.acknowledgedBy',
  'events.policy.groupByOptions.ci',
  'events.policy.openFrom.info',
  'events.severity.info',
  'monitoring.edit.tokenTitle',
  'monitoring.errors.invalidJson',
  'monitoring.health.columns.ci',
  'monitoring.mapper.inWord',
  'monitoring.mapper.resourceKinds.fqdn',
  'monitoring.mapper.resourceKinds.hostname',
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
  'notificationRules.category.discovery',
  'notificationRules.category.escalation',
  'notificationRules.category.incident',
  'notificationRules.category.problem',
  'notificationRules.category.sla',
  'notificationRules.channels.email',
  'notificationRules.channels.slack',
  'notificationRules.channels.teams',
  'notificationRules.eventGroupStandard',
  'notificationRules.severity.info',
  'pages.audit.colIp',
  'pages.changes.count_one',
  'pages.cmdb.count_one',
  'pages.dashboard.badgeTeam',
  'pages.dashboard.cols_one',
  'pages.dashboard.fieldType.enum',
  'pages.dashboard.timeRange.24h',
  'pages.dashboard.title',
  'pages.dashboard.widgetFallback',
  'pages.dictionary.scopeCmdb',
  'pages.dictionary.scopeItil',
  'pages.import.columnsIncidents',
  'pages.import.columnsKb',
  // Ondata 5 di «Nulla cablato»: i nomi delle colonne del CSV sono gli stessi in ogni lingua.
  'pages.import.columnsProblems',
  'pages.import.columnsChanges',
  'pages.import.columnsRequests',
  'pages.incidents.count_one',
  'pages.incidents.impactedApplications.pathNodeFallback',
  'pages.kb.no',
  'pages.kb.title',
  'pages.logs.count_one',
  'pages.logs.timestamp',
  'pages.monitoring.health.keycloak',
  'pages.monitoring.health.neo4j',
  'pages.monitoring.health.redis',
  'pages.monitoring.neo4j.title',
  'pages.monitoring.process.cpu',
  'pages.monitoring.process.pid',
  'pages.monitoring.process.rss',
  'pages.monitoring.process.version',
  'pages.problems.count_one',
  'pages.profile.account',
  'pages.profile.english',
  'pages.profile.italian',
  'pages.queueStats.group.itsm',
  'pages.queueStats.payload',
  'pages.sync.modeInline',
  'pages.teams.count_one',
  'pages.topology.hops_one',
  'pages.users.email',
  'pages.users.password',
  'pages.workflow.title',
  'search.groups.kbArticles',
  'sidebar.cmdb',
  'sidebar.dashboard',
  'sidebar.database',
  'sidebar.knowledgeBase',
  'sidebar.server',
  'sla.title',
  'time.lessThanMinute',
  'time.minutes_one',
  'time.minutes_other',
])

{
  /*
    LA LISTA DEI PERMESSI PUO SOLO RESTRINGERSI.

    `IT_EN_IDENTICHE_ACCETTATE` dice «questa parola e la stessa nelle due
    lingue», e va bene per «Dashboard», «CMDB», «Email». Ma ci erano finite
    dentro 66 chiavi che erano soltanto NON TRADOTTE — «Audit Log»,
    «Knowledge Base Admin», «Platform monitoring», «Incident Information» — e
    finche restavano nella lista il difetto era dichiarato normale: chi apriva
    il prodotto in italiano leggeva quelle frasi in inglese, e nessun controllo
    lo diceva.
    Adesso sono tradotte, e le loro voci sono state togliere dalla lista. Una
    voce che non serve piu e un permesso valido per un difetto che non esiste:
    la porta aperta per rifarlo. Questo controllo le trova e le fa togliere.
  */
  const permessiMorti = [...IT_EN_IDENTICHE_ACCETTATE].filter((k) => it[k] === undefined || it[k] !== en[k])
  if (permessiMorti.length > 0) {
    err(`[lingua] IT_EN_IDENTICHE_ACCETTATE porta ${permessiMorti.length} voci che non servono piu `
      + `(la chiave non esiste, o l'italiano ora e diverso dall'inglese): toglile, altrimenti restano `
      + `un permesso pronto per un difetto futuro. ${permessiMorti.join(', ')}`)
  }

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
/*
  ATTRIBUTO DATO COME ESPRESSIONE: `title={cond ? 'Nuovo contratto' : '…'}`.
  La regex sopra vede solo `title="…"`, e bastava mettere il letterale dentro
  le graffe per passare — che e proprio cio che si fa quando il titolo dipende
  da una condizione. Il titolo del dialogo OLA/UC e rimasto italiano cosi.
  Qui si guardano i letterali a singolo apice dentro l'espressione; `t('chiave')`
  non e prosa (`prosa()` scarta un identificatore puntato).
*/
const RE_PROP_ESPRESSIONE = new RegExp('\\b(' + PROP_VISIBILI.join('|') + ')=\\{([^}]{0,200})\\}', 'g')
/**
 * Testo JSX fra un tag e la sua CHIUSURA: `>Qualcosa</`.
 *
 * La chiusura e obbligatoria di proposito: con il solo `<` finale entravano i
 * generici TypeScript — `Promise<void>`, `Record<string, unknown>` — e il
 * guardiano segnalava «Promise» ventiquattro volte. Un guardiano che grida al
 * lupo viene spento.
 */
/*
  SU PIU RIGHE. Escludere `\n` teneva fuori ogni frase andata a capo — ed e
  proprio come si scrive un paragrafo nel JSX. `[^<>]` garantisce comunque che
  dentro non ci sia altro markup: quello che si cattura e un solo nodo di testo.
*/
const RE_TESTO_JSX = new RegExp('>([^<>{}]{4,}?)</', 'g')
/*
  TESTO JSX CHE FINISCE SU UN'ESPRESSIONE O SU UN TAG (secondo giro UI del 15
  set 2026). `RE_TESTO_JSX` vuole la chiusura `</` subito dopo il testo, e cosi
  `>Requester: <strong>{nome}</strong>` e `>Functional score: {x}` passavano:
  25 etichette inglesi a schermo nell'interfaccia italiana, trovate nel browser
  e non da questo guardiano. Qui il testo finisce dove comincia `{` o un tag.
  `(?<![=-])` tiene fuori `=>` e i generici chiusi da `>=`; il codice che resta
  (`(GET_X, {`, `const styles: Record<`) si scarta in `testoAperto`.
*/
const RE_TESTO_JSX_APERTO = /(?<![=\-])>([^<>{}]*[A-Za-z][^<>{}]*?)(?=\{|<[A-Za-z/])/g
/** Un letterale scelto da una condizione e messo come figlio JSX: `>{ok ? 'enabled' : 'disabled'}<`. */
const RE_TERNARIO_JSX = />\s*\{[^{}\n]*\?\s*'([^']*)'\s*:\s*'([^']*)'\s*\}\s*</g
/** Il pezzo di testo di `RE_TESTO_JSX_APERTO`, ripulito; `null` se e codice. */
function testoAperto(grezzo) {
  const t = grezzo.trim()
  if (/[=;"'`()\[\]?]|&&|\|\||\n/.test(t)) return null
  if (/\b(const|return|if|let|await|async|function|export|import|type|interface|Record|Promise|Array|Partial|Pick|Omit|Set|Map|typeof|as|extends)\b/.test(t)) return null
  return t.replace(/^[·•|,–—-]+\s*/, '').replace(/[\s:]+$/, '')
}

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
  /*
    Codice travestito da testo. La regola era `/['";=()]/`, e buttava via anche
    la prosa vera: «Target risposta (min)» ha una parentesi, «Nessun OLA/UC
    definito; un UC lo lega a un fornitore» ha un punto e virgola — due
    letterali italiani che sono rimasti a schermo in un'interfaccia inglese
    finche non li ho visti in un browser. Restano fuori solo i segni che in una
    frase non compaiono: `=` e le virgolette (che nel JSX vogliono dire
    attributo, non testo).
  */
  if (/["=]/.test(t)) return false
  if (/\s/.test(t)) return /[A-Za-zÀ-ÖØ-öø-ÿ]{2,}\s+\S/.test(t)
  // Una parola sola: solo se comincia per maiuscola. `input`, `value`, `label`
  // sono identificatori, «Annulla» e un bottone.
  return /^[A-ZÀ-Ö][a-zà-öø-ÿ]{3,}$/.test(t)
}

{
  /**
   * IL DEBITO DICHIARATO: quanti letterali di prosa ha ancora ogni file.
   *
   * **È VUOTO, e questa è la cosa importante.** I 394 letterali di partenza (66
   * file) sono stati bonificati tutti: ogni stringa a schermo ha una chiave e
   * un valore in italiano e in inglese. Con la lista vuota la regola non è più
   * «il debito può solo scendere», è «non se ne aggiunge nessuno»: un
   * letterale in un file qualunque è un ERRORE, e il guardiano lo dice al primo
   * `check-i18n`.
   *
   * Non riaprire questa lista per far passare una stringa nuova. Serviva a
   * chiudere un debito esistente senza fermare tutto, e quel debito è chiuso:
   * scrivere qui un numero maggiore di zero è la scorciatoia che lo farebbe
   * ricominciare, un file per volta.
   *
   * (Il motivo per cui andava chiuso: la lingua del prodotto è l'inglese e
   * l'italiano è una scelta — chi legge in inglese vedeva 394 frasi italiane
   * in mezzo alla propria interfaccia.)
   */
  const PROSA_DEBITO = {
  }
  /** Quanti ne ammette un file: zero se non è nel debito. */
  const ammessi = (rel) => PROSA_DEBITO[rel] ?? 0

  /*
    I COMMENTI NON SONO SCHERMO.
    `useCrudModal.ts` ha un esempio d'uso nel suo commento
    (`<Button onClick={modal.openCreate}>Nuovo</Button>`) e questo guardiano lo
    accusava come prosa a schermo: un falso positivo che chiedeva di tradurre
    la documentazione. Un letterale dentro un commento — di riga o di blocco —
    non si legge da nessuna parte, e le righe di commento si escludono prima di
    guardare. (Scrivere qui la chiusura di un commento di blocco chiude QUESTO
    commento: preso subito, con un errore di sintassi.)
  */
  const righeDiCommento = (src) => {
    const righe = src.split('\n')
    const fuori = new Set()
    let dentroBlocco = false
    righe.forEach((riga, i) => {
      const t = riga.trim()
      if (dentroBlocco) { fuori.add(i + 1); if (t.includes('*/')) dentroBlocco = false; return }
      if (t.startsWith('//') || t.startsWith('*')) { fuori.add(i + 1); return }
      if (t.startsWith('/*')) { fuori.add(i + 1); if (!t.includes('*/')) dentroBlocco = true }
    })
    return fuori
  }

  for (const file of files) {
    const rel = path.relative(WEB_SRC, file)
    const src = fs.readFileSync(file, 'utf8')
    const commenti = righeDiCommento(src)
    const trovati = []
    for (const m of src.matchAll(RE_PROP_LETTERALE)) {
      const riga = lineOf(src, m.index)
      if (commenti.has(riga)) continue
      if (prosa(m[2])) trovati.push({ dove: `${m[1]}="${m[2]}"`, riga })
    }
    for (const m of src.matchAll(RE_PROP_ESPRESSIONE)) {
      const riga = lineOf(src, m.index)
      if (commenti.has(riga)) continue
      for (const q of m[2].matchAll(/'([^']{4,})'/g)) {
        if (prosa(q[1])) trovati.push({ dove: `${m[1]}={… '${q[1]}' …}`, riga })
      }
    }
    for (const m of src.matchAll(RE_TESTO_JSX)) {
      const riga = lineOf(src, m.index)
      if (commenti.has(riga)) continue
      if (prosa(m[1])) trovati.push({ dove: `testo JSX «${m[1].trim()}»`, riga })
    }
    for (const m of src.matchAll(RE_TESTO_JSX_APERTO)) {
      const riga = lineOf(src, m.index)
      if (commenti.has(riga)) continue
      const t = testoAperto(m[1])
      if (t && prosa(t)) trovati.push({ dove: `testo JSX «${t}» accanto a un'espressione`, riga })
    }
    for (const m of src.matchAll(RE_TERNARIO_JSX)) {
      const riga = lineOf(src, m.index)
      if (commenti.has(riga)) continue
      for (const v of [m[1], m[2]]) {
        // «\uD83D\uDCCA Excel»: un'icona e il nome di un formato, non una frase.
        if (/^(\\u[0-9A-Fa-f]{4})+\s*\S+$/.test(v)) continue
        if (prosa(v)) trovati.push({ dove: `letterale «${v}» scelto da una condizione`, riga })
      }
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

// ── (e) ITALIANO NEL SORGENTE ────────────────────────────────────────────────
//
// PERCHE' QUESTO CONTROLLO ESISTE, dopo (d).
//
// Il controllo (d) cerca «prosa a schermo» con un'euristica che non sa che
// lingua stia leggendo: per non gridare al lupo guarda solo i posti dove il
// testo si vede per certo — il valore di una prop visibile, un nodo di testo
// JSX pulito. Tutto il resto gli sfugge, e non e poco:
//
//   {loading ? 'Analisi in corso…' : 'Suggerisci triage'}      dentro le graffe
//   { label: 'Imposta priorita' }                              in una tabella di etichette
//   throw new Error('Il filtro «Titolo» ...')                   in un errore mostrato in un toast
//   >Creato il {fmtDate(x)}<                                    testo JSX con un'interpolazione
//   { key: 'name', label: 'Nome', sortable: true }              in una colonna di tabella
//
// Sono 150 letterali italiani trovati cosi, in un prodotto la cui lingua e
// l'inglese: chi apriva l'interfaccia in inglese leggeva quelle frasi in
// italiano. (d) diceva «0 errori» per tutti.
//
// La mossa che rende il controllo possibile: NON cercare «prosa», cercare
// ITALIANO. Distinguere una frase italiana da un identificatore inglese e
// facile — una vocale accentata, o una delle parole funzionali che in inglese
// non esistono — e allora si puo guardare OGNI stringa del sorgente senza
// falsi allarmi. Il prezzo e che l'inglese cablato non lo vede: quello resta
// affare di (d).
//
// I commenti e i test restano in italiano di proposito: sono per chi scrive il
// codice, non per chi lo usa.
{
  const PORTAL_SRC = path.join(ROOT, 'apps/portal/src')
  const ACCENTATE = /[àèéìòù]/
  /*
    Parole funzionali italiane che in inglese non esistono (o non esistono come
    parola intera). Servono per le frasi senza accenti: «Aggiungi campo»,
    «Nessun risultato», «Salva modifiche». La lista e volutamente di parole
    intere: `per` non deve accendersi su `person`.
  */
  const PAROLE_IT = new RegExp('^(?:'
    + 'non|della|delle|dello|degli|dalla|dallo|dagli|nella|nelle|nello|negli|alla|allo|alle|agli'
    // `col` e `coi` NON stanno in lista: `scope="col"` e HTML, non italiano.
    + '|nel|nei|sulla|sulle|sugli|dalle|periodo|periodi'
    + '|questo|questa|questi|queste|quando|quello|quella|perche|oppure|anche|soltanto|invece|ancora'
    + '|nessun|nessuna|nessuno|caricamento|conferma|annulla|aggiungi|elimina|modifica|modifiche'
    + '|salva|salvataggio|seleziona|scegli|errore|simili|titolo|impatto|impattati|assegna|assegnato'
    + '/|sollecita|riapri|cambia|apri|vedi|allarme|allarmi|sorgente|utente|utenti|obbligatorio'
    + '|almeno|inserisci|creata|creato|rimossa|rimosso|eliminata|eliminato|aggiornato|aggiornata'
    + '|campo|campi|valore|valori|ammesso|nome|nomi|gli|una|uno|che|con|per|dei|del|sul|sui|dal|dai'
    /*
      Seconda ondata di parole, aggiunte dopo che «Crea tipo» e «Creazione…»
      erano passate: nessuna delle due ha accenti, e nessuna delle loro
      parole era in lista. Le scelte qui sono volutamente PRUDENTI — niente
      `data`, `note`, `fine`, `ora`, `no`, che sono parole anche in inglese e
      accenderebbero il guardiano su stringhe inglesi legittime.
    */
    + '|crea|creazione|eliminazione|tipo|tipi|relazione|relazioni|impostazioni|ambiente|autore'
    + '|esecuzione|richiesta|richieste|azione|azioni|attivo|attiva|chiudi|indietro|avanti'
    + '|precedente|successivo|annullato|completato|fallito|esegui|mostra|nascondi|cerca|ricerca'
    + '|sorgenti|motivo|giorno|giorni|minuto|minuti|categoria|urgenza|gruppo|squadra|avviso'
    + '|messaggio|scadenza|durata|inizio|esito|verifica|salvato|salvata|inviato|inviata'
    + ')$', 'i')

  /*
    Una CHIAVE i18n non e una frase, anche quando contiene una parola italiana:
    `languages.${impostazioni.fallback}` e un percorso di chiave, e il nome
    della variabile e italiano perche i sorgenti di questo progetto lo sono.
  */
  const CHIAVE = /^[a-z][A-Za-z0-9_]*(?:\.(?:[A-Za-z0-9_]+|\$\{[^}]*\}))+\.?$/

  /*
    LA LISTA DELLE PAROLE ITALIANE È IT.JSON.

    La lista scritta a mano sopra non finisce mai: «(orario lavorativo)»
    nell'anteprima delle SLA policy è passato perché né «orario» né
    «lavorativo» c'erano. Ma la lista completa esiste già: sono le parole delle
    traduzioni italiane che non compaiono MAI in quelle inglesi. Cresce da sola
    a ogni frase tradotta, e toglie da sé le parole comuni alle due lingue
    («team», «Owner», «Incident», «SLA»). Solo parole di almeno 4 lettere: sotto,
    le coincidenze con identificatori e sigle diventano rumore.
  */
  const paroleDi = (valori) => {
    const out = new Set()
    for (const v of valori) {
      if (typeof v !== 'string') continue
      for (const w of v.replace(/\{\{[^}]*\}\}/g, ' ').replace(/<[^>]+>/g, ' ').match(/[A-Za-zÀ-ÖØ-öø-ÿ]{4,}/g) ?? []) {
        out.add(w.toLowerCase())
      }
    }
    return out
  }
  const paroleInglesi = paroleDi(Object.values(en))
  const PAROLE_SOLO_ITALIANE = new Set([...paroleDi(Object.values(it))].filter((w) => !paroleInglesi.has(w)))

  const italiano = (testo) => {
    // Le interpolazioni di un template sono CODICE: `${chiave} (${extra})` ha
    // nomi di variabile italiani, non testo a schermo.
    const t = testo.replace(/\$\{[^}]*\}/g, ' ').trim()
    // Una chiamata di metodo (`LINGUE.flatMap(`) catturata come testo JSX e codice.
    if (/[A-Za-z_]\.[A-Za-z_]\w*\(/.test(t)) return false
    // Un confronto o un'espressione presi fra un `>` e un `<`: `valutazioni > 0 ? (a / b) * 100 : null`.
    // Ternario, freccia, punto e virgola e moltiplicazione non stanno in una frase a schermo.
    if (/\?\s*[(\w'"`]|=>|;|\s\*\s/.test(t) && /[(){}]|\bnull\b|\bundefined\b/.test(t)) return false
    if (t.length < 3) return false
    if (CHIAVE.test(t)) return false
    if (ACCENTATE.test(t)) return true
    const parole = t.match(/[A-Za-zÀ-ÖØ-öø-ÿ']+/g)
    if (!parole) return false
    return parole.some((w) => PAROLE_IT.test(w) || (w.length >= 4 && PAROLE_SOLO_ITALIANE.has(w.toLowerCase())))
  }

  /*
    Le stringhe si cercano DOPO aver spento i commenti: un commento italiano
    (che e la norma in questo progetto) non e testo a schermo. Spegnere vuol
    dire sostituire i caratteri con spazi, cosi i numeri di riga non si spostano.
  */
  const senzaCommenti = (src) => {
    let out = ''
    let i = 0
    let stringa = null
    while (i < src.length) {
      const c = src[i]
      if (stringa === null) {
        if (c === '/' && src[i + 1] === '/') {
          let j = src.indexOf('\n', i); if (j < 0) j = src.length
          out += ' '.repeat(j - i); i = j; continue
        }
        if (c === '/' && src[i + 1] === '*') {
          let j = src.indexOf('*' + '/', i + 2); j = j < 0 ? src.length : j + 2
          for (let k = i; k < j; k++) out += src[k] === '\n' ? '\n' : ' '
          i = j; continue
        }
        if (c === '"' || c === "'" || c === '`') { stringa = c; out += c; i++; continue }
        /*
          UN LETTERALE REGEX NON E' UNA STRINGA — e puo contenere un backtick.
          `body.replace(/[#*`[\]]/g, '')` in KBListPage.tsx: quel backtick
          faceva da apertura, e si appaiava con il primo backtick vero
          cinquanta righe sotto, inghiottendo un oggetto di stili interi e
          facendolo passare per una frase. Si riconosce dal carattere
          precedente: dopo un valore (`)`, un identificatore, un numero) lo
          slash e una divisione; dopo `( , = : [ ! & | ? { ; return` e un
          letterale regex.
        */
        if (c === '/' && /[(,=:[!&|?{;\n]\s*$/.test(out.replace(/\s+$/, (sp) => sp.includes('\n') ? '\n' : ' '))) {
          let j = i + 1
          let dentroClasse = false
          while (j < src.length) {
            const d = src[j]
            if (d === '\\') { j += 2; continue }
            if (d === '\n') break                       // una regex non va a capo: non era una regex
            if (d === '[') dentroClasse = true
            else if (d === ']') dentroClasse = false
            else if (d === '/' && !dentroClasse) { j++; break }
            j++
          }
          if (src[j - 1] === '/') { out += ' '.repeat(j - i); i = j; continue }
        }
        out += c; i++; continue
      }
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue }
      out += c
      if (c === stringa) stringa = null
      i++
    }
    return out
  }

  const RE_STRINGA = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/gs
  /*
    Testo JSX con interpolazioni: `>Creato il {fmtDate(x)}<`. Si guardano solo
    i pezzi FUORI dalle graffe (le graffe diventano uno spazio), e si scarta
    tutto cio che contiene `=` o virgolette, che nel JSX vuol dire attributo.
  */
  const RE_TESTO_CON_ESPRESSIONI = /> {0,400}([^<>]{2,400}?)</gs
  /*
    E il testo che finisce dove COMINCIA un'espressione, non dove comincia un
    tag: `>Salva modifiche{pendingCount > 0 && (`. Il `>` dentro `pendingCount
    > 0` fa si che il primo `<` utile sia righe piu sotto, quindi la regex qui
    sopra cattura mezzo blocco di codice e la scarta. Questa si fermaal `{`.
  */
  const RE_TESTO_PRIMA_DI_ESPRESSIONE = /> {0,400}([^<>{}]{3,400}?)\{/gs

  const daScansionare = [...files.map((f) => [f, WEB_SRC])]
  if (fs.existsSync(PORTAL_SRC)) {
    for (const f of walk(PORTAL_SRC)) daScansionare.push([f, path.join(ROOT, 'apps')])
  }

  for (const [file, base] of daScansionare) {
    const relPath = path.relative(base, file)
    const pulito = senzaCommenti(fs.readFileSync(file, 'utf8'))
    const visti = new Set()
    const segnala = (riga, dove) => {
      const chiave = `${riga}|${dove}`
      if (visti.has(chiave)) return
      visti.add(chiave)
      err(`[italiano] ${relPath}:${riga} ${dove} — italiano cablato nel sorgente: `
        + `la lingua del prodotto e l'inglese, e l'italiano e una scelta del cliente. `
        + `Spostalo in i18n (chiave + valore it/en)`)
    }
    for (const m of pulito.matchAll(RE_STRINGA)) {
      const testo = m[1] ?? m[2] ?? m[3] ?? ''
      if (italiano(testo)) segnala(lineOf(pulito, m.index), `«${testo.slice(0, 80).replace(/\n/g, ' ')}»`)
    }
    for (const m of pulito.matchAll(RE_TESTO_PRIMA_DI_ESPRESSIONE)) {
      const testo = m[1]
      if (/[="']/.test(testo)) continue
      if (italiano(testo)) segnala(lineOf(pulito, m.index), `testo JSX «${testo.trim().slice(0, 80)}»`)
    }
    for (const m of pulito.matchAll(RE_TESTO_CON_ESPRESSIONI)) {
      const grezzo = m[1]
      if (/[="']/.test(grezzo)) continue
      const testo = grezzo.replace(/\{[^{}]*\}/g, ' ')
      /*
        Una graffa RIMASTA vuol dire che si e catturato mezzo blocco di codice,
        non un nodo di testo: `{!impostazioni && loading ? (` finiva segnalato
        perche il ternario si chiude righe piu sotto e la sostituzione delle
        graffe bilanciate non lo tocca. Il nome della variabile e italiano, il
        testo a schermo no.
      */
      if (/[{}]/.test(testo)) continue
      if (italiano(testo)) segnala(lineOf(pulito, m.index), `testo JSX «${testo.trim().slice(0, 80)}»`)
    }
  }
}

// ── (f) LA DATA NON LA FORMATTA IL BROWSER ───────────────────────────────────
//
// `new Date(x).toLocaleDateString()` SENZA locale usa quello del browser. Su
// una macchina italiana l'interfaccia in inglese mostrava «13/09/2026» — la
// stessa colonna, due formati, a seconda del computer di chi guarda. E' lo
// stesso difetto per cui `navigator` e' stato togliere dal rilevamento della
// lingua: il browser non decide la lingua di questo prodotto.
//
// La lingua attiva la sa `apps/web/src/lib/datetime.ts` (`currentLocale()`, da
// `i18n.resolvedLanguage`), e le sue funzioni la passano a `Intl`. Chi formatta
// una data passa da li'. Trovati cosi' 18 siti, tutti in tabelle e pannelli.
{
  const RE_TOLOCALE = /\.toLocale(?:Date|Time)?String\(\s*\)/g
  const daScansionare = [...files.map((f) => [f, WEB_SRC])]
  const PORTAL = path.join(ROOT, 'apps/portal/src')
  if (fs.existsSync(PORTAL)) for (const f of walk(PORTAL)) daScansionare.push([f, path.join(ROOT, 'apps')])

  for (const [file, base] of daScansionare) {
    const relPath = path.relative(base, file)
    // Le righe di commento si escludono: la nota in testa a `datetime.ts`
    // CITA la chiamata sbagliata per spiegare perche' e' sbagliata, e un
    // guardiano che accusa la propria documentazione viene spento.
    const src = fs.readFileSync(file, 'utf8')
    const commenti = new Set()
    {
      let dentroBlocco = false
      src.split('\n').forEach((riga, i) => {
        const t = riga.trim()
        if (dentroBlocco) { commenti.add(i + 1); if (t.includes('*' + '/')) dentroBlocco = false; return }
        if (t.startsWith('//') || t.startsWith('*')) { commenti.add(i + 1); return }
        if (t.startsWith('/*')) { commenti.add(i + 1); if (!t.includes('*' + '/')) dentroBlocco = true }
      })
    }
    for (const m of src.matchAll(RE_TOLOCALE)) {
      const riga = lineOf(src, m.index)
      if (commenti.has(riga)) continue
      err(`[data] ${relPath}:${riga} ${m[0]} senza locale — `
        + `prende quello del BROWSER, non la lingua del prodotto. `
        + `Usa formatDate / formatDateTime / formatTime da @/lib/datetime`)
    }
  }
}

// ── (g) LE CHIAVI DEL PORTALE ESISTONO NEI FILE DEL PORTALE ────────────────────
//
// Il portale ha i SUOI locale (`apps/portal/src/i18n/{en,it}.json`), e nessun
// controllo li guardava: tre chiavi nuove del portale erano finite nei file del
// web, e il portale avrebbe mostrato «kb.thanksFeedback» a schermo. Stessa
// regola del web: una chiave usata con t('…') esiste in entrambe le lingue.
{
  const PORTAL_SRC = path.join(ROOT, 'apps/portal/src')
  const PORTAL_I18N = path.join(PORTAL_SRC, 'i18n')
  if (fs.existsSync(PORTAL_I18N)) {
    const pEn = flatten(JSON.parse(fs.readFileSync(path.join(PORTAL_I18N, 'en.json'), 'utf8')))
    const pIt = flatten(JSON.parse(fs.readFileSync(path.join(PORTAL_I18N, 'it.json'), 'utf8')))
    const esiste = (tab, k) => tab[k] !== undefined || Object.keys(tab).some((x) => x.startsWith(k + '_'))
    /**
     * PARITA' fra le due lingue e nessun valore vuoto (revisione totale · H-24).
     * Il controllo guardava solo `t('chiave')`: una chiave aggiunta al solo
     * `en.json` passava, e il portale italiano mostrava il NOME della chiave a
     * schermo. Le due tabelle devono avere le stesse chiavi (i plurali a parte,
     * che dipendono dalla lingua) e nessun valore vuoto.
     */
    const pluraleDi = (k) => k.replace(/_(zero|one|two|few|many|other)$/, '')
    const basiEn = new Set(Object.keys(pEn).map(pluraleDi))
    const basiIt = new Set(Object.keys(pIt).map(pluraleDi))
    for (const k of basiEn) if (!basiIt.has(k)) err(`[portal] chiave in portal/en.json e non in portal/it.json: ${k}`)
    for (const k of basiIt) if (!basiEn.has(k)) err(`[portal] chiave in portal/it.json e non in portal/en.json: ${k}`)
    for (const [lingua, tab] of [['en', pEn], ['it', pIt]]) {
      for (const [k, v] of Object.entries(tab)) {
        if (typeof v !== 'string' || v.trim() === '') err(`[portal] valore vuoto in portal/${lingua}.json: ${k}`)
      }
    }

    for (const file of walk(PORTAL_SRC)) {
      const src = fs.readFileSync(file, 'utf8')
      for (const m of src.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)) {
        const k = m[1]
        for (const [lingua, tab] of [['en', pEn], ['it', pIt]]) {
          if (!esiste(tab, k)) err(`[portal] ${path.relative(ROOT, file)}:${lineOf(src, m.index)} chiave non definita in portal/${lingua}.json: ${k}`)
        }
      }
      /**
       * Anche i TEMPLATE (H-24): `t(\`ticket.status.${status}\`)`,
       * `t(\`portal.languageName.${l}\`)`, `t(\`ticket.empty.${filter}\`)`.
       * Si valida il prefisso: almeno una chiave deve cominciare cosi, in
       * entrambe le lingue.
       */
      for (const m of src.matchAll(/\bt\(\s*`([a-zA-Z0-9_.]*)\$\{/g)) {
        const prefisso = m[1]
        const riga = lineOf(src, m.index)
        if (!prefisso) {
          err(`[portal] ${path.relative(ROOT, file)}:${riga} t(\`\${…}\`) senza prefisso statico: non verificabile`)
          continue
        }
        for (const [lingua, tab] of [['en', pEn], ['it', pIt]]) {
          if (!Object.keys(tab).some((k) => k.startsWith(prefisso))) {
            err(`[portal] ${path.relative(ROOT, file)}:${riga} nessuna chiave con prefisso "${prefisso}" in portal/${lingua}.json`)
          }
        }
      }
    }
  }
}

// ── (h) ETICHETTE LETTERALI: `label: 'Testo'` ────────────────────────────────
//
// Da dove viene questo controllo: la pagina Log aveva QUATTRO intestazioni di
// colonna scritte in inglese nel sorgente («Timestamp», «Level», «Module»,
// «Message»), in un elenco a livello di modulo dove `t` non arriva. Le chiavi
// tradotte esistevano da sempre e restavano inutilizzate — ed era l'unica
// traccia del difetto, un warning «chiave definita e mai usata» fra i tanti.
// Le liste di incident, problem e richieste avevano «Number», l'amministrazione
// della Knowledge Base «Status» e «Views», l'editor delle azioni le tre
// modalità di approvazione in inglese. Per quelle la chiave non era mai stata
// scritta, quindi NESSUN controllo poteva accorgersene: il guardiano cerca
// l'italiano cablato, non l'inglese.
//
// Cosa si segnala: `label: '…'` il cui valore SEMBRA testo da leggere, cioè
// contiene uno spazio oppure comincia con la maiuscola.
//
// Cosa NON si segnala, e perché:
//  - `label: ''` — una colonna senza intestazione (icone, azioni): non è testo;
//  - una parola minuscola (`label: 'pause'`, `label: 'majority'`) — in questo
//    codice è quasi sempre un FRAMMENTO DI CHIAVE (`t(\`…actions.${a.label}\`)`)
//    o il nome di un parametro, non una frase. È il limite dichiarato di
//    questo controllo: preferisce non gridare al lupo.
//  - quello che sta in LABEL_LETTERALI_ACCETTATI qui sotto, con il suo perché.
{
  /**
   * Etichette che restano letterali, ognuna con la sua ragione. Sono NOMI di
   * valori tecnici che si scrivono così in ogni lingua: tradurli qui
   * spezzerebbe la corrispondenza con quello che la riga accanto mostra.
   */
  const LABEL_LETTERALI_ACCETTATI = new Map([
    // Operatori logici del costruttore di regole: si scrivono AND e OR ovunque.
    ['AND', 'operatore logico'],
    ['OR',  'operatore logico'],
    // Livelli del logger (pino): la colonna «Livello» li mostra GREZZI e in
    // maiuscolo (`LevelBadge`), quindi il filtro deve dire la stessa parola.
    ['Trace', 'livello del logger'], ['Debug', 'livello del logger'],
    ['Info',  'livello del logger'], ['Warn',  'livello del logger'],
    ['Error', 'livello del logger'], ['Fatal', 'livello del logger'],
    // Moduli che scrivono nel log: sono l'identificativo scritto nel record
    // (`module: 'frontend'`), e la colonna «Modulo» li mostra grezzi.
    ['HTTP', 'modulo del log'], ['GraphQL', 'modulo del log'], ['Auth', 'modulo del log'],
    ['Workflow', 'modulo del log'], ['Notification', 'modulo del log'], ['Frontend', 'modulo del log'],
  ])

  const RE_LABEL_LETTERALE = /\blabel:\s*(['"])((?:[^'"\\]|\\.)*)\1/g
  const sorgentiEtichette = [
    ...files.map((f) => [f, WEB_SRC]),
    ...(fs.existsSync(path.join(ROOT, 'apps/portal/src'))
      ? [...walk(path.join(ROOT, 'apps/portal/src'))].map((f) => [f, path.join(ROOT, 'apps')])
      : []),
  ]

  const usati = new Set()
  for (const [file, base] of sorgentiEtichette) {
    // I mock dei test dichiarano dati finti, non interfaccia.
    if (file.includes('/test/') || /\.test\.[jt]sx?$/.test(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    for (const m of src.matchAll(RE_LABEL_LETTERALE)) {
      const valore = m[2]
      if (valore === '') continue
      const sembraTesto = valore.includes(' ') || /^[A-ZÀ-Ö]/.test(valore)
      if (!sembraTesto) continue
      if (LABEL_LETTERALI_ACCETTATI.has(valore)) { usati.add(valore); continue }
      err(`[etichetta] ${path.relative(base, file)}:${lineOf(src, m.index)} etichetta scritta nel sorgente: label: "${valore}". `
        + `Passa da i18n (t('…')), oppure aggiungila a LABEL_LETTERALI_ACCETTATI in scripts/check-i18n.mjs spiegando perche resta letterale`)
    }
  }

  // Un permesso che non serve piu e una porta aperta: stessa regola di IT_EN_IDENTICHE_ACCETTATE.
  const morti = [...LABEL_LETTERALI_ACCETTATI.keys()].filter((v) => !usati.has(v))
  if (morti.length > 0) {
    err(`[etichetta] LABEL_LETTERALI_ACCETTATI porta ${morti.length} voci che nessun sorgente usa piu: toglile. ${morti.join(', ')}`)
  }
}

for (const w of warnings) console.warn(`WARN  ${w}`)
for (const e of errors) console.error(`ERROR ${e}`)


console.log(`\ncheck-i18n: ${files.length} file, ${defined.size} chiavi, ${usedPrefixes.size} prefissi dinamici (${[...usedPrefixes].sort().join(', ') || '—'})`)
console.log(`  ${errors.length} errori, ${warnings.length} warning${STRICT ? ' (strict)' : ''}. ${DYNAMIC_KEY_ALLOWLIST_NOTE}.`)
process.exit(errors.length ? 1 : 0)
