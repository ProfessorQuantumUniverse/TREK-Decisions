// Authorization, vote integrity, concurrency and input limits (0.4.1 review).
const test = require('node:test')
const assert = require('node:assert/strict')
const { setup } = require('./helpers.cjs')
const { LIMITS } = require('../server/lib/validate')

async function decision(app, extra = {}) {
  const r = await app.post('/decisions/create', { tripId: 1, title: 'Unterkunft', category: 'unterkunft', ...extra })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.id
}

async function option(app, decisionId, extra = {}) {
  const r = await app.post('/options/create', { tripId: 1, decisionId, title: 'Casa Azul', price_total: 800, ...extra })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.id
}

const decisionOf = (state, id) => state.decisions.find((d) => d.id === id)
const optionOf = (state, dId, oId) => decisionOf(state, dId).options.find((o) => o.id === oId)

// ---------------------------------------------------------------------------
// Membership and vote integrity
// ---------------------------------------------------------------------------

test('a member removed from the trip loses access and their votes stop counting', async () => {
  const app = await setup()
  const d = await decision(app)
  const a = await option(app, d, { title: 'A', lat: 37.4, lng: -5.99 })
  const b = await option(app, d, { title: 'B', price_total: 900 })
  const jonas = app.as(3)
  const sara = app.as(4)
  await jonas.post('/votes/set', { tripId: 1, optionId: a, value: 'up', active: true })
  await sara.post('/votes/set', { tripId: 1, optionId: a, value: 'up', active: true })
  await app.post('/votes/set', { tripId: 1, optionId: b, value: 'up', active: true })
  let st = (await app.get('/state', { tripId: 1 })).body.state
  assert.equal(decisionOf(st, d).leader_option_id, a)

  // Jonas and Sara leave the trip.
  app.trips[1].members = [1, 2]
  assert.equal((await jonas.get('/state', { tripId: 1 })).status, 403)
  assert.equal((await jonas.post('/votes/set', { tripId: 1, optionId: b, value: 'veto', active: true })).status, 403)
  assert.equal((await sara.post('/proscons/create', { tripId: 1, optionId: a, kind: 'con', text: 'x' })).status, 403)

  st = (await app.get('/state', { tripId: 1 })).body.state
  assert.deepEqual(optionOf(st, d, a).up, [])
  assert.deepEqual(optionOf(st, d, b).up, [1])
  assert.equal(decisionOf(st, d).leader_option_id, b)
  // The map marker reads the same tally.
  const [marker] = await app.drv.hook('mapMarkerProvider', 'getMarkers', 1)
  assert.match(marker.popupText, /0 Stimmen/)

  // Rejoining brings the stored votes back.
  app.trips[1].members = [1, 2, 3, 4]
  st = (await app.get('/state', { tripId: 1 })).body.state
  assert.deepEqual(optionOf(st, d, a).up.sort(), [3, 4])
})

test('a vote is always cast as the acting user, whatever the body says', async () => {
  const app = await setup()
  const d = await decision(app)
  const o = await option(app, d)
  const res = await app.post('/votes/set', { tripId: 1, optionId: o, value: 'veto', active: true, userId: 2, user_id: 2 })
  assert.equal(res.status, 200)
  assert.deepEqual(optionOf(res.body.state, d, o).veto, [1])
  // One row per member, option and kind — repeating it changes nothing.
  await app.post('/votes/set', { tripId: 1, optionId: o, value: 'veto', active: true })
  assert.equal(app.db.raw.prepare('SELECT COUNT(*) AS n FROM votes').get().n, 1)
})

test('an option id from another decision of the same trip is refused by /decide', async () => {
  const app = await setup()
  const d1 = await decision(app, { title: 'Stay' })
  const d2 = await decision(app, { title: 'Flight', category: 'flug' })
  const o2 = await option(app, d2, { title: 'LH 1' })
  const res = await app.post('/decide', { tripId: 1, decisionId: d1, optionId: o2, booking: true })
  assert.equal(res.status, 404)
  assert.equal(app.trips[1].reservations, undefined)
})

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

test('concurrent /decide requests create one booking, one cost and one notification', async () => {
  const app = await setup()
  const d = await decision(app)
  const o = await option(app, d, { details: { checkin_date: '2027-04-10', checkout_date: '2027-04-12' } })
  const mia = app.as(2)
  const req = { tripId: 1, decisionId: d, optionId: o, booking: true, cost: true, notify: true, locale: 'de' }
  const [r1, r2] = await Promise.all([app.post('/decide', req), mia.post('/decide', req)])
  assert.equal(r1.status, 200, JSON.stringify(r1.body))
  assert.equal(r2.status, 200, JSON.stringify(r2.body))
  assert.equal(app.trips[1].reservations.length, 1)
  assert.equal(app.trips[1].costs.length, 1)
  assert.equal(app.host.notifications.length + mia.host.notifications.length, 1)
  const st = (await app.get('/state', { tripId: 1 })).body.state
  assert.equal(decisionOf(st, d).decided_by, 1)
  assert.equal(decisionOf(st, d).linked_reservation_id, app.trips[1].reservations[0].id)
})

test('two members deciding for different options at once: the second gets a 409', async () => {
  const app = await setup()
  const d = await decision(app)
  const a = await option(app, d, { title: 'A' })
  const b = await option(app, d, { title: 'B' })
  const [r1, r2] = await Promise.all([
    app.post('/decide', { tripId: 1, decisionId: d, optionId: a, booking: true }),
    app.as(2).post('/decide', { tripId: 1, decisionId: d, optionId: b, booking: true }),
  ])
  assert.deepEqual([r1.status, r2.status], [200, 409])
  assert.equal(app.trips[1].reservations.length, 1)
  assert.equal(app.trips[1].reservations[0].title, 'A')
})

// ---------------------------------------------------------------------------
// Decision integrity
// ---------------------------------------------------------------------------

test('the category is locked once a decision has options', async () => {
  const app = await setup()
  const d = await decision(app)
  // No options yet: free to change.
  assert.equal((await app.post('/decisions/update', { tripId: 1, decisionId: d, category: 'flug' })).status, 200)
  await option(app, d, { details: { dep_airport: 'FRA' } })
  const res = await app.post('/decisions/update', { tripId: 1, decisionId: d, category: 'unterkunft' })
  assert.equal(res.status, 409)
  assert.equal(res.body.error, 'category_locked')
  // Sending the unchanged category (or none) is fine.
  assert.equal((await app.post('/decisions/update', { tripId: 1, decisionId: d, category: 'flug', title: 'Hinflug' })).status, 200)
})

// ---------------------------------------------------------------------------
// Input validation and limits
// ---------------------------------------------------------------------------

test('URLs with embedded credentials are refused', async () => {
  const app = await setup()
  const d = await decision(app)
  for (const url of ['https://www.booking.com@evil.example/', 'https://user:pw@example.com/']) {
    assert.equal((await app.post('/options/create', { tripId: 1, decisionId: d, title: 'x', url })).status, 400, url)
  }
})

test('bidi override characters are stripped from text', async () => {
  const app = await setup()
  const rlo = String.fromCharCode(0x202e)
  const d = await decision(app, { title: `Casa ${rlo}gpj.exe` })
  const st = (await app.get('/state', { tripId: 1 })).body.state
  assert.equal(decisionOf(st, d).title, 'Casa gpj.exe')
})

test('deadlines: ISO 8601 only, a missing offset reads as UTC', async () => {
  const app = await setup()
  for (const deadline of ['March 1 2027', '1.3.2027', '2027-03-01T18', 'x'.repeat(41)]) {
    assert.equal((await app.post('/decisions/create', { tripId: 1, title: 'x', category: 'flug', deadline })).status, 400, deadline)
  }
  const cases = [
    ['2027-03-01T18:00', '2027-03-01T18:00:00.000Z'],
    ['2027-03-01T18:00:00+02:00', '2027-03-01T16:00:00.000Z'],
    ['2027-03-01', '2027-03-01T00:00:00.000Z'],
    ['2027-03-01T18:00:00.000Z', '2027-03-01T18:00:00.000Z'],
  ]
  for (const [deadline, stored] of cases) {
    const r = await app.post('/decisions/create', { tripId: 1, title: 'x', category: 'flug', deadline })
    assert.equal(r.status, 200, deadline)
    assert.equal(decisionOf(r.body.state, r.body.id).deadline, stored, deadline)
  }
})

test('per-trip limits on decisions, options and pros/cons', async () => {
  const app = await setup()
  const d = await decision(app)
  // Fill straight through the database; the routes only count.
  const raw = app.db.raw
  const insOpt = raw.prepare(
    "INSERT INTO options (decision_id, trip_id, title, created_by, created_at) VALUES (?, 1, 'o', 1, '2027-01-01')",
  )
  for (let i = 0; i < LIMITS.optionsPerDecision - 1; i++) insOpt.run(d)
  const last = await option(app, d)
  const over = await app.post('/options/create', { tripId: 1, decisionId: d, title: 'one too many' })
  assert.equal(over.status, 409)
  assert.equal(over.body.error, 'limit_reached')

  const insPoint = raw.prepare("INSERT INTO pros_cons (option_id, kind, text, created_by, created_at) VALUES (?, 'pro', 'p', 1, '2027-01-01')")
  for (let i = 0; i < LIMITS.pointsPerOption; i++) insPoint.run(last)
  assert.equal((await app.post('/proscons/create', { tripId: 1, optionId: last, kind: 'con', text: 'x' })).status, 409)

  const insDec = raw.prepare(
    "INSERT INTO decisions (trip_id, title, category, created_by, created_at) VALUES (1, 'd', 'flug', 1, '2027-01-01')",
  )
  for (let i = 1; i < LIMITS.decisionsPerTrip; i++) insDec.run()
  assert.equal((await app.post('/decisions/create', { tripId: 1, title: 'x', category: 'flug' })).status, 409)
  // The limit is per trip, not global.
  const other = await app.as(9).post('/decisions/create', { tripId: 2, title: 'x', category: 'flug' })
  assert.equal(other.status, 200)
})
