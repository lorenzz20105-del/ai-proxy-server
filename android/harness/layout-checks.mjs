import { createRequire } from 'module'
const require = createRequire('/root/.npm/_npx/705bc6b22212b352/')
const { chromium } = require('playwright')
import fs from 'fs'
const PORT = fs.readFileSync('/tmp/srv.log','utf8').match(/PORT=(\d+)/)[1]
const KEY  = fs.readFileSync('/tmp/srv.log','utf8').match(/KEY=(\S+)/)[1]
const ORIGIN = `http://127.0.0.1:${PORT}`
const out = []
const ok = (l, p, d='') => out.push(`${p?'PASS':'FAIL'} ${l}${d?' — '+d:''}`)

const browser = await chromium.launch()
for (const vp of [{width:1400,height:1000,name:'desktop'},{width:390,height:844,name:'phone'}]) {
  const ctx = await browser.newContext({ viewport:{width:vp.width,height:vp.height} })
  await ctx.addInitScript(k => { try{localStorage.setItem('aiproxy.api_key',k)}catch(e){} }, KEY)
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => { if (m.type()==='error') errors.push(m.text()) })
  await page.goto(`${ORIGIN}/app/`, { waitUntil:'domcontentloaded' })
  await page.waitForSelector('text=Base URL endpoint', { timeout:15000 })

  const panels = await page.$$eval('.grid--quickstart > .card', els =>
    els.map(e => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), t: (e.querySelector('.card__title')||{}).textContent } })
  )
  ok(`${vp.name}: two panels`, panels.length === 2, panels.map(p=>`${p.t} ${p.w}x${p.h}`).join(' | '))

  // both must be on screen at the top of the dashboard
  const y = await page.$eval('.grid--quickstart', el => Math.round(el.getBoundingClientRect().top))
  ok(`${vp.name}: panel sits at the top`, y < 400, `top=${y}px`)

  // nothing overflows horizontally
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(`${vp.name}: no horizontal overflow`, overflow <= 0, `${overflow}px`)

  // no text clipping inside the panels
  const clipped = await page.$$eval('.grid--quickstart *', els =>
    els.filter(e => e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflow === 'hidden').length)
  ok(`${vp.name}: no clipped text`, clipped === 0, `${clipped} nodes`)

  ok(`${vp.name}: no console errors`, errors.length === 0, errors.slice(0,2).join('; '))

  if (vp.name === 'desktop') {
    // every interactive control reachable
    for (const sel of ['#quickstart-key-name', 'button:has-text("Create API key")', 'role=tab[name=node]']) {
      const n = await page.locator(sel).count()
      ok(`${vp.name}: ${sel}`, n > 0)
    }
    // clicking a tab swaps the snippet
    await page.click('role=tab[name=node]')
    const code = await page.locator('.code-block--tall').first().innerText()
    ok(`${vp.name}: node snippet`, code.includes('openai'), '')
    await page.screenshot({ path:'/tmp/desk.png', fullPage:true })
  } else {
    await page.screenshot({ path:'/tmp/phone.png', fullPage:true })
  }
  await ctx.close()
}
console.log(out.join('\n'))
const f = out.filter(l=>l.startsWith('FAIL')).length
console.log(`SUMMARY ${out.length-f} passed, ${f} failed`)
await browser.close()
process.exit(f?1:0)
