// Turning the chosen option into TREK data: a booking (reservation, for a stay with
// its accommodation block), a linked cost, a group notification.
//
// Every write runs with the CLICKING user's rights (the host binds the acting user),
// so each step can fail on its own — a missing reservation_edit / budget_edit, the
// Costs addon switched off. Each step is wrapped and reported back as
// { ok, reason, message } instead of failing the whole decision.

const { findAirport } = require('./airports')
const { text: t } = require('./i18n')

/** Category → TREK reservation type + the planner tab that lists it. */
const RESERVATION_TYPE = {
  unterkunft: 'hotel',
  flug: 'flight',
  zug: 'train',
  mietwagen: 'car',
  aktivitaet: 'activity',
  sonstiges: 'other',
}
const TRANSPORT_TYPES = new Set(['flight', 'train', 'car'])

/** Same buckets as TREK's own typeToCostCategory (shared/src/budget). */
const COST_CATEGORY = {
  hotel: 'accommodation',
  flight: 'flights',
  train: 'transport',
  car: 'transport',
  activity: 'activities',
  other: 'other',
}

function tabFor(type) {
  return TRANSPORT_TYPES.has(type) ? 'transports' : 'buchungen'
}

/** Map a failed ctx.* call onto a reason the client can phrase. */
function classify(e) {
  const msg = String((e && e.message) || e || '')
  let reason = 'error'
  if (/PERMISSION_DENIED/.test(msg)) reason = 'plugin_permission'
  else if (/addon is disabled/i.test(msg)) reason = 'addon_disabled'
  else if (/no permission/i.test(msg)) reason = 'no_permission'
  else if (/RESOURCE_FORBIDDEN/.test(msg)) reason = 'forbidden'
  else if (/BAD_PARAMS|invalid|required|must be/i.test(msg)) reason = 'invalid'
  else if (/rate limit|budget exhausted/i.test(msg)) reason = 'limit'
  return { ok: false, reason, message: msg.slice(0, 300) }
}

function stamp(date, time) {
  if (!date) return undefined
  return time ? `${date}T${time}` : date
}

function cap(s, max) {
  return s && s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function formatPrice(amount, currency, locale) {
  if (amount === null || amount === undefined) return null
  try {
    return new Intl.NumberFormat(locale === 'de' ? 'de-DE' : 'en-GB', {
      style: 'currency', currency: currency || 'EUR',
      minimumFractionDigits: Math.round(amount) === amount ? 0 : 2, maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${amount} ${currency || ''}`.trim()
  }
}

/** The free-text notes the booking carries: price, the bits TREK has no column for, the option notes. */
function bookingNotes(option, locale, extra = []) {
  const lines = []
  const price = formatPrice(option.price_total, option.currency, locale)
  if (price) lines.push(`${t(locale, 'notes.price')}: ${price}${option.price_note ? ` (${option.price_note})` : ''}`)
  for (const l of extra) if (l) lines.push(l)
  if (option.notes) lines.push(option.notes)
  lines.push(t(locale, 'notes.footer'))
  return cap(lines.join('\n'), 2000)
}

function airportEndpoint(role, code, date, time, seq) {
  const a = findAirport(code)
  if (!a) return null
  return {
    role,
    sequence: seq,
    name: cap(a.city ? `${a.city} (${a.iata})` : `${a.name} (${a.iata})`, 200),
    code: a.iata,
    lat: a.lat,
    lng: a.lng,
    timezone: a.tz,
    local_time: time || null,
    local_date: date || null,
  }
}

/**
 * The reservations.create input for an option, plus hints about what could not be
 * mapped. `days` is ctx.trips.getDays(trip) — used to put a stay onto trip days.
 */
function buildReservation(decision, option, days, locale) {
  const d = option.details || {}
  const type = RESERVATION_TYPE[decision.category] || 'other'
  const warnings = []
  const input = {
    title: cap(option.title, 200),
    type,
    status: 'pending',
  }
  if (option.url) input.url = option.url

  if (type === 'hotel') {
    const byDate = new Map()
    for (const day of days || []) if (day && day.date) byDate.set(String(day.date).slice(0, 10), day.id)
    const start = d.checkin_date ? byDate.get(d.checkin_date) : undefined
    const end = d.checkout_date ? byDate.get(d.checkout_date) : undefined
    if (d.address) input.location = cap(d.address, 500)
    if (d.checkin_date) input.reservation_time = stamp(d.checkin_date, d.checkin_time)
    if (d.checkout_date) input.reservation_end_time = stamp(d.checkout_date, d.checkout_time)
    const meta = {}
    if (d.checkin_time) meta.check_in_time = d.checkin_time
    if (d.checkout_time) meta.check_out_time = d.checkout_time
    if (Object.keys(meta).length) input.metadata = meta
    if (start) input.day_id = start
    if (end) input.end_day_id = end
    if (start && end) {
      input.create_accommodation = {
        start_day_id: start,
        end_day_id: end,
        ...(d.checkin_time ? { check_in: d.checkin_time } : {}),
        ...(d.checkout_time ? { check_out: d.checkout_time } : {}),
      }
    } else {
      warnings.push(d.checkin_date && d.checkout_date ? 'dates_outside_trip' : 'dates_missing')
    }
    const extra = []
    if (d.beds) extra.push(`${t(locale, 'notes.beds')}: ${d.beds}`)
    if (d.cancellation) extra.push(`${t(locale, 'notes.cancellation')}: ${d.cancellation}`)
    input.notes = bookingNotes(option, locale, extra)
  } else if (type === 'flight') {
    input.reservation_time = stamp(d.dep_date, d.dep_time)
    input.reservation_end_time = stamp(d.arr_date || d.dep_date, d.arr_time)
    const meta = {}
    if (d.airline) meta.airline = d.airline
    if (d.flight_number) meta.flight_number = d.flight_number
    if (d.dep_airport) meta.departure_airport = d.dep_airport
    if (d.arr_airport) meta.arrival_airport = d.arr_airport
    if (Object.keys(meta).length) input.metadata = meta
    if (d.dep_airport && d.arr_airport) {
      const from = airportEndpoint('from', d.dep_airport, d.dep_date, d.dep_time, 0)
      const to = airportEndpoint('to', d.arr_airport, d.arr_date || d.dep_date, d.arr_time, 1)
      if (from && to) input.endpoints = [from, to]
      else warnings.push('airport_unknown')
    }
    const extra = []
    if (d.stops !== undefined) extra.push(`${t(locale, 'notes.stops')}: ${d.stops}`)
    if (d.baggage) extra.push(`${t(locale, 'notes.baggage')}: ${d.baggage}`)
    input.notes = bookingNotes(option, locale, extra)
  } else if (type === 'train') {
    input.reservation_time = stamp(d.dep_date, d.dep_time)
    input.reservation_end_time = stamp(d.arr_date || d.dep_date, d.arr_time)
    if (d.from || d.to) input.location = cap([d.from, d.to].filter(Boolean).join(' → '), 500)
    const extra = []
    if (d.changes !== undefined) extra.push(`${t(locale, 'notes.changes')}: ${d.changes}`)
    input.notes = bookingNotes(option, locale, extra)
  } else if (type === 'car') {
    input.reservation_time = stamp(d.pickup_date, d.pickup_time)
    input.reservation_end_time = stamp(d.return_date, d.return_time)
    if (d.pickup_place) input.location = cap(d.pickup_place, 500)
    const extra = []
    if (d.return_place) extra.push(`${t(locale, 'notes.return')}: ${d.return_place}`)
    if (d.car_class) extra.push(`${t(locale, 'notes.carClass')}: ${d.car_class}`)
    input.notes = bookingNotes(option, locale, extra)
  } else {
    input.reservation_time = stamp(d.date, d.time)
    if (d.place) input.location = cap(d.place, 500)
    input.notes = bookingNotes(option, locale)
  }
  for (const k of Object.keys(input)) if (input[k] === undefined) delete input[k]
  return { input, type, warnings }
}

/** A stay gets a TREK place (from coordinates / address) so the block shows on the map. */
async function createStayPlace(ctx, tripId, option) {
  const d = option.details || {}
  if (option.lat === null && !d.address) return { placeId: null }
  const place = {
    name: cap(option.title, 200),
    ...(option.lat !== null ? { lat: option.lat, lng: option.lng } : {}),
    ...(d.address ? { address: cap(d.address, 500) } : {}),
    ...(option.url ? { website: option.url } : {}),
  }
  try {
    const created = await ctx.places.create(tripId, place)
    return { placeId: created && created.id ? created.id : null }
  } catch (e) {
    return { placeId: null, warning: 'place_failed', error: classify(e) }
  }
}

async function createBooking(ctx, trip, decision, option, locale) {
  let days = []
  try {
    days = await ctx.trips.getDays(trip.id)
  } catch {
    days = []
  }
  const { input, type, warnings } = buildReservation(decision, option, days, locale)
  if (type === 'hotel') {
    const place = await createStayPlace(ctx, trip.id, option)
    if (place.warning) warnings.push(place.warning)
    if (place.placeId) {
      input.place_id = place.placeId
      if (input.create_accommodation) input.create_accommodation.place_id = place.placeId
    }
  }
  const reservation = await ctx.reservations.create(trip.id, input)
  return {
    ok: true,
    id: reservation && reservation.id,
    type,
    tab: tabFor(type),
    accommodation: !!input.create_accommodation,
    warnings,
  }
}

async function createCost(ctx, trip, decision, option, reservationId, splitMemberIds = []) {
  const type = RESERVATION_TYPE[decision.category] || 'other'
  const input = {
    name: cap(option.title, 200),
    category: COST_CATEGORY[type] || 'other',
    total_price: option.price_total,
    currency: option.currency || trip.currency || undefined,
  }
  if (option.price_note) input.note = cap(option.price_note, 500)
  if (reservationId) input.reservation_id = reservationId
  // Equal split (TREK's member_ids); without it the cost is planning-only.
  if (splitMemberIds.length) input.member_ids = splitMemberIds
  if (!input.currency) delete input.currency
  const item = await ctx.costs.create(trip.id, input)
  return { ok: true, id: item && item.id, split: splitMemberIds.length }
}

module.exports = {
  RESERVATION_TYPE, COST_CATEGORY, tabFor, classify, buildReservation, createBooking, createCost, formatPrice,
}
