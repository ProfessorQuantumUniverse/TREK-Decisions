const test = require('node:test')
const assert = require('node:assert/strict')
const { setup, makeHost, tripFixtures, realDb } = require('./helpers.cjs')

async function seedDecision(app, extra = {}) {
  const r = await app.post('/decisions/create', { tripId: 1, title: 'Unterkunft Sevilla', category: 'unterkunft', ...extra })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.id
}

async function seedOption(app, decisionId, extra = {}) {
  const r = await app.post('/options/create', { tripId: 1, decisionId, title: 'Casa Azul', price_total: 800, ...extra })
  assert.equal(r.status, 200, JSON.stringify(r.body))
  return r.body.id
}

const decisionOf = (state, id) => state.decisions.find((d) => d.id === id)

// ---------------------------------------------------------------------------
// Membership / cross-trip isolation
// ---------------------------------------------------------------------------

test('a foreign tripId is a 403 on reads and writes', async () => {
  const app = await setup()
  assert.equal((await app.get('/state', { tripId: 2 })).status, 403)
  assert.equal((await app.post('/decisions/create', { tripId: 2, title: 'x', category: 'flug' })).status, 403)
  assert.equal((await app.post('/votes/set', { tripId: 2, optionId: 1, value: 'up', active: true })).status, 403)
  assert.equal((await app.post('/decide', { tripId: 2, decisionId: 1, optionId: 1 })).status, 403)
  // A trip that does not exist at all reads the same.
  assert.equal((await app.get('/state', { tripId: 777 })).status, 403)
})

test('a missing or malformed tripId is a 400', async () => {
  const app = await setup()
  assert.equal((await app.get('/state', {})).status, 400)
  assert.equal((await app.get('/state', { tripId: 'abc' })).status, 400)
  assert.equal((await app.post('/decisions/create', { tripId: -1, title: 'x', category: 'flug' })).status, 400)
})

test('ids of another trip cannot be reached through a trip the user can access', async () => {
  // User 9 owns trip 2 and has a decision + option there.
  const db = realDb()
  const stranger = makeHost({ user: 9, db })
  await stranger.drv.load()
  const r = await stranger.post('/decisions/create', { tripId: 2, title: 'Fremde Frage', category: 'flug' })
  assert.equal(r.status, 200)
  const foreignDecision = r.body.id
  const o = await stranger.post('/options/create', { tripId: 2, decisionId: foreignDecision, title: 'LH 1' })
  const foreignOption = o.body.id
  const pc = await stranger.post('/proscons/create', { tripId: 2, optionId: foreignOption, kind: 'pro', text: 'billig' })

  // User 1 is a member of trip 1 only and passes trip 1 with the foreign ids.
  const me = makeHost({ user: 1, db, trips: stranger.trips })
  const tries = [
    ['/decisions/update', { decisionId: foreignDecision, title: 'gekapert' }],
    ['/decisions/delete', { decisionId: foreignDecision }],
    ['/decisions/status', { decisionId: foreignDecision, status: 'verworfen' }],
    ['/options/create', { decisionId: foreignDecision, title: 'eingeschleust' }],
    ['/options/update', { optionId: foreignOption, title: 'gekapert' }],
    ['/options/delete', { optionId: foreignOption }],
    ['/options/archive', { optionId: foreignOption, archived: true }],
    ['/votes/set', { optionId: foreignOption, value: 'veto', active: true }],
    ['/proscons/create', { optionId: foreignOption, kind: 'con', text: 'x' }],
    ['/proscons/delete', { id: pc.body.id }],
    ['/decide', { decisionId: foreignDecision, optionId: foreignOption }],
    ['/reopen', { decisionId: foreignDecision }],
  ]
  for (const [path, body] of tries) {
    const res = await me.post(path, { tripId: 1, ...body })
    assert.equal(res.status, 404, `${path} → ${res.status}`)
  }
  // Nothing changed on trip 2, and trip 1 shows nothing of it.
  const theirs = await stranger.get('/state', { tripId: 2 })
  assert.equal(theirs.body.state.decisions[0].title, 'Fremde Frage')
  assert.equal(theirs.body.state.decisions[0].options[0].veto.length, 0)
  const mine = await me.get('/state', { tripId: 1 })
  assert.equal(mine.body.state.decisions.length, 0)
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

test('input is validated: enums, lengths, http(s)-only URLs, coordinates', async () => {
  const app = await setup()
  assert.equal((await app.post('/decisions/create', { tripId: 1, title: 'x', category: 'yacht' })).status, 400)
  assert.equal((await app.post('/decisions/create', { tripId: 1, title: '', category: 'flug' })).status, 400)
  assert.equal((await app.post('/decisions/create', { tripId: 1, title: 'x'.repeat(121), category: 'flug' })).status, 400)
  assert.equal((await app.post('/decisions/create', { tripId: 1, title: 'x', category: 'flug', deadline: 'morgen' })).status, 400)
  const d = await seedDecision(app)
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'ftp://x.y', 'not a url']) {
    assert.equal((await app.post('/options/create', { tripId: 1, decisionId: d, title: 'x', url })).status, 400, url)
  }
  assert.equal((await app.post('/options/create', { tripId: 1, decisionId: d, title: 'x', lat: 37.4 })).status, 400)
  assert.equal((await app.post('/options/create', { tripId: 1, decisionId: d, title: 'x', price_total: -5 })).status, 400)
  assert.equal((await app.post('/options/create', { tripId: 1, decisionId: d, title: 'x', details: { checkin_date: '2027-02-30' } })).status, 400)
  const ok = await app.post('/options/create', {
    tripId: 1, decisionId: d, title: '  Casa  ', url: 'https://www.airbnb.com/rooms/1', price_total: '799,50',
    details: { checkin_date: '2027-04-10', beds: 4, unknown_key: 'dropped' },
  })
  assert.equal(ok.status, 200)
  const opt = decisionOf(ok.body.state, d).options[0]
  assert.equal(opt.title, 'Casa')
  assert.equal(opt.price_total, 799.5)
  assert.equal(opt.currency, 'EUR') // defaults to the trip currency
  assert.deepEqual(opt.details, { checkin_date: '2027-04-10', beds: 4 })
})

// ---------------------------------------------------------------------------
// Votes, ranking, pros/cons
// ---------------------------------------------------------------------------

test('ranking: upvotes desc, cheaper first on ties, vetoed options last', async () => {
  const app = await setup()
  const d = await seedDecision(app)
  const a = await seedOption(app, d, { title: 'A', price_total: 900 })
  const b = await seedOption(app, d, { title: 'B', price_total: 700 })
  const c = await seedOption(app, d, { title: 'C', price_total: 500 })
  const e = await seedOption(app, d, { title: 'E' }) // no price

  const mia = app.as(2)
  const jonas = app.as(3)
  await app.post('/votes/set', { tripId: 1, optionId: a, value: 'up', active: true })
  await mia.post('/votes/set', { tripId: 1, optionId: a, value: 'up', active: true })
  await app.post('/votes/set', { tripId: 1, optionId: b, value: 'up', active: true })
  await mia.post('/votes/set', { tripId: 1, optionId: b, value: 'up', active: true })
  await jonas.post('/votes/set', { tripId: 1, optionId: c, value: 'up', active: true })
  await jonas.post('/votes/set', { tripId: 1, optionId: c, value: 'up', active: true }) // idempotent
  await jonas.post('/votes/set', { tripId: 1, optionId: e, value: 'up', active: true })
  const res = await jonas.post('/votes/set', { tripId: 1, optionId: b, value: 'veto', active: true })

  const dec = decisionOf(res.body.state, d)
  // A and B both have 2 ups, B is cheaper — but B carries a veto and drops below.
  // C and E have 1 up each, C is priced, E is not.
  assert.deepEqual(dec.options.map((o) => o.title), ['A', 'C', 'E', 'B'])
  assert.deepEqual(dec.options.map((o) => o.rank), [1, 2, 3, 4])
  assert.deepEqual(dec.options.find((o) => o.id === b).veto, [3])
  assert.equal(dec.leader_option_id, a)
  assert.deepEqual(dec.options.find((o) => o.id === a).up.sort(), [1, 2])

  // Up and veto exclude each other per user and option.
  const flip = await jonas.post('/votes/set', { tripId: 1, optionId: b, value: 'up', active: true })
  const bAfter = decisionOf(flip.body.state, d).options.find((o) => o.id === b)
  assert.deepEqual(bAfter.veto, [])
  assert.deepEqual(bAfter.up.sort(), [1, 2, 3])
  // Withdrawing a vote.
  const back = await jonas.post('/votes/set', { tripId: 1, optionId: b, value: 'up', active: false })
  assert.deepEqual(decisionOf(back.body.state, d).options.find((o) => o.id === b).up.sort(), [1, 2])
})

test('votes are refused once the deadline has passed or the decision is closed', async () => {
  const app = await setup()
  const d = await seedDecision(app, { deadline: new Date(Date.now() - 60_000).toISOString() })
  const o = await seedOption(app, d)
  const res = await app.post('/votes/set', { tripId: 1, optionId: o, value: 'up', active: true })
  assert.equal(res.status, 409)
  const st = await app.get('/state', { tripId: 1 })
  assert.equal(decisionOf(st.body.state, d).voting_closed, true)
  assert.equal(decisionOf(st.body.state, d).status, 'offen') // marked, never auto-decided
})

test('pros and cons: everyone adds, only the author deletes', async () => {
  const app = await setup()
  const d = await seedDecision(app)
  const o = await seedOption(app, d)
  const mia = app.as(2)
  const r = await mia.post('/proscons/create', { tripId: 1, optionId: o, kind: 'pro', text: 'Dachterrasse' })
  assert.equal(r.status, 200)
  await app.post('/proscons/create', { tripId: 1, optionId: o, kind: 'con', text: 'weit vom Zentrum' })
  assert.equal((await app.post('/proscons/delete', { tripId: 1, id: r.body.id })).status, 403)
  assert.equal((await app.post('/proscons/create', { tripId: 1, optionId: o, kind: 'maybe', text: 'x' })).status, 400)
  assert.equal((await app.post('/proscons/create', { tripId: 1, optionId: o, kind: 'pro', text: 'x'.repeat(281) })).status, 400)
  const del = await mia.post('/proscons/delete', { tripId: 1, id: r.body.id })
  assert.equal(del.status, 200)
  const opt = decisionOf(del.body.state, d).options[0]
  assert.equal(opt.pros.length, 0)
  assert.equal(opt.cons[0].text, 'weit vom Zentrum')
})

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

test('state carries the roster (owner included), divisor and trip info', async () => {
  const app = await setup()
  const st = (await app.get('/state', { tripId: 1 })).body.state
  assert.deepEqual(st.members.map((m) => m.name).sort(), ['Jonas', 'Lorenzo', 'Mia', 'Sara'])
  assert.equal(st.members.find((m) => m.id === 1).owner, true)
  assert.equal(st.divisor, 4)
  assert.equal(st.divisor_custom, false)
  assert.equal(st.trip.currency, 'EUR')
  const set = await app.post('/settings', { tripId: 1, divisor: 3 })
  assert.equal(set.body.state.divisor, 3)
  assert.equal((await app.post('/settings', { tripId: 1, divisor: 2.5 })).status, 400)
  const reset = await app.post('/settings', { tripId: 1, divisor: null })
  assert.equal(reset.body.state.divisor, 4)
})

test('every write pings the trip; reads do not', async () => {
  const app = await setup()
  await app.get('/state', { tripId: 1 })
  assert.equal(app.host.broadcasts.length, 0)
  await seedDecision(app)
  assert.equal(app.host.broadcasts.length, 1)
  assert.deepEqual(
    { kind: app.host.broadcasts[0].kind, target: app.host.broadcasts[0].target, event: app.host.broadcasts[0].event },
    { kind: 'trip', target: 1, event: 'changed' },
  )
})

test('deleting a decision removes its options, votes and pros/cons', async () => {
  const app = await setup()
  const d = await seedDecision(app)
  const o = await seedOption(app, d)
  await app.post('/votes/set', { tripId: 1, optionId: o, value: 'up', active: true })
  await app.post('/proscons/create', { tripId: 1, optionId: o, kind: 'pro', text: 'x' })
  const r = await app.post('/decisions/delete', { tripId: 1, decisionId: d })
  assert.equal(r.status, 200)
  for (const table of ['decisions', 'options', 'votes', 'pros_cons']) {
    assert.equal(app.db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table)
  }
})
