#!/usr/bin/env node
// Clicks through the main flow in `trek-plugin dev`'s /preview frame:
// create decision → add option → vote → add a pro → decide (booking + cost) → reopen.
// Needs a running dev server; leaves an extra decision behind (re-run `npm run seed`).
import { chromium } from 'playwright'

const port = 4317
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error' && !/__dev\/version|ERR_FAILED/.test(m.text())) errors.push(m.text()) })
page.on('dialog', (d) => d.accept()) // the preview answers trek.confirm with window.confirm
const step = (s) => console.log('·', s)

await page.goto(`http://localhost:${port}/preview`)
const f = page.frameLocator('#f')
await f.locator('.drow, .empty').first().waitFor()

step('create decision')
await f.getByRole('button', { name: /New decision|Neue Entscheidung/ }).first().click()
await f.locator('.modal input.trek-input').first().fill('E2E Flamenco-Abend')
await f.locator('.modal select').selectOption('aktivitaet', { force: true })
await f.locator('.modal button[type=submit]').click()
await f.locator('h1.dtitle', { hasText: 'E2E Flamenco-Abend' }).waitFor()

step('add option')
await f.locator('.toolbar .trek-btn--primary').click()
const inputs = f.locator('.modal form input.trek-input')
await inputs.nth(0).fill('Casa de la Memoria')
await inputs.nth(1).fill('javascript:alert(1)')
await f.locator('.modal button[type=submit]').click()
await f.locator('.modal .err:not(.hidden)').first().waitFor() // client-side URL check
await inputs.nth(1).fill('https://www.casadelamemoria.es/')
await inputs.nth(2).fill('96,50')
await f.locator('.modal input[type=date]').fill('2027-04-11')
await f.locator('.modal input[type=time]').fill('19:30')
await f.locator('.modal button[type=submit]').click()
await f.locator('.ocard h3', { hasText: 'Casa de la Memoria' }).waitFor()
if (!(await f.locator('.ocard .price .big').first().textContent()).match(/96[.,]50/)) throw new Error('price not shown')

step('vote + pro')
await f.locator('.ocard .vote.up').first().click()
await f.locator('.ocard .vote.up.on').first().waitFor()
await f.locator('.ocard .linkbtn').first().click() // the input opens on demand
await f.locator('.ocard .pcadd input').first().fill('Beste Show der Stadt')
await f.locator('.ocard .pcadd input').first().press('Enter')
await f.locator('.ocard .pro li', { hasText: 'Beste Show der Stadt' }).waitFor()

step('card menu: edit option')
await f.locator('.ocard .kebab > .iconbtn').first().click()
await f.locator('.ocard .menu button').first().click()
await f.locator('.modal').waitFor()
await f.locator('.modal .iconbtn[aria-label]').first().click() // close
await f.locator('.modal').waitFor({ state: 'detached' })

step('post as collab poll')
await f.locator('.toolbar .trek-btn--primary').click()
await f.locator('.modal form input.trek-input').nth(0).fill('Tablao El Arenal')
await f.locator('.modal button[type=submit]').click()
await f.locator('.ocard h3', { hasText: 'Tablao El Arenal' }).waitFor()
await f.locator('.topbar .kebab > .iconbtn').click()
await f.locator('.topbar .menu button').first().click()
await f.locator('.pollbar').waitFor()

step('link autofill reads dates from the URL')
await f.locator('.toolbar .trek-btn--primary').click()
{
  const urlInput = f.locator('.modal input[type=url]')
  await urlInput.fill('https://www.booking.com/hotel/es/tablao-cordobes.de.html?checkin=2027-04-12&checkout=2027-04-13')
  await urlInput.dispatchEvent('change')
  const date = await f.locator('.modal input[type=date]').inputValue()
  const t = await f.locator('.modal form input.trek-input').nth(0).inputValue()
  if (date !== '2027-04-12' || t !== 'Tablao Cordobes') throw new Error(`link autofill: ${date} / ${t}`)
  await f.locator('.modal .iconbtn[aria-label]').first().click()
  await f.locator('.modal').waitFor({ state: 'detached' })
}

step('AI import pre-fills the option form')
await f.locator('.toolbar .trek-btn--primary').click()
await f.locator('.modal .aibox .linkbtn').click()
await f.locator('.modal .aibody textarea').fill('Gemütliche Wohnung mit Innenhof in Sevilla, 4 Gäste, 865 € …')
await f.locator('.modal .aibody .trek-btn').click()
await f.locator('.modal form input.trek-input').nth(0).and(f.locator('[aria-invalid="false"]')).waitFor()
const aiTitle = await f.locator('.modal form input.trek-input').nth(0).inputValue()
if (!aiTitle) throw new Error('AI draft did not fill the title')
await f.locator('.modal .iconbtn[aria-label]').first().click() // close without saving
await f.locator('.modal').waitFor({ state: 'detached' })

step('decide')
await f.locator('.ocard .decidebtn').first().click()
await f.locator('.modal .opt').first().waitFor()
// Cost split: drop one member from the split.
await f.locator('.modal .split button').nth(1).click()
if ((await f.locator('.modal .split button[aria-pressed="false"]').count()) !== 1) throw new Error('split toggle failed')
await f.locator('.modal .actions .trek-btn--primary').click()
await f.locator('.banner.ok').waitFor()
const banner = await f.locator('.banner.ok').textContent()
if (!/Casa de la Memoria/.test(banner)) throw new Error('decided banner missing: ' + banner)
await f.locator('.banner.ok button', { hasText: /bookings|Buchungen/ }).waitFor()

step('reopen (confirm + delete booking)')
await f.locator('.banner.ok button', { hasText: /Reopen|Wieder öffnen/ }).click()
await f.locator('.ocard .vote.up').first().waitFor()
await page.waitForTimeout(500)
if (await f.locator('.banner.ok').count()) throw new Error('still decided after reopen')

await browser.close()
if (errors.length) { console.log('✗ errors:', errors); process.exit(1) }
console.log('✓ e2e flow passed')
