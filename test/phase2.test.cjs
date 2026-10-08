const test = require('node:test')
const assert = require('node:assert/strict')
const { PermissionDenied } = require('trek-plugin-sdk/testing')
const { setup, tripFixtures, manifest } = require('./helpers.cjs')
const store = require('../server/lib/store')

test.beforeEach(() => store._resetRateCache())

async function decision(app, category = 'unterkunft', extra = {}) {
  const d = await app.post('/decisions/create', { tripId: 1, title: 'Unterkunft Sevilla', category, ...extra })
  return d.body.id
}
async function option(app, decisionId, extra = {}) {
  const o = await app.post('/options/create', { tripId: 1, decisionId, title: 'Option', ...extra })
  assert.equal(o.status, 200, JSON.stringify(o.body))
  return o.body.id
}

// ---------------------------------------------------------------------------
// Cost split
// ---------------------------------------------------------------------------

test('decide splits the cost equally across all members by default, or the chosen ones', async () => {
  const app = await setup()
  const d1 = await decision(app, 'aktivitaet')
  const o1 = await option(app, d1, { price_total: 120 })
  await app.post('/decide', { tripId: 1, decisionId: d1, optionId: o1, cost: true })
  assert.deepEqual(app.trips[1].costs[0].member_ids.sort(), [1, 2, 3, 4])

  const d2 = await decision(app, 'aktivitaet')
  const o2 = await option(app, d2, { price_total: 90 })
  // 9 is not on the trip and is dropped.
  const r = await app.post('/decide', { tripId: 1, decisionId: d2, optionId: o2, cost: true, splitMemberIds: [2, 3, 9] })
  assert.equal(r.body.results.cost.split, 2)
  assert.deepEqual(app.trips[1].costs[1].member_ids, [2, 3])

  const d3 = await decision(app, 'aktivitaet')
  const o3 = await option(app, d3, { price_total: 10 })
  await app.post('/decide', { tripId: 1, decisionId: d3, optionId: o3, cost: true, splitMemberIds: [] })
  assert.equal(app.trips[1].costs[2].member_ids, undefined) // planning-only
})

// ---------------------------------------------------------------------------
// Collab poll
// ---------------------------------------------------------------------------

test('post as collab poll: options in rank order, multiple choice, poll id stored', async () => {
  const app = await setup()
  const d = await decision(app, 'unterkunft', { deadline: new Date(Date.now() + 86400000).toISOString() })
  const a = await option(app, d, { title: 'A' })
  const b = await option(app, d, { title: 'B' })
  await app.post('/votes/set', { tripId: 1, optionId: b, value: 'up', active: true })
  const res = await app.post('/poll/post', { tripId: 1, decisionId: d })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.poll.options, 2)
  const call = app.host.calls.filter((c) => c.method === 'collab.createPoll')
  assert.equal(call.length, 1)
  const st = res.body.state
  assert.equal(st.collab_available, true)
  const dec = st.decisions.find((x) => x.id === d)
  assert.ok(dec.linked_poll_id > 0)
  assert.equal(dec.poll_option_ids, undefined) // internal mapping stays server-side
  // Mapping is rank order: B (1 vote) before A.
  const row = app.db.raw.prepare('SELECT poll_option_ids FROM decisions WHERE id = ?').get(d)
  assert.deepEqual(JSON.parse(row.poll_option_ids), [b, a])
})

test('collab addon off: feature reported unavailable, posting is refused cleanly', async () => {
  const app = await setup({ collabAddonEnabled: false })
  const d = await decision(app)
  await option(app, d, { title: 'A' })
  await option(app, d, { title: 'B' })
  const res = await app.post('/poll/post', { tripId: 1, decisionId: d })
  assert.equal(res.status, 200)
  assert.equal(res.body.poll.ok, false)
  assert.equal(res.body.poll.reason, 'addon_disabled')
  assert.equal(res.body.state.collab_available, false)
})

test('a poll needs two options; missing collab_edit is reported', async () => {
  const trips = tripFixtures({ can: { collab_edit: false } })
  const app = await setup({ trips })
  const d = await decision(app)
  await option(app, d, { title: 'A' })
  assert.equal((await app.post('/poll/post', { tripId: 1, decisionId: d })).status, 409)
  await option(app, d, { title: 'B' })
  const res = await app.post('/poll/post', { tripId: 1, decisionId: d })
  assert.equal(res.body.poll.reason, 'no_permission')
})

test('import poll votes: adds upvotes, keeps vetoes, ignores strangers', async () => {
  const app = await setup()
  const d = await decision(app)
  const a = await option(app, d, { title: 'A' })
  const b = await option(app, d, { title: 'B' })
  await app.post('/poll/post', { tripId: 1, decisionId: d })
  const pollId = app.db.raw.prepare('SELECT linked_poll_id AS p FROM decisions WHERE id = ?').get(d).p
  const order = JSON.parse(app.db.raw.prepare('SELECT poll_option_ids AS o FROM decisions WHERE id = ?').get(d).o)
  // Mia vetoed B in the plugin; in the poll she, Jonas and a stranger (99) voted.
  await app.as(2).post('/votes/set', { tripId: 1, optionId: b, value: 'veto', active: true })
  const voters = (ids) => ids.map((id) => ({ user_id: id, username: 'u' + id }))
  const byId = { [a]: voters([2, 3, 99]), [b]: voters([2, 4]) }
  app.trips[1].polls = [{ id: pollId, question: 'x', options: order.map((id) => ({ text: String(id), voters: byId[id] })) }]
  const res = await app.post('/poll/import', { tripId: 1, decisionId: d })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  assert.equal(res.body.imported.added, 3) // A: 2,3  B: 4  (B/2 vetoed, 99 stranger)
  const dec = res.body.state.decisions.find((x) => x.id === d)
  assert.deepEqual(dec.options.find((o) => o.id === a).up.sort(), [2, 3])
  assert.deepEqual(dec.options.find((o) => o.id === b).up, [4])
  assert.deepEqual(dec.options.find((o) => o.id === b).veto, [2])
  assert.equal(dec.poll.exists, true)
  assert.equal(dec.poll.voters, 4)
  // Running it again adds nothing.
  assert.equal((await app.post('/poll/import', { tripId: 1, decisionId: d })).body.imported.added, 0)
  // A deleted poll unlinks itself.
  app.trips[1].polls = []
  assert.equal((await app.post('/poll/import', { tripId: 1, decisionId: d })).status, 404)
  assert.equal(app.db.raw.prepare('SELECT linked_poll_id AS p FROM decisions WHERE id = ?').get(d).p, null)
})

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

test('foreign currencies are converted into the trip currency and used for the tie-break', async () => {
  const app = await setup({ ratesResult: { USD: 1.1, GBP: 0.8 } })
  const d = await decision(app)
  const usd = await option(app, d, { title: 'USD', price_total: 110, currency: 'USD' }) // = 100 EUR
  const eur = await option(app, d, { title: 'EUR', price_total: 105 })
  const gbp = await option(app, d, { title: 'GBP', price_total: 76, currency: 'GBP' }) // = 95 EUR
  const st = (await app.get('/state', { tripId: 1 })).body.state
  const opts = st.decisions[0].options
  assert.equal(st.rates_available, true)
  assert.equal(opts.find((o) => o.id === usd).price_trip, 100)
  assert.equal(opts.find((o) => o.id === eur).price_trip, 105)
  assert.equal(opts.find((o) => o.id === gbp).price_trip, 95)
  assert.deepEqual(opts.map((o) => o.title), ['GBP', 'USD', 'EUR'])
})

test('without rates the foreign price stays unconverted', async () => {
  const app = await setup()
  const d = await decision(app)
  await option(app, d, { title: 'USD', price_total: 110, currency: 'USD' })
  const st = (await app.get('/state', { tripId: 1 })).body.state
  assert.equal(st.rates_available, false)
  assert.equal(st.decisions[0].options[0].price_trip, null)
})

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

test('map markers: options of open decisions with coordinates; foreign trip gets nothing', async () => {
  const app = await setup()
  const d = await decision(app)
  const a = await option(app, d, { title: 'Casa Azul', lat: 37.4, lng: -5.99, price_total: 920, url: 'https://example.com/a' })
  const b = await option(app, d, { title: 'Finca', lat: 37.47, lng: -5.64 })
  await option(app, d, { title: 'Ohne Koordinaten' })
  await app.post('/votes/set', { tripId: 1, optionId: a, value: 'up', active: true })
  await app.as(2).post('/votes/set', { tripId: 1, optionId: b, value: 'veto', active: true })
  await app.get('/state', { tripId: 1, locale: 'en' })
  const markers = await app.drv.hook('mapMarkerProvider', 'getMarkers', 1)
  assert.equal(markers.length, 2)
  const m = markers.find((x) => x.id === `option-${a}`)
  assert.deepEqual({ lat: m.lat, lng: m.lng, label: m.label, icon: m.icon, tone: m.tone, url: m.url },
    { lat: 37.4, lng: -5.99, label: 'Casa Azul', icon: 'BedDouble', tone: 'success', url: 'https://example.com/a' })
  assert.match(m.popupText, /Unterkunft Sevilla · €920 · 1 vote$/)
  assert.equal(markers.find((x) => x.id === `option-${b}`).tone, 'danger')

  assert.deepEqual(await app.drv.hook('mapMarkerProvider', 'getMarkers', 2), [])

  // Decided decisions leave the map.
  await app.post('/decide', { tripId: 1, decisionId: d, optionId: a })
  assert.deepEqual(await app.drv.hook('mapMarkerProvider', 'getMarkers', 1), [])
})

test('warning banner: open decisions closing within three days, and ended ones', async () => {
  const app = await setup()
  const h = (n) => new Date(Date.now() + n * 3600000).toISOString()
  await decision(app, 'flug', { title: 'Hinflug', deadline: h(30) })
  await decision(app, 'mietwagen', { title: 'Mietwagen', deadline: h(24 * 6) })
  await decision(app, 'zug', { title: 'Zug', deadline: h(-2) })
  await decision(app, 'sonstiges', { title: 'Ohne Deadline' })
  const w = await app.drv.hook('warningProvider', 'getWarnings', 1)
  assert.equal(w.length, 2)
  assert.equal(w[0].level, 'info')
  assert.match(w[0].message, /Abstimmung „Zug“ ist beendet/)
  assert.equal(w[1].level, 'warning')
  assert.match(w[1].message, /Entscheidung „Hinflug“ endet (morgen|übermorgen|in \d Tagen)/)
  assert.deepEqual(await app.drv.hook('warningProvider', 'getWarnings', 2), [])
})

test('trip card badge counts open decisions per trip', async () => {
  const app = await setup()
  await decision(app, 'flug', { title: 'A', deadline: new Date(Date.now() + 3600000).toISOString() })
  await decision(app, 'zug', { title: 'B' })
  const third = await decision(app, 'zug', { title: 'C' })
  await app.post('/decisions/status', { tripId: 1, decisionId: third, status: 'verworfen' })
  const cards = await app.drv.hook('tripCardProvider', 'getCards', [1, 2])
  assert.deepEqual(cards, [{ tripId: 1, id: 'open-decisions', label: 'Offene Entscheidungen', value: '2', icon: 'Scale', tone: 'warn' }])
})

test('hooks are only fired with their grant (TREK skips ungranted hooks silently)', async () => {
  const grants = manifest.permissions.filter((p) => !p.startsWith('hook:'))
  const app = await setup({ grants })
  await assert.rejects(app.drv.hook('mapMarkerProvider', 'getMarkers', 1), PermissionDenied)
  await assert.rejects(app.drv.hook('warningProvider', 'getWarnings', 1), PermissionDenied)
  await assert.rejects(app.drv.hook('tripCardProvider', 'getCards', [1]), PermissionDenied)
})

test('migrations can run again on a database that already has them (dev keeps no ledger)', async () => {
  const { realDb } = require('./helpers.cjs')
  const { migrate } = require('../server/lib/schema')
  const db = realDb()
  const forgetful = { ...db, migrate: (id, sql) => db.exec(sql) } // like `trek-plugin dev` after a restart
  await migrate(forgetful)
  await migrate(forgetful)
  const cols = db.raw.prepare("SELECT name FROM pragma_table_info('trip_settings')").all().map((r) => r.name)
  assert.ok(cols.includes('locale'))
})
