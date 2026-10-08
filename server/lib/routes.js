// HTTP routes (mounted at /api/plugins/entscheidungen/<path>). Paths match exactly,
// so ids travel in the query (GET) or the JSON body (POST). Every route:
//   1. validates tripId and proves trip access via ctx.trips.getById → else 403,
//   2. pins every decision/option id it touches to that trip → else 404,
//   3. validates and caps the rest of the input → else 400,
//   4. after a write, pings the trip's open sessions and answers with fresh state.

const v = require('./validate')
const store = require('./store')
const booking = require('./booking')
const collab = require('./collab')
const ai = require('./ai')

// Whether the acting user has an AI provider (TREK's AI Parsing addon). Probing is
// free, but cache it a few minutes per user so a refresh does not ask every time.
const aiCache = new Map()
async function aiAvailable(ctx, userId) {
  const hit = aiCache.get(userId)
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.ok
  const ok = await ai.available(ctx)
  aiCache.set(userId, { at: Date.now(), ok })
  return ok
}
const { text: t, lang } = require('./i18n')

const { HttpError } = v

const json = (status, body) => ({ status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function fail(ctx, e) {
  if (e instanceof HttpError) return json(e.status, { error: e.code, message: e.message })
  ctx.log.error('route failed', { error: String((e && e.stack) || e) })
  return json(500, { error: 'internal', message: 'internal error' })
}

/** Ping every open session of the trip; the frames re-fetch /state. Best-effort. */
async function ping(ctx, tripId) {
  try {
    await ctx.ws.broadcastToTrip(tripId, 'changed', { at: Date.now() })
  } catch (e) {
    ctx.log.warn('broadcast failed', { error: String(e && e.message) })
  }
}

function tripIdOf(req) {
  const raw = req.method === 'GET' ? (req.query || {}).tripId : (req.body || {}).tripId
  return v.id(raw, 'tripId')
}

function body(req) {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
}

/** Full view state for the trip page. */
async function buildState(ctx, req, trip) {
  const tripId = trip.id
  const currency = trip.currency || null
  const [rates, members, settings, polls, aiOk] = await Promise.all([
    store.ratesFor(ctx, currency),
    store.roster(ctx, trip),
    store.getSettings(ctx.db, tripId),
    collab.pollSnapshot(ctx, tripId),
    aiAvailable(ctx, req.user.id),
  ])
  const decisions = await store.loadDecisions(ctx.db, tripId, { currency, rates })
  for (const d of decisions) {
    d.poll = d.linked_poll_id ? collab.pollInfo(polls.polls.get(Number(d.linked_poll_id))) : null
    delete d.poll_option_ids
  }
  return {
    ai_available: aiOk,
    collab_available: polls.available,
    rates_available: !!rates,
    me: { id: req.user.id, name: req.user.username },
    trip: {
      id: tripId,
      title: trip.title || trip.name || '',
      currency: trip.currency || null,
      start_date: trip.start_date || null,
      end_date: trip.end_date || null,
    },
    members,
    divisor: settings.divisor || Math.max(1, members.length),
    divisor_custom: !!settings.divisor,
    costs_unavailable: !!settings.costs_unavailable,
    decisions,
    now: new Date().toISOString(),
  }
}

/**
 * Wraps a handler with the common guard: tripId → membership check → handler.
 * `write` handlers answer with fresh state and ping the trip.
 */
function route(method, path, handler, { write = method !== 'GET' } = {}) {
  return {
    method,
    path,
    auth: true,
    async handler(req, ctx) {
      try {
        if (!req.user) throw new HttpError(403, 'forbidden', 'login required')
        const tripId = tripIdOf(req)
        const trip = await store.requireTrip(ctx, tripId)
        trip.id = tripId
        const extra = await handler({ req, ctx, trip, tripId, b: body(req) })
        if (write) await ping(ctx, tripId)
        const state = await buildState(ctx, req, trip)
        return json(200, { ...(extra || {}), state })
      } catch (e) {
        return fail(ctx, e)
      }
    },
  }
}

function requireOpen(decision) {
  if (decision.status !== 'offen') throw new HttpError(409, 'not_open', 'decision is not open')
}

// ---------------------------------------------------------------------------

const routes = [
  /** `locale` (optional) remembers the trip's language for host-rendered texts. */
  route('GET', '/state', async ({ ctx, req, tripId }) => {
    const raw = (req.query || {}).locale
    if (raw !== undefined) {
      const locale = lang(raw)
      const cur = await store.getSettings(ctx.db, tripId)
      if (cur.locale !== locale) await store.upsertSettings(ctx.db, tripId, { locale })
    }
    return null
  }, { write: false }),

  // Decisions -----------------------------------------------------------------
  route('POST', '/decisions/create', async ({ ctx, req, tripId, b }) => {
    const d = v.decisionInput(b)
    const rows = await ctx.db.query(
      `INSERT INTO decisions (trip_id, title, category, description, status, deadline, created_by, created_at)
       VALUES (?, ?, ?, ?, 'offen', ?, ?, ?) RETURNING id`,
      tripId, d.title, d.category, d.description, d.deadline, req.user.id, store.now(),
    )
    return { id: rows[0].id }
  }),

  route('POST', '/decisions/update', async ({ ctx, tripId, b }) => {
    const decisionId = v.id(b.decisionId, 'decisionId')
    const cur = await store.getDecision(ctx.db, tripId, decisionId)
    const d = v.decisionInput(b, { partial: true })
    const next = { ...cur, ...d }
    await ctx.db.exec(
      'UPDATE decisions SET title = ?, category = ?, description = ?, deadline = ? WHERE id = ? AND trip_id = ?',
      next.title, next.category, next.description, next.deadline, decisionId, tripId,
    )
    return { id: decisionId }
  }),

  /** Discard (verworfen) or restore (offen). "entschieden" only comes from /decide. */
  route('POST', '/decisions/status', async ({ ctx, tripId, b }) => {
    const decisionId = v.id(b.decisionId, 'decisionId')
    const status = v.oneOf(b.status, 'status', ['offen', 'verworfen'])
    const cur = await store.getDecision(ctx.db, tripId, decisionId)
    if (cur.status === 'entschieden') throw new HttpError(409, 'decided', 'reopen the decision first')
    await ctx.db.exec('UPDATE decisions SET status = ? WHERE id = ? AND trip_id = ?', status, decisionId, tripId)
    return { id: decisionId }
  }),

  route('POST', '/decisions/delete', async ({ ctx, tripId, b }) => {
    const decisionId = v.id(b.decisionId, 'decisionId')
    await store.getDecision(ctx.db, tripId, decisionId)
    const sub = 'SELECT id FROM options WHERE decision_id = ?'
    await ctx.db.tx([
      { sql: `DELETE FROM votes WHERE option_id IN (${sub})`, args: [decisionId] },
      { sql: `DELETE FROM pros_cons WHERE option_id IN (${sub})`, args: [decisionId] },
      { sql: 'DELETE FROM options WHERE decision_id = ?', args: [decisionId] },
      { sql: 'DELETE FROM decisions WHERE id = ? AND trip_id = ?', args: [decisionId, tripId] },
    ])
    return { deleted: decisionId }
  }),

  // Options -------------------------------------------------------------------
  route('POST', '/options/create', async ({ ctx, req, trip, tripId, b }) => {
    const decisionId = v.id(b.decisionId, 'decisionId')
    const decision = await store.getDecision(ctx.db, tripId, decisionId)
    requireOpen(decision)
    const o = v.optionInput(b, decision.category)
    if (o.price_total !== null && !o.currency) o.currency = trip.currency || null
    const rows = await ctx.db.query(
      `INSERT INTO options (decision_id, trip_id, title, url, price_total, currency, price_note, details_json,
                            lat, lng, notes, created_by, created_at, archived)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`,
      decisionId, tripId, o.title, o.url, o.price_total, o.currency, o.price_note, o.details_json,
      o.lat, o.lng, o.notes, req.user.id, store.now(),
    )
    return { id: rows[0].id }
  }),

  route('POST', '/options/update', async ({ ctx, trip, tripId, b }) => {
    const optionId = v.id(b.optionId, 'optionId')
    const cur = await store.getOption(ctx.db, tripId, optionId)
    const o = v.optionInput(b, cur.decision_category, { partial: true })
    const next = { ...cur, ...o }
    if (next.price_total !== null && !next.currency) next.currency = trip.currency || null
    await ctx.db.exec(
      `UPDATE options SET title = ?, url = ?, price_total = ?, currency = ?, price_note = ?, details_json = ?,
                          lat = ?, lng = ?, notes = ?
        WHERE id = ? AND decision_id = ?`,
      next.title, next.url, next.price_total, next.currency, next.price_note, next.details_json,
      next.lat, next.lng, next.notes, optionId, cur.decision_id,
    )
    return { id: optionId }
  }),

  route('POST', '/options/archive', async ({ ctx, tripId, b }) => {
    const optionId = v.id(b.optionId, 'optionId')
    const cur = await store.getOption(ctx.db, tripId, optionId)
    const archived = v.bool(b.archived) ? 1 : 0
    if (archived && cur.decision_status === 'entschieden') {
      const d = await store.getDecision(ctx.db, tripId, cur.decision_id)
      if (d.winner_option_id === optionId) throw new HttpError(409, 'winner', 'the chosen option cannot be archived')
    }
    await ctx.db.exec('UPDATE options SET archived = ? WHERE id = ? AND decision_id = ?', archived, optionId, cur.decision_id)
    return { id: optionId }
  }),

  route('POST', '/options/delete', async ({ ctx, tripId, b }) => {
    const optionId = v.id(b.optionId, 'optionId')
    const cur = await store.getOption(ctx.db, tripId, optionId)
    const d = await store.getDecision(ctx.db, tripId, cur.decision_id)
    if (d.winner_option_id === optionId) throw new HttpError(409, 'winner', 'the chosen option cannot be deleted')
    await ctx.db.tx([
      { sql: 'DELETE FROM votes WHERE option_id = ?', args: [optionId] },
      { sql: 'DELETE FROM pros_cons WHERE option_id = ?', args: [optionId] },
      { sql: 'DELETE FROM options WHERE id = ? AND decision_id = ?', args: [optionId, cur.decision_id] },
    ])
    return { deleted: optionId }
  }),

  // Pros / cons ---------------------------------------------------------------
  route('POST', '/proscons/create', async ({ ctx, req, tripId, b }) => {
    const optionId = v.id(b.optionId, 'optionId')
    await store.getOption(ctx.db, tripId, optionId)
    const kind = v.oneOf(b.kind, 'kind', ['pro', 'con'])
    const txt = v.text(b.text, 'text', { max: 280, required: true })
    const rows = await ctx.db.query(
      'INSERT INTO pros_cons (option_id, kind, text, created_by, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id',
      optionId, kind, txt, req.user.id, store.now(),
    )
    return { id: rows[0].id }
  }),

  /** Everyone adds points; only the author deletes their own. */
  route('POST', '/proscons/delete', async ({ ctx, req, tripId, b }) => {
    const itemId = v.id(b.id, 'id')
    const rows = await ctx.db.query(
      `SELECT p.* FROM pros_cons p JOIN options o ON o.id = p.option_id JOIN decisions d ON d.id = o.decision_id
        WHERE p.id = ? AND d.trip_id = ?`,
      itemId, tripId,
    )
    if (!rows.length) throw new HttpError(404, 'not_found', 'item not found')
    if (rows[0].created_by !== req.user.id) throw new HttpError(403, 'not_author', 'only the author can delete this')
    await ctx.db.exec('DELETE FROM pros_cons WHERE id = ?', itemId)
    return { deleted: itemId }
  }),

  // Votes ---------------------------------------------------------------------
  /** Upvote any number of options; a veto is per option. Up and veto exclude each other. */
  route('POST', '/votes/set', async ({ ctx, req, tripId, b }) => {
    const optionId = v.id(b.optionId, 'optionId')
    const value = v.oneOf(b.value, 'value', ['up', 'veto'])
    const active = v.bool(b.active)
    const o = await store.getOption(ctx.db, tripId, optionId)
    if (o.decision_status !== 'offen') throw new HttpError(409, 'not_open', 'decision is not open')
    if (store.votingClosed({ status: o.decision_status, deadline: o.decision_deadline })) {
      throw new HttpError(409, 'voting_closed', 'voting has ended')
    }
    if (o.archived) throw new HttpError(409, 'archived', 'option is archived')
    const uid = req.user.id
    if (active) {
      const other = value === 'up' ? 'veto' : 'up'
      await ctx.db.tx([
        { sql: 'DELETE FROM votes WHERE option_id = ? AND user_id = ? AND value = ?', args: [optionId, uid, other] },
        { sql: 'INSERT OR IGNORE INTO votes (option_id, user_id, value) VALUES (?, ?, ?)', args: [optionId, uid, value] },
      ])
    } else {
      await ctx.db.exec('DELETE FROM votes WHERE option_id = ? AND user_id = ? AND value = ?', optionId, uid, value)
    }
    return { optionId, value, active }
  }),

  // Settings ------------------------------------------------------------------
  route('POST', '/settings', async ({ ctx, tripId, b }) => {
    const divisor = v.number(b.divisor, 'divisor', { min: 1, max: 99 })
    if (divisor !== null && !Number.isInteger(divisor)) throw v.bad('divisor', 'must be a whole number')
    await store.upsertSettings(ctx.db, tripId, { divisor })
    return null
  }),

  // AI import -----------------------------------------------------------------
  /** Pasted offer text → a draft for the option form. Nothing is stored. */
  route('POST', '/ai/extract', async ({ ctx, req, tripId, b }) => {
    const decisionId = v.id(b.decisionId, 'decisionId')
    const d = await store.getDecision(ctx.db, tripId, decisionId)
    const text = v.text(b.text, 'text', { max: 20000, required: true, multiline: true })
    try {
      return { draft: await ai.extract(ctx, d.category, text) }
    } catch (e) {
      const r = booking.classify(e)
      if (/no AI provider/i.test(r.message)) { r.reason = 'no_ai'; aiCache.delete(req.user.id) }
      return { draft: null, error: r }
    }
  }, { write: false }),

  // Collab poll (one way) -----------------------------------------------------
  route('POST', '/poll/post', async ({ ctx, tripId, b }) => {
    const decisionId = v.id(b.decisionId, 'decisionId')
    const d = await store.getDecision(ctx.db, tripId, decisionId)
    requireOpen(d)
    const options = await ctx.db.query('SELECT id, title, archived FROM options WHERE decision_id = ? ORDER BY id', decisionId)
    // Rank order reads better in the poll than creation order.
    const ranked = (await store.loadDecisions(ctx.db, tripId)).find((x) => x.id === decisionId)
    const order = new Map(ranked.options.map((o, i) => [o.id, i]))
    options.sort((a, c) => order.get(a.id) - order.get(c.id))
    try {
      return { poll: await collab.postPoll(ctx, tripId, d, options) }
    } catch (e) {
      if (e instanceof HttpError) throw e
      return { poll: booking.classify(e) }
    }
  }),

  route('POST', '/poll/import', async ({ ctx, trip, tripId, b }) => {
    const decisionId = v.id(b.decisionId, 'decisionId')
    const d = await store.getDecision(ctx.db, tripId, decisionId)
    requireOpen(d)
    if (store.votingClosed(d)) throw new HttpError(409, 'voting_closed', 'voting has ended')
    if (!d.linked_poll_id) throw new HttpError(409, 'no_poll', 'no poll posted for this decision')
    const members = await store.roster(ctx, trip)
    return { imported: await collab.importVotes(ctx, tripId, d, members.map((m) => m.id)) }
  }),

  // Decide / reopen -----------------------------------------------------------
  route('POST', '/decide', async ({ ctx, req, trip, tripId, b }) => {
    const decisionId = v.id(b.decisionId, 'decisionId')
    const optionId = v.id(b.optionId, 'optionId')
    const locale = lang(b.locale)
    const decision = await store.getDecision(ctx.db, tripId, decisionId)
    if (decision.status === 'verworfen') throw new HttpError(409, 'discarded', 'decision is discarded')
    const opt = await store.getOption(ctx.db, tripId, optionId)
    if (opt.decision_id !== decisionId) throw new HttpError(404, 'not_found', 'option not found')
    if (decision.status === 'entschieden' && decision.winner_option_id !== optionId) {
      throw new HttpError(409, 'decided', 'reopen the decision to pick another option')
    }
    const option = { ...opt, details: store.parseDetails(opt.details_json) }
    const results = { booking: null, cost: null, archived: null, notified: null }

    // 1. Booking (skipped when one is already linked — re-running fills gaps only).
    let reservationId = decision.linked_reservation_id || null
    if (v.bool(b.booking) && !reservationId) {
      try {
        results.booking = await booking.createBooking(ctx, trip, decision, option, locale)
        reservationId = results.booking.id || null
      } catch (e) {
        results.booking = booking.classify(e)
      }
    }

    // 2. Cost, linked to the booking when there is one.
    let costId = decision.linked_cost_id || null
    if (v.bool(b.cost) && !costId) {
      if (option.price_total === null || !(option.price_total > 0)) {
        results.cost = { ok: false, reason: 'no_price' }
      } else {
        try {
          // Equal split across the chosen members (default: everyone on the trip).
          const roster = (await store.roster(ctx, trip)).map((m) => m.id)
          let split = roster
          if (b.splitMemberIds !== undefined && b.splitMemberIds !== null) {
            if (!Array.isArray(b.splitMemberIds) || b.splitMemberIds.length > 200) throw v.bad('splitMemberIds', 'must be a list')
            const want = new Set(b.splitMemberIds.map((x) => v.id(x, 'splitMemberIds')))
            split = roster.filter((id) => want.has(id))
          }
          results.cost = await booking.createCost(ctx, trip, decision, option, reservationId, split)
          costId = results.cost.id || null
        } catch (e) {
          results.cost = booking.classify(e)
          if (results.cost.reason === 'addon_disabled') await store.upsertSettings(ctx.db, tripId, { costs_unavailable: 1 })
        }
      }
    }

    // 3. Mark as decided (also when a TREK write was refused — the group decided).
    const first = decision.status !== 'entschieden'
    await ctx.db.exec(
      `UPDATE decisions SET status = 'entschieden', winner_option_id = ?, decided_by = ?, decided_at = ?,
                            linked_reservation_id = ?, linked_cost_id = ?
        WHERE id = ? AND trip_id = ?`,
      optionId, first ? req.user.id : decision.decided_by, first ? store.now() : decision.decided_at,
      reservationId, costId, decisionId, tripId,
    )
    await ctx.db.exec('UPDATE options SET archived = 0 WHERE id = ?', optionId)

    // 4. Archive the rest.
    if (v.bool(b.archiveOthers)) {
      const r = await ctx.db.exec(
        'UPDATE options SET archived = 2 WHERE decision_id = ? AND id != ? AND archived = 0', decisionId, optionId,
      )
      results.archived = { ok: true, count: r.changes }
    }

    // 5. Tell the group.
    if (v.bool(b.notify)) {
      try {
        const price = booking.formatPrice(option.price_total, option.currency, locale)
        await ctx.notify.send({
          title: t(locale, 'notify.title', { decision: decision.title }).slice(0, 200),
          body: t(locale, 'notify.body', {
            option: option.title,
            price: price ? ` · ${price}` : '',
            user: req.user.username || t(locale, 'someone'),
          }).slice(0, 1000),
          scope: 'trip',
          targetId: tripId,
          link: `/trips/${tripId}`,
        })
        results.notified = { ok: true }
      } catch (e) {
        results.notified = booking.classify(e)
      }
    }
    return { results }
  }),

  /**
   * Back to "offen". A booking/cost the decision created is NOT removed silently:
   * the client asks first and passes deleteBooking / deleteCost. Whatever is kept
   * stays in TREK as an ordinary booking/cost and is unlinked from the decision, so
   * a later decision creates fresh ones for whichever option wins then.
   *
   * If a delete is refused (e.g. no reservation_edit), the decision stays decided:
   * reopening must not leave a booking behind that the user asked to remove.
   */
  route('POST', '/reopen', async ({ ctx, tripId, b }) => {
    const decisionId = v.id(b.decisionId, 'decisionId')
    const d = await store.getDecision(ctx.db, tripId, decisionId)
    if (d.status !== 'entschieden') throw new HttpError(409, 'not_decided', 'decision is not decided')
    const results = { booking: null, cost: null, reopened: false }
    const gone = (r) => r.reason === 'forbidden' && /\bno (reservation|cost)\b/i.test(r.message || '')
    if (d.linked_reservation_id && v.bool(b.deleteBooking)) {
      try {
        // A cost created against the booking goes with it (TREK cascades the link).
        await ctx.reservations.delete(tripId, d.linked_reservation_id)
        results.booking = { ok: true }
      } catch (e) {
        results.booking = booking.classify(e)
        if (!gone(results.booking)) return { results }
      }
    }
    const costGoneWithBooking = results.booking && results.booking.ok
    if (d.linked_cost_id && v.bool(b.deleteCost) && !costGoneWithBooking) {
      try {
        await ctx.costs.delete(tripId, d.linked_cost_id)
        results.cost = { ok: true }
      } catch (e) {
        results.cost = booking.classify(e)
        if (!gone(results.cost)) return { results }
      }
    }
    results.reopened = true
    await ctx.db.tx([
      {
        sql: `UPDATE decisions SET status = 'offen', winner_option_id = NULL, decided_by = NULL, decided_at = NULL,
                                   linked_reservation_id = NULL, linked_cost_id = NULL
               WHERE id = ? AND trip_id = ?`,
        args: [decisionId, tripId],
      },
      { sql: 'UPDATE options SET archived = 0 WHERE decision_id = ? AND archived = 2', args: [decisionId] },
    ])
    return { results }
  }),
]

module.exports = { routes, buildState, json, fail, HttpError, _resetAiCache: () => aiCache.clear() }
