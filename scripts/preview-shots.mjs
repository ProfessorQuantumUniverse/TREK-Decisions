#!/usr/bin/env node
// Screenshots of the plugin UI inside `trek-plugin dev`'s themed /preview frame
// (sandboxed, opaque origin — like TREK), light + dark, desktop + phone, DE + EN.
// Needs a running dev server (`npm run dev`) and Playwright (devDependency).
//
// Usage: node scripts/preview-shots.mjs [--port 4317] [--out .trek-dev/shots] [--only name]
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? process.argv[i + 1] : def
}
const port = Number(arg('port', 4317))
const out = path.resolve(arg('out', '.trek-dev/shots'))
const only = arg('only', null)
fs.mkdirSync(out, { recursive: true })

const PHONE = { width: 390, height: 844 }
const DESKTOP = { width: 1440, height: 900 }

const scenarios = [
  { name: 'list-light-de', theme: 'light', locale: 'de', phone: false, steps: [] },
  { name: 'list-dark-de', theme: 'dark', locale: 'de', phone: false, steps: [] },
  { name: 'detail-light-de', theme: 'light', locale: 'de', phone: false, steps: ['open:0'] },
  { name: 'detail-dark-de', theme: 'dark', locale: 'de', phone: false, steps: ['open:0'] },
  { name: 'compare-light-de', theme: 'light', locale: 'de', phone: false, steps: ['open:0', 'compare'] },
  { name: 'compare-dark-en', theme: 'dark', locale: 'en', phone: false, steps: ['open:1', 'compare'] },
  { name: 'decide-light-de', theme: 'light', locale: 'de', phone: false, steps: ['open:0', 'decide:0'] },
  { name: 'option-form-dark-de', theme: 'dark', locale: 'de', phone: false, steps: ['open:1', 'addOption'] },
  { name: 'ai-form-light-de', theme: 'light', locale: 'de', phone: false, steps: ['open:1', 'addOption', 'ai'] },
  { name: 'phone-list-dark-de', theme: 'dark', locale: 'de', phone: true, steps: [] },
  { name: 'phone-detail-light-de', theme: 'light', locale: 'de', phone: true, steps: ['open:0'] },
  { name: 'phone-detail-dark-en', theme: 'dark', locale: 'en', phone: true, steps: ['open:1'] },
  // The store image (docs/screenshot.png): the decision view, cropped to 16:9.
  { name: 'store', theme: 'light', locale: 'en', phone: false, steps: ['open:1'], store: true },
].filter((s) => !only || s.name.includes(only))

const browser = await chromium.launch()
let failures = 0
for (const sc of scenarios) {
  const ctx = await browser.newContext({
    viewport: sc.phone ? PHONE : DESKTOP,
    deviceScaleFactor: sc.phone ? 2 : 1,
    isMobile: sc.phone,
    hasTouch: sc.phone,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  // The dev server's live-reload poll fails CORS from the opaque frame — a dev artifact.
  const devNoise = (t) => /__dev\/version|net::ERR_FAILED/.test(t)
  page.on('console', (m) => { if (m.type() === 'error' && !devNoise(m.text())) errors.push(m.text()) })
  page.on('dialog', (d) => d.accept())
  await page.goto(`http://localhost:${port}/preview`)
  await page.selectOption('#theme', sc.theme)
  // The preview speaks English and reports no viewport; layer the scenario on top.
  await page.evaluate(({ locale, phone }) => {
    const f = document.getElementById('f')
    const base = window.ctx ? window.ctx() : null
    const push = () => {
      const c = typeof ctx === 'function' ? ctx() : base
      c.locale = locale
      c.formats = Object.assign({}, c.formats, { locale })
      c.viewport = { surface: 'trip-tab', formFactor: phone ? 'phone' : 'desktop', fill: false, insets: { top: 0, bottom: 0 } }
      // '*' is the only target that reaches the frame: it is sandboxed without
      // allow-same-origin, so its origin is opaque and cannot be named. Dev tooling
      // only; the context carries no secrets.
      f.contentWindow.postMessage(c, '*')
    }
    window.__push = push
    push()
    setTimeout(push, 300)
  }, { locale: sc.locale, phone: sc.phone })
  const frame = page.frameLocator('#f')
  await frame.locator('.drow, .empty').first().waitFor({ timeout: 10000 })
  for (const step of sc.steps) {
    const [kind, n] = step.split(':')
    if (kind === 'open') {
      await frame.locator('.drow').nth(Number(n)).click()
      await frame.locator('.ocard, .cmp, .empty').first().waitFor()
    } else if (kind === 'compare') {
      await frame.locator('.seg button').nth(1).click()
      await frame.locator('table.cmp').waitFor()
    } else if (kind === 'decide') {
      await frame.locator('.ocard').nth(Number(n)).locator('.decidebtn').click()
      await frame.locator('.modal').waitFor()
    } else if (kind === 'ai') {
      await frame.locator('.modal .aibox .linkbtn').click()
      await frame.locator('.modal .aibody textarea').fill('Patio Andaluz – Wohnung mit Innenhof … 865 € … Check-in ab 16 Uhr')
      await frame.locator('.modal .aibody .trek-btn').click()
      await page.waitForTimeout(600)
    } else if (kind === 'addOption') {
      await frame.locator('.toolbar .trek-btn--primary').click()
      await frame.locator('.modal').waitFor()
    }
  }
  await page.waitForTimeout(1200)
  const file = path.join(out, `${sc.name}.png`)
  // A fixed-position modal in the (non-filling, very tall) preview frame stitches badly
  // in an element screenshot, so dialogs are captured as a plain viewport shot.
  const hasModal = sc.steps.some((s) => s.startsWith('decide') || s === 'addOption')
  if (sc.store) {
    const box = await page.locator('#f').boundingBox()
    const width = box.width
    const height = Math.round(width * 9 / 16)
    await page.screenshot({ path: path.resolve('docs/screenshot.png'), fullPage: true, clip: { x: box.x, y: box.y, width, height } })
  }
  if (hasModal) {
    await frame.locator('.modal').scrollIntoViewIfNeeded()
    await page.screenshot({ path: file })
  }
  else await page.locator('#f').screenshot({ path: file })
  if (errors.length) { failures++; console.log(`✗ ${sc.name}: ${errors.join(' | ')}`) } else console.log(`✓ ${sc.name} → ${path.relative(process.cwd(), file)}`)
  await ctx.close()
}
await browser.close()
process.exit(failures ? 1 : 0)
