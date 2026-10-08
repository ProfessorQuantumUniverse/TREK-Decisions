const test = require('node:test')
const assert = require('node:assert/strict')
const { PermissionDenied } = require('trek-plugin-sdk/testing')
const { setup, manifest } = require('./helpers.cjs')
const routes = require('../server/lib/routes')
const { TOOLS, ASSISTANT } = require('../server/lib/mcp')

test.beforeEach(() => routes._resetAiCache())

async function decision(app, category = 'unterkunft') {
  return (await app.post('/decisions/create', { tripId: 1, title: 'Unterkunft Sevilla', category })).body.id
}

// ---------------------------------------------------------------------------
// AI import
// ---------------------------------------------------------------------------

test('AI import returns a validated draft and never stores anything', async () => {
  const app = await setup({
    aiResults: [{
      title: 'Casa Azul', url: 'https://www.airbnb.de/rooms/1', price_total: '920.5', currency: 'eur',
      checkin_date: '2027-04-10', checkin_time: '15:00', checkout_date: '2027-04-31', beds: 4.5,
      address: 'Calle Feria 32', notes: 'Dachterrasse', bogus: 'dropped',
    }],
  })
  const d = await decision(app)
  const st = (await app.get('/state', { tripId: 1 })).body.state
  assert.equal(st.ai_available, true)
  const res = await app.post('/ai/extract', { tripId: 1, decisionId: d, text: 'Schönes Apartment in Sevilla …' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.draft, {
    title: 'Casa Azul', url: 'https://www.airbnb.de/rooms/1', price_total: 920.5, currency: 'EUR', notes: 'Dachterrasse',
    // the invalid checkout date and the fractional bed count are dropped, not guessed
    details: { checkin_date: '2027-04-10', checkin_time: '15:00', address: 'Calle Feria 32' },
  })
  assert.equal(res.body.state.decisions[0].options.length, 0)
  assert.equal(app.db.raw.prepare('SELECT COUNT(*) AS n FROM options').get().n, 0)
  // An unsafe link from the model is dropped like user input would be.
  const app2 = await setup({ aiResults: [{ title: 'X', url: 'javascript:alert(1)' }] })
  const d2 = await decision(app2)
  assert.deepEqual((await app2.post('/ai/extract', { tripId: 1, decisionId: d2, text: 'x' })).body.draft, { title: 'X', details: {} })
})

test('AI import: empty text is a 400, foreign trip a 403, no provider is reported', async () => {
  const app = await setup()
  const d = await decision(app)
  assert.equal((await app.post('/ai/extract', { tripId: 1, decisionId: d, text: '   ' })).status, 400)
  assert.equal((await app.post('/ai/extract', { tripId: 2, decisionId: d, text: 'x' })).status, 403)
  routes._resetAiCache() // a fresh plugin process for the second host
  const off = await setup({ aiPerDay: 0 }) // broker disabled
  const d2 = await decision(off)
  assert.equal((await off.get('/state', { tripId: 1 })).body.state.ai_available, false)
  const r = await off.post('/ai/extract', { tripId: 1, decisionId: d2, text: 'x' })
  assert.equal(r.body.draft, null)
  assert.equal(r.body.error.reason, 'limit')
})

test('AI import needs the ai:invoke grant', async () => {
  const app = await setup({ grants: manifest.permissions.filter((p) => p !== 'ai:invoke') })
  const d = await decision(app)
  assert.equal((await app.get('/state', { tripId: 1 })).body.state.ai_available, false)
  assert.equal((await app.post('/ai/extract', { tripId: 1, decisionId: d, text: 'x' })).body.error.reason, 'plugin_permission')
})

// ---------------------------------------------------------------------------
// MCP tools
// ---------------------------------------------------------------------------

test('MCP: declared tools and implemented tools are identical', () => {
  assert.deepEqual(manifest.capabilities.mcpTools.map((t) => t.name).sort(), [...TOOLS].sort())
  assert.ok(manifest.permissions.includes('mcp:tools'))
})

test('MCP: create a decision, add an option, list the state', async () => {
  const app = await setup()
  const call = (name, args) => app.drv.hook('mcpToolProvider', 'callTool', { name, args })
  const created = await call('create_decision', { tripId: 1, title: 'Mietwagen Andalusien', category: 'mietwagen' })
  assert.ok(created.created_decision_id > 0)
  const added = await call('add_option', {
    tripId: 1, decisionId: created.created_decision_id, title: 'Sixt Kombi', price_total: 310, details: { pickup_place: 'SVQ', car_class: 'Kombi' },
  })
  assert.equal(added.decisions[0].options[0].title, 'Sixt Kombi')
  assert.equal(added.decisions[0].options[0].currency, 'EUR')
  const row = app.db.raw.prepare('SELECT created_by, details_json FROM options').get()
  assert.equal(row.created_by, ASSISTANT)
  assert.deepEqual(JSON.parse(row.details_json), { pickup_place: 'SVQ', car_class: 'Kombi' })

  await app.post('/votes/set', { tripId: 1, optionId: added.created_option_id, value: 'up', active: true })
  const list = await call('list_decisions', { tripId: 1, status: 'offen' })
  assert.equal(list.trip, 'Andalusien')
  assert.equal(list.decisions.length, 1)
  assert.deepEqual(list.decisions[0].options[0].upvoted_by, ['Lorenzo'])
  // Changes made through a tool reach open trip pages live, like any route.
  assert.ok(app.host.broadcasts.length >= 2)
})

test('MCP: the same guards apply — foreign trip, foreign ids, bad input', async () => {
  const app = await setup()
  const call = (name, args) => app.drv.hook('mcpToolProvider', 'callTool', { name, args })
  await assert.rejects(call('list_decisions', { tripId: 2 }), /no access to this trip/)
  await assert.rejects(call('create_decision', { tripId: 1, title: 'x', category: 'yacht' }), /invalid input/)
  await assert.rejects(call('add_option', { tripId: 1, decisionId: 999, title: 'x' }), /not found/)
  await assert.rejects(call('add_option', { tripId: 1, decisionId: 1, title: 'x', url: 'javascript:1' }), /not found|invalid/)
  await assert.rejects(call('nope', {}), /unknown tool/)
  const ungranted = await setup({ grants: manifest.permissions.filter((p) => p !== 'mcp:tools') })
  await assert.rejects(ungranted.drv.hook('mcpToolProvider', 'callTool', { name: 'list_decisions', args: { tripId: 1 } }), PermissionDenied)
})

// ---------------------------------------------------------------------------
// GDPR
// ---------------------------------------------------------------------------

test('GDPR: export lists a user\'s data, erasure removes it idempotently and keeps group content', async () => {
  const app = await setup()
  const d = await decision(app)
  const mia = app.as(2)
  const o = (await mia.post('/options/create', { tripId: 1, decisionId: d, title: 'Casa Azul', price_total: 920 })).body.id
  await mia.post('/votes/set', { tripId: 1, optionId: o, value: 'up', active: true })
  await mia.post('/proscons/create', { tripId: 1, optionId: o, kind: 'pro', text: 'Dachterrasse' })
  await app.post('/votes/set', { tripId: 1, optionId: o, value: 'up', active: true })

  const dump = JSON.parse(JSON.stringify(await app.drv.exportUserData(2)))
  assert.deepEqual(dump.votes, [{ value: 'up', option: 'Casa Azul', decision: 'Unterkunft Sevilla', trip_id: 1 }])
  assert.equal(dump.pros_cons[0].text, 'Dachterrasse')
  assert.equal(dump.options_created[0].title, 'Casa Azul')

  await app.drv.deleteUserData(2)
  await app.drv.deleteUserData(2) // delivered again → no error, nothing changes
  const st = (await app.get('/state', { tripId: 1 })).body.state
  const opt = st.decisions[0].options[0]
  assert.equal(opt.title, 'Casa Azul')        // group content stays
  assert.equal(opt.created_by, 0)              // … without the person
  assert.deepEqual(opt.up, [1])                // only Mia's vote is gone
  assert.equal(opt.pros.length, 0)
  assert.deepEqual(JSON.parse(JSON.stringify(await app.drv.exportUserData(2))), { votes: [], pros_cons: [], options_created: [], decisions_created_or_decided: [] })
})

test('GDPR handlers need hook:user-data', async () => {
  const app = await setup({ grants: manifest.permissions.filter((p) => p !== 'hook:user-data') })
  await assert.rejects(app.drv.deleteUserData(2), PermissionDenied)
})
