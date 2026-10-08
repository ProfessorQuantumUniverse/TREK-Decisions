// MCP tools on TREK's own MCP server (advertised as plugin_entscheidungen_<name>).
// `callTool` runs as the requesting MCP user — route-like, membership-checked — so each
// tool goes through the very same route handler (and guards) as the trip page.
//
// The host does not tell the plugin WHO that user is, so rows a tool creates are
// attributed to the assistant (created_by = ASSISTANT) rather than to a person.
//
// Keep TOOLS identical to capabilities.mcpTools[].name in trek-plugin.json: only the
// intersection is advertised, silently.

const { CATEGORIES, DETAIL_FIELDS } = require('./validate')

const ASSISTANT = -1
const TOOLS = ['list_decisions', 'create_decision', 'add_option']

function handlerFor(routes, method, path) {
  const r = routes.find((x) => x.method === method && x.path === path)
  if (!r) throw new Error(`no route ${method} ${path}`)
  return r.handler
}

async function invoke(routes, ctx, method, path, args) {
  const req = {
    method, path,
    query: method === 'GET' ? args : {},
    body: method === 'GET' ? null : args,
    user: { id: ASSISTANT, username: 'assistant', isAdmin: false },
    headers: {},
  }
  const res = await handlerFor(routes, method, path)(req, ctx)
  const body = res.body ? JSON.parse(res.body) : {}
  if (res.status !== 200) {
    const why = { 400: 'invalid input', 403: 'no access to this trip', 404: 'not found on this trip', 409: 'not possible in the current state' }[res.status] || 'failed'
    throw new Error(`${why}${body.message ? `: ${body.message}` : ''}`)
  }
  return body
}

function summary(state, onlyId) {
  const name = (id) => (state.members.find((m) => m.id === id) || {}).name || (id === ASSISTANT ? 'assistant' : null)
  return {
    trip: state.trip.title,
    currency: state.trip.currency,
    members: state.members.length,
    decisions: state.decisions
      .filter((d) => !onlyId || d.id === onlyId)
      .map((d) => ({
        id: d.id,
        title: d.title,
        category: d.category,
        status: d.status,
        deadline: d.deadline,
        voting_ended: d.voting_closed,
        chosen_option_id: d.winner_option_id,
        options: d.options.filter((o) => !o.archived).map((o) => ({
          id: o.id,
          rank: o.rank,
          title: o.title,
          price_total: o.price_total,
          currency: o.currency,
          price_in_trip_currency: o.price_trip,
          upvotes: o.up.length,
          upvoted_by: o.up.map(name).filter(Boolean),
          vetoes: o.veto.length,
          vetoed_by: o.veto.map(name).filter(Boolean),
          pros: o.pros.map((p) => p.text),
          cons: o.cons.map((p) => p.text),
          url: o.url,
        })),
      })),
  }
}

function create(routes) {
  return {
    tools: TOOLS,
    async callTool({ name, args }, ctx) {
      const a = args && typeof args === 'object' ? args : {}
      if (name === 'list_decisions') {
        const { state } = await invoke(routes, ctx, 'GET', '/state', { tripId: a.tripId })
        const out = summary(state)
        if (a.status) out.decisions = out.decisions.filter((d) => d.status === a.status)
        return out
      }
      if (name === 'create_decision') {
        const { id, state } = await invoke(routes, ctx, 'POST', '/decisions/create', {
          tripId: a.tripId, title: a.title, category: a.category, description: a.description, deadline: a.deadline,
        })
        return { created_decision_id: id, ...summary(state, id) }
      }
      if (name === 'add_option') {
        const { id, state } = await invoke(routes, ctx, 'POST', '/options/create', {
          tripId: a.tripId, decisionId: a.decisionId, title: a.title, url: a.url, price_total: a.price_total,
          currency: a.currency, price_note: a.price_note, notes: a.notes, details: a.details, lat: a.lat, lng: a.lng,
        })
        return { created_option_id: id, ...summary(state, a.decisionId) }
      }
      throw new Error(`unknown tool ${name}`)
    },
  }
}

// Documentation for the `details` argument, built from the same field list the
// server validates against (pasted into the manifest description).
function detailsDoc() {
  return Object.entries(DETAIL_FIELDS).map(([c, f]) => `${c}: ${Object.keys(f).join(', ')}`).join(' | ')
}

module.exports = { create, TOOLS, ASSISTANT, CATEGORIES, detailsDoc }
