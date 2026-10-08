// Data access on the plugin's own database plus the trip-scoped guards.
//
// The own database is NOT membership-checked by the host, so every entry point first
// proves trip access through ctx.trips.getById (which is), and every row lookup is
// pinned to that trip: a decision must carry the route's trip_id, an option must
// belong to a decision of that trip. A foreign id therefore reads as "not found".

const { HttpError } = require('./validate')

const now = () => new Date().toISOString()

/** Membership check. Any refusal or a missing trip is a 403 — never a hint. */
async function requireTrip(ctx, tripId) {
  let trip = null
  try {
    trip = await ctx.trips.getById(tripId)
  } catch (e) {
    throw new HttpError(403, 'forbidden', 'no access to this trip')
  }
  if (!trip) throw new HttpError(403, 'forbidden', 'no access to this trip')
  return trip
}

async function getDecision(db, tripId, decisionId) {
  const rows = await db.query('SELECT * FROM decisions WHERE id = ? AND trip_id = ?', decisionId, tripId)
  if (!rows.length) throw new HttpError(404, 'not_found', 'decision not found')
  return rows[0]
}

/** An option together with its decision, both pinned to the route's trip. */
async function getOption(db, tripId, optionId) {
  const rows = await db.query(
    `SELECT o.*, d.trip_id AS decision_trip_id, d.status AS decision_status, d.deadline AS decision_deadline,
            d.category AS decision_category
       FROM options o JOIN decisions d ON d.id = o.decision_id
      WHERE o.id = ? AND d.trip_id = ?`,
    optionId, tripId,
  )
  if (!rows.length) throw new HttpError(404, 'not_found', 'option not found')
  return rows[0]
}

function votingClosed(decision, at = Date.now()) {
  return decision.status === 'offen' && !!decision.deadline && Date.parse(decision.deadline) <= at
}

function parseDetails(json) {
  try {
    const v = JSON.parse(json || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/**
 * Ranking: upvotes descending, ties broken by the cheaper total price (unpriced
 * last), then by age. Options carrying a veto are flagged and sorted below every
 * option without one (ranked among themselves by the same rule). Archived options
 * are not ranked.
 *
 * `convert(option)` may return the price in a common currency for the tie-break.
 */
function rankOptions(options, convert = (o) => o.price_total) {
  const active = options.filter((o) => !o.archived)
  const key = (o) => {
    const p = convert(o)
    return p === null || p === undefined ? Number.POSITIVE_INFINITY : p
  }
  active.sort((a, b) => {
    const va = a.veto.length > 0 ? 1 : 0
    const vb = b.veto.length > 0 ? 1 : 0
    if (va !== vb) return va - vb
    if (b.up.length !== a.up.length) return b.up.length - a.up.length
    if (key(a) !== key(b)) return key(a) - key(b)
    return a.id - b.id
  })
  active.forEach((o, i) => { o.rank = i + 1 })
  return active
}

/**
 * Every decision of a trip with its options, pros/cons and votes, ranked.
 * With `currency` + `rates` (relative to it) each option also carries `price_trip`,
 * its total in the trip currency — used for the display and the price tie-break.
 */
async function loadDecisions(db, tripId, { currency = null, rates = null } = {}) {
  const decisions = await db.query('SELECT * FROM decisions WHERE trip_id = ? ORDER BY created_at DESC, id DESC', tripId)
  const options = await db.query(
    'SELECT o.* FROM options o JOIN decisions d ON d.id = o.decision_id WHERE d.trip_id = ? ORDER BY o.id',
    tripId,
  )
  const pc = await db.query(
    `SELECT p.* FROM pros_cons p JOIN options o ON o.id = p.option_id JOIN decisions d ON d.id = o.decision_id
      WHERE d.trip_id = ? ORDER BY p.id`,
    tripId,
  )
  const votes = await db.query(
    `SELECT v.* FROM votes v JOIN options o ON o.id = v.option_id JOIN decisions d ON d.id = o.decision_id
      WHERE d.trip_id = ? ORDER BY v.user_id`,
    tripId,
  )
  const byOption = new Map()
  for (const o of options) {
    byOption.set(o.id, {
      id: o.id,
      decision_id: o.decision_id,
      title: o.title,
      url: o.url,
      price_total: o.price_total,
      currency: o.currency,
      price_note: o.price_note,
      details: parseDetails(o.details_json),
      lat: o.lat,
      lng: o.lng,
      notes: o.notes,
      created_by: o.created_by,
      created_at: o.created_at,
      archived: o.archived,
      price_trip: currency ? convert(o.price_total, o.currency || currency, currency, rates) : o.price_total,
      pros: [],
      cons: [],
      up: [],
      veto: [],
      rank: null,
    })
  }
  for (const p of pc) {
    const o = byOption.get(p.option_id)
    if (o) (p.kind === 'pro' ? o.pros : o.cons).push({ id: p.id, text: p.text, created_by: p.created_by, created_at: p.created_at })
  }
  for (const v of votes) {
    const o = byOption.get(v.option_id)
    if (o) (v.value === 'up' ? o.up : o.veto).push(v.user_id)
  }
  const at = Date.now()
  return decisions.map((d) => {
    const opts = [...byOption.values()].filter((o) => o.decision_id === d.id)
    const ranked = rankOptions(opts, (o) => (o.price_trip !== null ? o.price_trip : o.price_total))
    const archived = opts.filter((o) => o.archived)
    const leader = ranked.find((o) => o.veto.length === 0) || null
    return {
      ...d,
      voting_closed: votingClosed(d, at),
      options: [...ranked, ...archived],
      option_count: ranked.length,
      leader_option_id: leader ? leader.id : null,
    }
  })
}

async function getSettings(db, tripId) {
  const rows = await db.query('SELECT * FROM trip_settings WHERE trip_id = ?', tripId)
  return rows[0] || { trip_id: tripId, divisor: null, costs_unavailable: 0, locale: null }
}

async function upsertSettings(db, tripId, fields) {
  const cur = await getSettings(db, tripId)
  const next = { ...cur, ...fields }
  await db.exec(
    `INSERT INTO trip_settings (trip_id, divisor, costs_unavailable, locale) VALUES (?, ?, ?, ?)
     ON CONFLICT (trip_id) DO UPDATE SET divisor = excluded.divisor, costs_unavailable = excluded.costs_unavailable,
                                         locale = excluded.locale`,
    tripId, next.divisor ?? null, next.costs_unavailable ? 1 : 0, next.locale ?? null,
  )
  return next
}

// Exchange rates are cached upstream; a short in-process cache saves a ctx call per refresh.
const rateCache = new Map()
const RATE_TTL = 30 * 60 * 1000

/** quote → units of `quote` per 1 `base`, or null when the host has none. */
async function ratesFor(ctx, base) {
  if (!base || !/^[A-Z]{3}$/.test(base)) return null
  const hit = rateCache.get(base)
  if (hit && Date.now() - hit.at < RATE_TTL) return hit.rates
  let rates = null
  try {
    rates = await ctx.rates.get(base)
  } catch (e) {
    rates = null
  }
  if (rates && typeof rates === 'object') rateCache.set(base, { at: Date.now(), rates })
  return rates && typeof rates === 'object' ? rates : null
}

/** Amount in `from` converted into `to`, given rates relative to `to`. Null if unknown. */
function convert(amount, from, to, rates) {
  if (amount === null || amount === undefined) return null
  if (!from || from === to) return amount
  const r = rates && Number(rates[from])
  if (!r || !Number.isFinite(r) || r <= 0) return null
  return Math.round((amount / r) * 100) / 100
}

/** Trip roster: the invited members plus the owner (who is not in trip_members). */
async function roster(ctx, trip) {
  const tripId = trip.id
  let members = []
  try {
    members = await ctx.trips.members(tripId)
  } catch (e) {
    ctx.log.warn('members lookup failed', { error: String(e && e.message) })
  }
  const list = new Map()
  for (const m of members || []) {
    if (m && Number.isInteger(m.id)) list.set(m.id, { id: m.id, name: displayName(m) })
  }
  const ownerId = Number(trip.user_id)
  if (Number.isInteger(ownerId) && ownerId > 0 && !list.has(ownerId)) {
    let owner = null
    try {
      owner = await ctx.users.getById(ownerId)
    } catch {
      owner = null
    }
    list.set(ownerId, { id: ownerId, name: owner ? displayName(owner) : null, owner: true })
  } else if (list.has(ownerId)) {
    list.get(ownerId).owner = true
  }
  return [...list.values()]
}

function displayName(u) {
  const n = (u.display_name || u.username || '').toString().trim()
  return n ? n.slice(0, 60) : null
}

module.exports = {
  now, requireTrip, getDecision, getOption, votingClosed, parseDetails, rankOptions, loadDecisions,
  getSettings, upsertSettings, roster, displayName, ratesFor, convert,
  _resetRateCache: () => rateCache.clear(),
}
