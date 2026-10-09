// Input validation. Everything that reaches the own database or a TREK write goes
// through here: strings are trimmed and length-capped, enums are closed, URLs must be
// http(s), numbers are finite and bounded. A failure is an HttpError(400).

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code)
    this.status = status
    this.code = code
  }
}

const bad = (field, why) => new HttpError(400, 'invalid_input', `${field}: ${why}`)

// Upper bounds on how much one trip can hold. They keep the own database, the state
// payload and the rendered page bounded however the routes are driven (a script, an
// assistant in a loop). Hitting one is a 409 "limit_reached".
const LIMITS = {
  decisionsPerTrip: 200,
  optionsPerDecision: 50,
  pointsPerOption: 100,
}

const CATEGORIES = ['unterkunft', 'flug', 'zug', 'mietwagen', 'aktivitaet', 'sonstiges']
const STATUSES = ['offen', 'entschieden', 'verworfen']

// Category-specific option fields, stored in options.details_json. Unknown keys are
// dropped. Types: text (capped), date YYYY-MM-DD, time HH:mm, int (0..99), iata.
const DETAIL_FIELDS = {
  unterkunft: {
    checkin_date: 'date', checkin_time: 'time', checkout_date: 'date', checkout_time: 'time',
    address: 'text', beds: 'int', cancellation: 'text',
  },
  flug: {
    dep_airport: 'iata', arr_airport: 'iata', dep_date: 'date', dep_time: 'time',
    arr_date: 'date', arr_time: 'time', airline: 'text', flight_number: 'code',
    stops: 'int', baggage: 'text',
  },
  zug: {
    from: 'text', to: 'text', dep_date: 'date', dep_time: 'time', arr_date: 'date', arr_time: 'time',
    changes: 'int',
  },
  mietwagen: {
    pickup_place: 'text', pickup_date: 'date', pickup_time: 'time',
    return_place: 'text', return_date: 'date', return_time: 'time', car_class: 'text',
  },
  aktivitaet: { date: 'date', time: 'time', place: 'text' },
  sonstiges: { date: 'date', time: 'time', place: 'text' },
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function id(v, field) {
  const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) throw bad(field, 'must be a positive integer')
  return n
}

function text(v, field, { max, required = false, multiline = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(field, 'is required')
    return null
  }
  if (typeof v !== 'string') throw bad(field, 'must be a string')
  // Control characters out (newlines kept for multi-line fields), and the bidi
  // embedding/override/isolate controls, which can make a title read as something
  // other than what was stored.
  let s = v
    .replace(multiline ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g : /[\u0000-\u001F\u007F\u2028\u2029]/g, '')
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, '')
  s = s.trim()
  if (!s) {
    if (required) throw bad(field, 'is required')
    return null
  }
  if (s.length > max) throw bad(field, `must be at most ${max} characters`)
  return s
}

function oneOf(v, field, allowed) {
  if (!allowed.includes(v)) throw bad(field, `must be one of ${allowed.join(', ')}`)
  return v
}

function bool(v) {
  return v === true || v === 'true' || v === 1
}

function httpUrl(v, field) {
  const s = text(v, field, { max: 2000 })
  if (s === null) return null
  let u
  try { u = new URL(s) } catch { throw bad(field, 'must be a valid http(s) URL') }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad(field, 'must be an http(s) URL')
  // https://booking.com@evil.example/ puts a trusted name in front of another host.
  if (u.username || u.password) throw bad(field, 'must not contain credentials')
  return u.href
}

function number(v, field, { min, max }) {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v
  if (typeof n !== 'number' || !Number.isFinite(n)) throw bad(field, 'must be a number')
  if (n < min || n > max) throw bad(field, `must be between ${min} and ${max}`)
  return n
}

function currency(v, field) {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !/^[A-Za-z]{3}$/.test(v.trim())) throw bad(field, 'must be a 3-letter currency code')
  return v.trim().toUpperCase()
}

function isoDate(v, field) {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(field, 'must be YYYY-MM-DD')
  const d = new Date(`${v}T00:00:00Z`)
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad(field, 'is not a real date')
  return v
}

function time(v, field) {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad(field, 'must be HH:mm')
  return v
}

const ISO_INSTANT = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?)(Z|[+-]\d{2}:?\d{2})?)?$/i

/**
 * A deadline is an absolute instant; it is stored as an ISO-8601 UTC string. Only ISO
 * 8601 is accepted (Date.parse alone also takes "March 1 2027" and reads it in the
 * server's time zone). A date, or a date-time without an offset, is read as UTC so the
 * result never depends on the host's TZ. The trip page always sends a full UTC instant.
 */
function deadline(v, field) {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || v.length > 40) throw bad(field, 'must be an ISO date-time')
  const m = ISO_INSTANT.exec(v.trim())
  if (!m) throw bad(field, 'must be an ISO date-time')
  const t = Date.parse(m[2] ? `${m[1]}T${m[2]}${m[3] ? m[3].toUpperCase() : 'Z'}` : `${m[1]}T00:00:00Z`)
  if (Number.isNaN(t)) throw bad(field, 'must be an ISO date-time')
  const year = new Date(t).getUTCFullYear()
  if (year < 2000 || year > 2100) throw bad(field, 'is out of range')
  return new Date(t).toISOString()
}

function details(category, v) {
  const spec = DETAIL_FIELDS[category]
  const out = {}
  if (v === undefined || v === null) return out
  if (!isObj(v)) throw bad('details', 'must be an object')
  for (const [key, type] of Object.entries(spec)) {
    const raw = v[key]
    const f = `details.${key}`
    let val = null
    if (type === 'text') val = text(raw, f, { max: 200 })
    else if (type === 'code') val = text(raw, f, { max: 20 })
    else if (type === 'date') val = isoDate(raw, f)
    else if (type === 'time') val = time(raw, f)
    else if (type === 'int') {
      const n = number(raw, f, { min: 0, max: 99 })
      if (n !== null && !Number.isInteger(n)) throw bad(f, 'must be a whole number')
      val = n
    } else if (type === 'iata') {
      const s = text(raw, f, { max: 3 })
      if (s !== null && !/^[A-Za-z]{3}$/.test(s)) throw bad(f, 'must be a 3-letter IATA code')
      val = s && s.toUpperCase()
    }
    if (val !== null) out[key] = val
  }
  return out
}

function decisionInput(body, { partial = false } = {}) {
  const out = {}
  if (!partial || body.title !== undefined) out.title = text(body.title, 'title', { max: 120, required: true })
  if (!partial || body.category !== undefined) out.category = oneOf(body.category, 'category', CATEGORIES)
  if (!partial || body.description !== undefined) out.description = text(body.description, 'description', { max: 2000, multiline: true })
  if (!partial || body.deadline !== undefined) out.deadline = deadline(body.deadline, 'deadline')
  return out
}

function optionInput(body, category, { partial = false } = {}) {
  const out = {}
  const has = (k) => !partial || body[k] !== undefined
  if (has('title')) out.title = text(body.title, 'title', { max: 200, required: true })
  if (has('url')) out.url = httpUrl(body.url, 'url')
  if (has('price_total')) out.price_total = number(body.price_total, 'price_total', { min: 0, max: 1e9 })
  if (has('currency')) out.currency = currency(body.currency, 'currency')
  if (has('price_note')) out.price_note = text(body.price_note, 'price_note', { max: 200 })
  if (has('notes')) out.notes = text(body.notes, 'notes', { max: 2000, multiline: true })
  if (has('details')) out.details_json = JSON.stringify(details(category, body.details))
  if (has('lat') || has('lng')) {
    const lat = number(body.lat, 'lat', { min: -90, max: 90 })
    const lng = number(body.lng, 'lng', { min: -180, max: 180 })
    if ((lat === null) !== (lng === null)) throw bad('lat/lng', 'must be given together')
    out.lat = lat
    out.lng = lng
  }
  return out
}

module.exports = {
  HttpError, bad, LIMITS, CATEGORIES, STATUSES, DETAIL_FIELDS,
  id, text, oneOf, bool, httpUrl, number, currency, isoDate, time, deadline, details,
  decisionInput, optionInput,
}
