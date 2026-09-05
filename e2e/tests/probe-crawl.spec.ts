import { test } from '@playwright/test'

const IDS = {
  incident: 'a7b59911-a04d-4b21-9386-f3139aef0428',
  problem:  '0cd43e75-1587-4476-89d2-a7d8381464a9',
  change:   'c9c15da7-31dc-4d58-8780-b7aa9fdd2c82',
  server:   '1f9b0c2f-5ec4-4aa9-a768-264880dc4c98',
  app:      '4f50da03-1f68-4138-b208-4c53554a85e5',
  user:     'b8d3ec9a-1bcc-4fc8-a724-11cf7a803414',
  team:     '47c52675-fc7f-4baa-a112-04cdf8d32f56',
  kbSlug:   'test-3-ba511331',
  request:  '033989df-0e53-4174-8137-2298b8a322ae',
  workflow: '2f47bd00-4cb3-4ae6-bb25-932c324aa914',
  group:    '65fe52ed-88c3-4c59-a0ba-3c01c0f17efe',
}

const ROUTES = [
  '/dashboard', '/approvals', '/knowledge-base', `/knowledge-base/${IDS.kbSlug}`, '/assistant',
  '/incidents', `/incidents/${IDS.incident}`, '/incidents/new',
  '/problems', `/problems/${IDS.problem}`, '/problems/new',
  '/changes', `/changes/${IDS.change}`, '/changes/new',
  '/requests', `/requests/${IDS.request}`, '/requests/new',
  '/my-tasks', '/cmdb',
  '/servers', `/servers/${IDS.server}`,
  '/applications', `/applications/${IDS.app}`,
  '/databases', '/database-instances', '/certificates',
  `/ci/dynamic_ci_group/${IDS.group}`,
  '/teams', `/teams/${IDS.team}`, '/users', `/users/${IDS.user}`,
  '/reports', '/custom-reports', '/anomalies', '/topology', '/analysis/what-if',
  '/workflow', `/workflow/${IDS.workflow}`,
  '/settings/ci-types', '/settings/enum-designer', '/settings/itil-designer',
  '/settings/notification-rules', '/settings/notifications', '/settings/profile', '/settings/sync',
  '/profile', '/logs',
  '/admin/audit', '/admin/monitoring', '/admin/queues', '/admin/knowledge-base',
  '/admin/triggers', '/admin/business-rules', '/admin/sla-policies',
  '/admin/integrations', '/admin/assessment-questions',
]

test('crawl every route and collect errors', async ({ page }) => {
  test.setTimeout(600_000)
  const report: string[] = []
  let consoleErrs: string[] = []
  let httpErrs: string[] = []

  page.on('console', m => { if (m.type() === 'error') consoleErrs.push(m.text().slice(0, 200)) })
  page.on('pageerror', e => consoleErrs.push('PAGEERROR: ' + String(e).slice(0, 200)))
  page.on('response', r => {
    if (r.status() >= 400 && !r.url().includes('favicon')) {
      httpErrs.push(`${r.status()} ${r.request().method()} ${r.url().slice(0, 120)}`)
    }
  })

  for (const route of ROUTES) {
    consoleErrs = []
    httpErrs = []
    try {
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      await page.waitForTimeout(2200)
      const body = await page.locator('body').innerText()
      const visible: string[] = []
      for (const re of [
        /Si è verificato un errore[^\n]*/, /Errore[^\n]{0,120}/, /Page not found/,
        /non trovat[oa][^\n]{0,60}/i, /crashed/i, /Impossibile[^\n]{0,80}/,
      ]) {
        const m = body.match(re)
        if (m) visible.push(m[0].trim())
      }
      if (consoleErrs.length || httpErrs.length || visible.length) {
        report.push(`ROUTE ${route}`)
        for (const v of visible) report.push(`  [UI] ${v}`)
        for (const h of [...new Set(httpErrs)].slice(0, 4)) report.push(`  [HTTP] ${h}`)
        for (const c of [...new Set(consoleErrs)].slice(0, 4)) report.push(`  [CONSOLE] ${c}`)
      }
    } catch (e) {
      report.push(`ROUTE ${route}`)
      report.push(`  [NAV-FAIL] ${String(e).slice(0, 150)}`)
    }
  }

  console.log('=====REPORT=====')
  console.log(report.length ? report.join('\n') : 'NESSUN ERRORE SU NESSUNA ROUTE')
  console.log('=====FINE=====')
})
