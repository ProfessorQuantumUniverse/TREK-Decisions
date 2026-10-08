// Provider hooks: TREK renders these natively (no iframe). They run user-bound on a
// short timeout and a throw is simply skipped by the host — but the plugin's own
// database is not membership-checked, so every per-trip hook proves access first.
// Texts come in the trip's last-used language (the hooks receive no locale).

const store = require('./store')
const { text: t } = require('./i18n')
const { formatPrice } = require('./booking')

const ICON = {
  unterkunft: 'BedDouble', flug: 'Plane', zug: 'TrainFront', mietwagen: 'Car', aktivitaet: 'Ticket', sonstiges: 'CircleEllipsis',
}
const DAY = 24 * 60 * 60 * 1000
const SOON = 3 * DAY

async function tripAccess(ctx, tripId) {
  try {
    return await store.requireTrip(ctx, tripId)
  } catch {
    return null
  }
}

async function localeOf(ctx, tripId) {
  return (await store.getSettings(ctx.db, tripId)).locale || 'de'
}

function when(locale, deadline, now) {
  const days = Math.floor((Date.parse(deadline) - now) / DAY)
  if (days <= 0) {
    const sameDay = new Date(deadline).toDateString() === new Date(now).toDateString()
    return t(locale, sameDay ? 'when.today' : 'when.tomorrow')
  }
  if (days === 1) return t(locale, 'when.tomorrow')
  return t(locale, 'when.days', { n: days })
}

/** Options of open decisions with coordinates, as map markers (≤ 200, host-capped). */
async function getMarkers(tripId, ctx) {
  const trip = await tripAccess(ctx, tripId)
  if (!trip) return []
  const locale = await localeOf(ctx, tripId)
  const rates = await store.ratesFor(ctx, trip.currency)
  const decisions = await store.loadDecisions(ctx.db, tripId, { currency: trip.currency || null, rates })
  const markers = []
  for (const d of decisions) {
    if (d.status !== 'offen') continue
    for (const o of d.options) {
      if (o.archived || o.lat === null || o.lng === null) continue
      const price = formatPrice(o.price_total, o.currency, locale)
      const parts = [d.title]
      if (price) parts.push(price)
      parts.push(t(locale, o.up.length === 1 ? 'marker.vote' : 'marker.votes', { n: o.up.length }))
      if (o.veto.length) parts.push(t(locale, 'marker.veto'))
      markers.push({
        id: `option-${o.id}`,
        lat: o.lat,
        lng: o.lng,
        label: o.title.slice(0, 80),
        popupText: parts.join(' · ').slice(0, 280),
        ...(o.url ? { url: o.url } : {}),
        icon: ICON[d.category] || 'Scale',
        tone: o.veto.length ? 'danger' : d.leader_option_id === o.id && o.up.length ? 'success' : 'default',
      })
      if (markers.length >= 200) return markers
    }
  }
  return markers
}

/** Banner: open decisions whose deadline is less than three days away (or has passed). */
async function getWarnings(tripId, ctx) {
  const trip = await tripAccess(ctx, tripId)
  if (!trip) return []
  const locale = await localeOf(ctx, tripId)
  const now = Date.now()
  const rows = await ctx.db.query(
    "SELECT id, title, deadline FROM decisions WHERE trip_id = ? AND status = 'offen' AND deadline IS NOT NULL ORDER BY deadline",
    tripId,
  )
  const out = []
  for (const d of rows) {
    const left = Date.parse(d.deadline) - now
    if (left <= 0) out.push({ level: 'info', message: t(locale, 'warning.ended', { decision: d.title }) })
    else if (left < SOON) out.push({ level: 'warning', message: t(locale, 'warning.deadline', { decision: d.title, when: when(locale, d.deadline, now) }) })
  }
  return out.slice(0, 20).map((w) => ({ ...w, message: w.message.slice(0, 300) }))
}

/** Dashboard badge: "2 open decisions" per trip card (tripIds are host access-checked). */
async function getCards(tripIds, ctx) {
  const ids = (Array.isArray(tripIds) ? tripIds : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 240)
  if (!ids.length) return []
  const marks = ids.map(() => '?').join(',')
  const rows = await ctx.db.query(
    `SELECT d.trip_id, COUNT(*) AS n, MIN(d.deadline) AS next, COALESCE(s.locale, 'de') AS locale
       FROM decisions d LEFT JOIN trip_settings s ON s.trip_id = d.trip_id
      WHERE d.status = 'offen' AND d.trip_id IN (${marks})
      GROUP BY d.trip_id`,
    ...ids,
  )
  const now = Date.now()
  return rows.map((r) => {
    const next = r.next ? Date.parse(r.next) : null
    return {
      tripId: r.trip_id,
      id: 'open-decisions',
      label: t(r.locale, r.n === 1 ? 'card.open.one' : 'card.open'),
      value: String(r.n),
      icon: 'Scale',
      tone: next !== null && next - now < SOON ? 'warn' : 'default',
    }
  })
}

module.exports = {
  mapMarkerProvider: { getMarkers },
  warningProvider: { getWarnings },
  tripCardProvider: { getCards },
}
