// Collab-poll bridge (one way): a decision's options can be posted as a poll in the
// trip's Collab tab, and that poll's votes can be pulled back in as upvotes. The
// plugin's own votes stay the source of truth — nothing is ever written back.
//
// The Collab addon is optional: it is not a requiredAddon, so every call is guarded
// and the feature is simply hidden when the addon is off or the grant is missing.

const { HttpError } = require('./validate')

/**
 * Probe + snapshot in one call: the trip's polls (needs db:read:collab and the addon).
 * Returns { available, polls: Map<pollId, poll> }.
 */
async function pollSnapshot(ctx, tripId) {
  try {
    const polls = await ctx.collab.listPolls(tripId)
    const map = new Map()
    for (const p of Array.isArray(polls) ? polls : []) if (p && p.id) map.set(Number(p.id), p)
    return { available: true, polls: map }
  } catch (e) {
    return { available: false, polls: new Map(), reason: String((e && e.message) || e) }
  }
}

/** What the trip page shows about a decision's linked poll. */
function pollInfo(poll) {
  if (!poll) return { exists: false }
  const options = Array.isArray(poll.options) ? poll.options : []
  const voters = new Set()
  for (const o of options) for (const v of (o && o.voters) || []) voters.add(Number(v.user_id ?? v.id))
  return {
    exists: true,
    closed: !!(poll.is_closed || poll.closed),
    voters: voters.size,
    votes: options.reduce((n, o) => n + (((o && o.voters) || []).length), 0),
  }
}

function pollQuestion(decision) {
  return decision.title.slice(0, 200)
}

/** Post the decision's active options as a multiple-choice (approval) poll. */
async function postPoll(ctx, tripId, decision, options) {
  const active = options.filter((o) => !o.archived)
  if (active.length < 2) throw new HttpError(409, 'too_few_options', 'a poll needs at least two options')
  if (active.length > 20) throw new HttpError(409, 'too_many_options', 'too many options for a poll')
  const input = {
    question: pollQuestion(decision),
    options: active.map((o) => o.title.slice(0, 200)),
    multiple: true,
  }
  if (decision.deadline && Date.parse(decision.deadline) > Date.now()) input.deadline = decision.deadline
  const poll = await ctx.collab.createPoll(tripId, input)
  const pollId = poll && Number(poll.id)
  if (!pollId) throw new Error('the host returned no poll id')
  await ctx.db.exec(
    'UPDATE decisions SET linked_poll_id = ?, poll_option_ids = ? WHERE id = ? AND trip_id = ?',
    pollId, JSON.stringify(active.map((o) => o.id)), decision.id, tripId,
  )
  return { pollId, options: active.length }
}

/**
 * Copy the poll's votes in as upvotes. Only adds: a vote the plugin already has stays,
 * a vote that disappeared from the poll is not removed, and an option the voter vetoed
 * in the plugin is skipped (the veto wins). Voters must be on the trip.
 */
async function importVotes(ctx, tripId, decision, rosterIds) {
  const snap = await pollSnapshot(ctx, tripId)
  if (!snap.available) throw new HttpError(409, 'collab_unavailable', 'collab is not available')
  const poll = snap.polls.get(Number(decision.linked_poll_id))
  if (!poll) {
    await ctx.db.exec('UPDATE decisions SET linked_poll_id = NULL, poll_option_ids = NULL WHERE id = ? AND trip_id = ?', decision.id, tripId)
    throw new HttpError(404, 'poll_gone', 'the poll no longer exists')
  }
  let ids = []
  try { ids = JSON.parse(decision.poll_option_ids || '[]') } catch { ids = [] }
  // The options still in this decision (an option deleted since posting is skipped).
  const alive = new Set((await ctx.db.query('SELECT id FROM options WHERE decision_id = ? AND archived = 0', decision.id)).map((r) => r.id))
  const vetoes = new Set((await ctx.db.query(
    `SELECT v.option_id || ':' || v.user_id AS k FROM votes v JOIN options o ON o.id = v.option_id
      WHERE o.decision_id = ? AND v.value = 'veto'`, decision.id,
  )).map((r) => r.k))
  const roster = new Set(rosterIds)
  const ops = []
  const options = Array.isArray(poll.options) ? poll.options : []
  options.forEach((opt, idx) => {
    const optionId = Number(ids[idx])
    if (!optionId || !alive.has(optionId)) return
    for (const v of (opt && opt.voters) || []) {
      const uid = Number(v.user_id ?? v.id)
      if (!roster.has(uid) || vetoes.has(`${optionId}:${uid}`)) continue
      ops.push({ sql: "INSERT OR IGNORE INTO votes (option_id, user_id, value) VALUES (?, ?, 'up')", args: [optionId, uid] })
    }
  })
  let added = 0
  for (let i = 0; i < ops.length; i += 100) {
    const { results } = await ctx.db.tx(ops.slice(i, i + 100))
    added += results.reduce((n, r) => n + (r.changes || 0), 0)
  }
  return { added, considered: ops.length }
}

module.exports = { pollSnapshot, pollInfo, postPoll, importVotes }
