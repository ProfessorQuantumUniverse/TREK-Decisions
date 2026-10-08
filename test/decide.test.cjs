const test = require('node:test')
const assert = require('node:assert/strict')
const { setup, tripFixtures } = require('./helpers.cjs')

async function decisionWithOption(app, category, option) {
  const d = await app.post('/decisions/create', { tripId: 1, title: 'Frage', category })
  const o = await app.post('/options/create', { tripId: 1, decisionId: d.body.id, ...option })
  assert.equal(o.status, 200, JSON.stringify(o.body))
  return { decisionId: d.body.id, optionId: o.body.id }
}

const ALL = { booking: true, cost: true, archiveOthers: true, notify: true, locale: 'de' }

test('stay: place + hotel booking with accommodation block on the trip days + linked cost', async () => {
  const app = await setup()
  const { decisionId, optionId } = await decisionWithOption(app, 'unterkunft', {
    title: 'Casa Azul', url: 'https://www.airbnb.com/rooms/42', price_total: 840, currency: 'EUR', lat: 37.39, lng: -5.99,
    details: { checkin_date: '2027-04-10', checkin_time: '15:00', checkout_date: '2027-04-13', checkout_time: '11:00', address: 'Calle Feria 1, Sevilla', beds: 4 },
  })
  const other = await app.post('/options/create', { tripId: 1, decisionId, title: 'Hotel B' })

  const res = await app.post('/decide', { tripId: 1, decisionId, optionId, ...ALL })
  assert.equal(res.status, 200, JSON.stringify(res.body))
  const { results, state } = res.body
  assert.equal(results.booking.ok, true)
  assert.equal(results.booking.type, 'hotel')
  assert.equal(results.booking.tab, 'buchungen')
  assert.equal(results.booking.accommodation, true)
  assert.equal(results.cost.ok, true)
  assert.deepEqual(results.archived, { ok: true, count: 1 })
  assert.equal(results.notified.ok, true)

  const trip = app.trips[1]
  assert.equal(trip.places.length, 1)
  assert.deepEqual(
    { name: trip.places[0].name, lat: trip.places[0].lat, address: trip.places[0].address },
    { name: 'Casa Azul', lat: 37.39, address: 'Calle Feria 1, Sevilla' },
  )
  const r = trip.reservations[0]
  assert.equal(r.type, 'hotel')
  assert.equal(r.title, 'Casa Azul')
  assert.equal(r.url, 'https://www.airbnb.com/rooms/42')
  assert.equal(r.place_id, trip.places[0].id)
  assert.equal(r.day_id, 100)
  assert.equal(r.end_day_id, 103)
  assert.deepEqual(r.create_accommodation, { start_day_id: 100, end_day_id: 103, check_in: '15:00', check_out: '11:00', place_id: trip.places[0].id })
  assert.match(r.notes, /Preis: 840\s€/)
  assert.match(r.notes, /Schlafplätze: 4/)

  const cost = trip.costs[0]
  assert.deepEqual(
    { name: cost.name, category: cost.category, total_price: cost.total_price, currency: cost.currency, reservation_id: cost.reservation_id },
    { name: 'Casa Azul', category: 'accommodation', total_price: 840, currency: 'EUR', reservation_id: r.id },
  )

  assert.equal(app.host.notifications.length, 1)
  assert.equal(app.host.notifications[0].scope, 'trip')
  assert.equal(app.host.notifications[0].targetId, 1)
  assert.match(app.host.notifications[0].title, /Entschieden: Frage/)

  const d = state.decisions.find((x) => x.id === decisionId)
  assert.equal(d.status, 'entschieden')
  assert.equal(d.winner_option_id, optionId)
  assert.equal(d.decided_by, 1)
  assert.equal(d.linked_reservation_id, r.id)
  assert.equal(d.linked_cost_id, cost.id)
  assert.equal(d.options.find((o) => o.id === other.body.id).archived, 2)
})

test('stay outside the trip days falls back to a plain hotel booking', async () => {
  const app = await setup()
  const { decisionId, optionId } = await decisionWithOption(app, 'unterkunft', {
    title: 'Pension', details: { checkin_date: '2027-05-01', checkout_date: '2027-05-03' },
  })
  const res = await app.post('/decide', { tripId: 1, decisionId, optionId, booking: true })
  assert.equal(res.body.results.booking.ok, true)
  assert.equal(res.body.results.booking.accommodation, false)
  assert.deepEqual(res.body.results.booking.warnings, ['dates_outside_trip'])
  const r = app.trips[1].reservations[0]
  assert.equal(r.create_accommodation, undefined)
  assert.equal(r.type, 'hotel')
  assert.equal(app.trips[1].places, undefined) // no address/coords → no place
})

test('flight: endpoints from the bundled airport table, metadata, transports tab', async () => {
  const app = await setup()
  const { decisionId, optionId } = await decisionWithOption(app, 'flug', {
    title: 'Hinflug LH', price_total: 412.5, currency: 'EUR',
    details: { dep_airport: 'fra', arr_airport: 'SVQ', dep_date: '2027-04-10', dep_time: '07:05', arr_time: '09:55', airline: 'Lufthansa', flight_number: 'LH 1132', stops: 0, baggage: '1 × 23 kg' },
  })
  const res = await app.post('/decide', { tripId: 1, decisionId, optionId, booking: true, cost: true })
  assert.equal(res.body.results.booking.tab, 'transports')
  const r = app.trips[1].reservations[0]
  assert.equal(r.type, 'flight')
  assert.equal(r.reservation_time, '2027-04-10T07:05')
  assert.equal(r.reservation_end_time, '2027-04-10T09:55')
  assert.deepEqual(r.metadata, { airline: 'Lufthansa', flight_number: 'LH 1132', departure_airport: 'FRA', arrival_airport: 'SVQ' })
  assert.equal(r.endpoints.length, 2)
  assert.deepEqual(
    r.endpoints.map((e) => [e.role, e.code, e.timezone, e.local_date, e.local_time]),
    [['from', 'FRA', 'Europe/Berlin', '2027-04-10', '07:05'], ['to', 'SVQ', 'Europe/Madrid', '2027-04-10', '09:55']],
  )
  assert.ok(Math.abs(r.endpoints[1].lat - 37.418) < 0.01)
  assert.equal(app.trips[1].costs[0].category, 'flights')
})

test('unknown airport: booking still created, without endpoints, with a warning', async () => {
  const app = await setup()
  const { decisionId, optionId } = await decisionWithOption(app, 'flug', {
    title: 'Mystery', details: { dep_airport: 'FRA', arr_airport: 'QQQ', dep_date: '2027-04-10' },
  })
  const res = await app.post('/decide', { tripId: 1, decisionId, optionId, booking: true })
  assert.deepEqual(res.body.results.booking.warnings, ['airport_unknown'])
  assert.equal(app.trips[1].reservations[0].endpoints, undefined)
})

test('rental car and activity map onto car / activity bookings', async () => {
  const app = await setup()
  const car = await decisionWithOption(app, 'mietwagen', {
    title: 'Sixt Kombi', details: { pickup_place: 'SVQ Airport', pickup_date: '2027-04-10', pickup_time: '10:00', return_place: 'Málaga', return_date: '2027-04-14', car_class: 'Kombi' },
  })
  await app.post('/decide', { tripId: 1, ...car, booking: true, locale: 'en' })
  const act = await decisionWithOption(app, 'aktivitaet', { title: 'Alcázar', details: { date: '2027-04-11', time: '09:30', place: 'Real Alcázar' } })
  await app.post('/decide', { tripId: 1, ...act, booking: true, locale: 'en' })
  const [r1, r2] = app.trips[1].reservations
  assert.equal(r1.type, 'car')
  assert.equal(r1.location, 'SVQ Airport')
  assert.equal(r1.reservation_end_time, '2027-04-14')
  assert.match(r1.notes, /Return: Málaga/)
  assert.match(r1.notes, /Car class: Kombi/)
  assert.equal(r2.type, 'activity')
  assert.equal(r2.reservation_time, '2027-04-11T09:30')
  assert.equal(r2.location, 'Real Alcázar')
})

test('missing reservation_edit / budget_edit is reported, the decision still lands', async () => {
  const trips = tripFixtures({ can: { reservation_edit: false }, canEditCosts: false })
  const app = await setup({ trips })
  const { decisionId, optionId } = await decisionWithOption(app, 'aktivitaet', { title: 'Flamenco', price_total: 60 })
  const res = await app.post('/decide', { tripId: 1, decisionId, optionId, ...ALL })
  assert.equal(res.status, 200)
  assert.equal(res.body.results.booking.ok, false)
  assert.equal(res.body.results.booking.reason, 'no_permission')
  assert.equal(res.body.results.cost.ok, false)
  assert.equal(res.body.results.cost.reason, 'no_permission')
  const d = res.body.state.decisions.find((x) => x.id === decisionId)
  assert.equal(d.status, 'entschieden')
  assert.equal(d.linked_reservation_id, null)
  assert.equal(d.linked_cost_id, null)
  assert.equal(res.body.state.costs_unavailable, false)
})

test('Costs addon off: reported as addon_disabled and remembered for the trip', async () => {
  const app = await setup({ budgetAddonEnabled: false })
  const { decisionId, optionId } = await decisionWithOption(app, 'sonstiges', { title: 'Museumspass', price_total: 30 })
  const res = await app.post('/decide', { tripId: 1, decisionId, optionId, booking: true, cost: true })
  assert.equal(res.body.results.booking.ok, true)
  assert.equal(res.body.results.cost.reason, 'addon_disabled')
  assert.equal(res.body.state.costs_unavailable, true)
})

test('no price → no cost; re-running decide fills only what is missing', async () => {
  const app = await setup()
  const { decisionId, optionId } = await decisionWithOption(app, 'zug', { title: 'AVE', details: { from: 'Madrid', to: 'Sevilla', dep_date: '2027-04-10' } })
  const first = await app.post('/decide', { tripId: 1, decisionId, optionId, booking: false, cost: true })
  assert.equal(first.body.results.cost.reason, 'no_price')
  // Picking another option while decided is refused …
  const other = await app.post('/options/create', { tripId: 1, decisionId, title: 'Bus' })
  assert.equal(other.status, 409) // decided decisions take no new options
  // … re-running for the winner adds the booking now.
  const second = await app.post('/decide', { tripId: 1, decisionId, optionId, booking: true })
  assert.equal(second.body.results.booking.ok, true)
  assert.equal(app.trips[1].reservations.length, 1)
  assert.equal(app.trips[1].reservations[0].location, 'Madrid → Sevilla')
  const third = await app.post('/decide', { tripId: 1, decisionId, optionId, booking: true })
  assert.equal(third.body.results.booking, null) // already linked → nothing duplicated
  assert.equal(app.trips[1].reservations.length, 1)
})

test('reopen: asks before deleting — kept booking stays, deleted booking goes', async () => {
  const app = await setup()
  const a = await decisionWithOption(app, 'aktivitaet', { title: 'Tapas-Tour', price_total: 45 })
  await app.post('/options/create', { tripId: 1, decisionId: a.decisionId, title: 'Kochkurs' })
  await app.post('/decide', { tripId: 1, ...a, ...ALL })
  assert.equal(app.trips[1].reservations.length, 1)

  // Keep the booking.
  const keep = await app.post('/reopen', { tripId: 1, decisionId: a.decisionId, deleteBooking: false })
  assert.equal(keep.body.results.reopened, true)
  assert.equal(app.trips[1].reservations.length, 1)
  let d = keep.body.state.decisions.find((x) => x.id === a.decisionId)
  assert.equal(d.status, 'offen')
  assert.equal(d.linked_reservation_id, null)
  assert.ok(d.options.every((o) => o.archived === 0)) // options archived on decide come back

  // Decide again, then reopen and delete.
  await app.post('/decide', { tripId: 1, ...a, booking: true })
  assert.equal(app.trips[1].reservations.length, 2)
  const del = await app.post('/reopen', { tripId: 1, decisionId: a.decisionId, deleteBooking: true })
  assert.equal(del.body.results.booking.ok, true)
  assert.equal(app.trips[1].reservations.length, 1)
  d = del.body.state.decisions.find((x) => x.id === a.decisionId)
  assert.equal(d.status, 'offen')
})

test('reopen with delete refused keeps the decision decided', async () => {
  const trips = tripFixtures()
  const app = await setup({ trips })
  const a = await decisionWithOption(app, 'aktivitaet', { title: 'Tapas-Tour' })
  await app.post('/decide', { tripId: 1, ...a, booking: true })
  trips[1].can = { reservation_edit: false }
  const res = await app.post('/reopen', { tripId: 1, decisionId: a.decisionId, deleteBooking: true })
  assert.equal(res.body.results.reopened, false)
  assert.equal(res.body.results.booking.reason, 'no_permission')
  assert.equal(res.body.state.decisions[0].status, 'entschieden')
})

test('discarded decisions cannot be decided; decided ones cannot be discarded', async () => {
  const app = await setup()
  const a = await decisionWithOption(app, 'sonstiges', { title: 'X' })
  await app.post('/decisions/status', { tripId: 1, decisionId: a.decisionId, status: 'verworfen' })
  assert.equal((await app.post('/decide', { tripId: 1, ...a })).status, 409)
  await app.post('/decisions/status', { tripId: 1, decisionId: a.decisionId, status: 'offen' })
  assert.equal((await app.post('/decide', { tripId: 1, ...a })).status, 200)
  assert.equal((await app.post('/decisions/status', { tripId: 1, decisionId: a.decisionId, status: 'verworfen' })).status, 409)
  assert.equal((await app.post('/options/delete', { tripId: 1, optionId: a.optionId })).status, 409)
})
