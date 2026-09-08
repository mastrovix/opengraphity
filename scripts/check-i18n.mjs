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

// ── report ───────────────────────────────────────────────────────────────────

for (const w of warnings) console.warn(`WARN  ${w}`)
for (const e of errors) console.error(`ERROR ${e}`)
console.log(`\ncheck-i18n: ${files.length} file, ${defined.size} chiavi, ${usedPrefixes.size} prefissi dinamici (${[...usedPrefixes].sort().join(', ') || '—'})`)
console.log(`  ${errors.length} errori, ${warnings.length} warning${STRICT ? ' (strict)' : ''}. ${DYNAMIC_KEY_ALLOWLIST_NOTE}.`)
process.exit(errors.length ? 1 : 0)
