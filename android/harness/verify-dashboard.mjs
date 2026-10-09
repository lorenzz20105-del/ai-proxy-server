import { createRequire } from 'module'
const require = createRequire('/root/.npm/_npx/705bc6b22212b352/')
const { chromium } = require('playwright')
import fs from 'fs'

const PORT = fs.readFileSync('/tmp/srv.log', 'utf8').match(/PORT=(\d+)/)[1]
const KEY = fs.readFileSync('/tmp/srv.log', 'utf8').match(/KEY=(\S+)/)[1]
const ORIGIN = `http://127.0.0.1:${PORT}`

const out = []
const ok = (label, pass, detail = '') => {
  out.push(`${pass ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 } })
await ctx.addInitScript((k) => {
  try { localStorage.setItem('aiproxy.api_key', k) } catch (e) {}
}, KEY)
const page = await ctx.newPage()
page.on('pageerror', e => out.push('PAGEERROR ' + e.message))
page.on('console', m => { if (m.type() === 'error') out.push('CONSOLE ' + m.text()) })

await page.goto(`${ORIGIN}/app/`, { waitUntil: 'domcontentloaded' })

// Key gate: the app must not demand a key, it is already supplied.
await page.waitForSelector('text=Base URL endpoint', { timeout: 15000 })
ok('dashboard loads without prompting', true)

// 1. Base URL endpoint is on the main dashboard
const urlRow = page.locator('.secret .mono').first()
const text = (await urlRow.textContent())?.trim() || ''
ok('base URL shown', text === `${ORIGIN}/v1`, text)

// 2. snippet tabs
await page.click('role=tab[name=python]')
const pre = page.locator('.code-block--tall').first()
const py = (await pre.textContent()) || ''
ok('python snippet renders', py.includes('base_url') && py.includes(ORIGIN + '/v1'))

// 3. create an API key from the main dashboard
await page.fill('#quickstart-key-name', 'playwright-e2e')
await page.click('button:has-text("Create API key")')
await page.waitForSelector('.secret .mono:has-text("sk-dash-")', { timeout: 15000 })
const revealed = (await page.locator('.secret .mono').nth(1).textContent())?.trim() || ''
ok('key revealed once', /^sk-dash-\S{20,}$/.test(revealed), revealed.slice(0, 14) + '…')

// 4. the key actually works against the proxy
const models = await page.evaluate(async ([origin, key]) => {
  const r = await fetch(`${origin}/v1/models`, { headers: { 'x-api-key': key } })
  return { status: r.status, body: await r.text() }
}, [ORIGIN, revealed])
ok('issued key authenticates', models.status === 200, 'status ' + models.status)

// 5. after the reveal is dismissed, the live key is gone from the page entirely
await page.click('button:has-text("Dismiss")')
await page.waitForTimeout(300)
const shown = await page.locator('.card').filter({ hasText: 'Create an API key' }).innerText()
ok('key gone from the page after dismiss', !shown.includes(revealed))
ok('masked form remains', shown.includes(revealed.slice(0, 6) + '…') || shown.includes('sk-dash-'))

// 6. new key appears in the "existing keys" row
ok('key listed by name', shown.includes('playwright-e2e'))

await page.screenshot({ path: '/tmp/overview.png', fullPage: true })

console.log(out.join('\n'))
console.log('SUMMARY ' + out.filter(l => l.startsWith('PASS')).length + ' passed, ' + out.filter(l => l.startsWith('FAIL')).length + ' failed')
await browser.close()
process.exit(out.some(l => l.startsWith('FAIL')) ? 1 : 0)
