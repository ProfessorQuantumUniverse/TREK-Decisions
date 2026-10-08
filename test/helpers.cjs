// Test harness: the SDK's createMockHost (enforces grants, membership and the
// per-trip app rights exactly like the host) with its recorder `ctx.db` swapped for
// a real in-memory SQLite that mirrors the host's PluginDataDb semantics — so the
// plugin's SQL actually runs.
const { DatabaseSync } = require('node:sqlite')
const { createMockHost } = require('trek-plugin-sdk/testing')
const plugin = require('../server/index.js')
const manifest = require('../trek-plugin.json')

const FORBIDDEN = /\b(ATTACH|DETACH|VACUUM|PRAGMA|RECURSIVE|LOAD_EXTENSION)\b/i
const READER = /^\s*(SELECT|WITH|VALUES)\b|\bRETURNING\b/i

function realDb() {
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE IF NOT EXISTS _plugin_migrations (id TEXT PRIMARY KEY, applied_at INTEGER)')
  const guard = (sql) => {
    if (FORBIDDEN.test(sql)) throw new Error('statement type not allowed for plugin databases')
  }
  return {
    raw: db,
    async query(sql, ...args) {
      guard(sql)
      return db.prepare(sql).all(...args)
    },
    async exec(sql, ...args) {
      guard(sql)
      if (args.length) return { changes: Number(db.prepare(sql).run(...args).changes) }
      db.exec(sql)
      return { changes: 0 }
    },
    async migrate(id, sql) {
      guard(sql)
      if (db.prepare('SELECT 1 FROM _plugin_migrations WHERE id = ?').get(id)) return { applied: false }
      db.exec(sql)
      db.prepare('INSERT INTO _plugin_migrations (id, applied_at) VALUES (?, ?)').run(id, Date.now())
      return { applied: true }
    },
    async tx(ops) {
      for (const op of ops) guard(op.sql)
      db.exec('BEGIN')
      try {
        const results = ops.map((op) => {
          const stmt = db.prepare(op.sql)
          return READER.test(op.sql) ? { rows: stmt.all(...(op.args || [])) } : { changes: Number(stmt.run(...(op.args || [])).changes) }
        })
        db.exec('COMMIT')
        return { results }
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
  }
}

const USERS = {
  1: { id: 1, username: 'lorenzo', display_name: 'Lorenzo' },
  2: { id: 2, username: 'mia', display_name: 'Mia' },
  3: { id: 3, username: 'jonas', display_name: 'Jonas' },
  4: { id: 4, username: 'sara', display_name: 'Sara' },
  9: { id: 9, username: 'stranger', display_name: 'Stranger' },
}

const DAYS = ['2027-04-10', '2027-04-11', '2027-04-12', '2027-04-13', '2027-04-14'].map((date, i) => ({ id: 100 + i, trip_id: 1, date }))

function tripFixtures(overrides = {}) {
  return {
    1: {
      members: [1, 2, 3, 4],
      data: { id: 1, user_id: 1, title: 'Andalusien', currency: 'EUR', start_date: '2027-04-10', end_date: '2027-04-14' },
      days: DAYS,
      ...overrides,
    },
    // Somebody else's trip — user 1 is no member.
    2: { members: [9], data: { id: 2, user_id: 9, title: 'Fremd', currency: 'USD' } },
  }
}

/**
 * One acting user against a shared database. Several hosts may share `db` and `trips`
 * to simulate several group members.
 */
function makeHost({ user = 1, db = realDb(), trips = tripFixtures(), grants = manifest.permissions, ...rest } = {}) {
  const host = createMockHost({ grants, actingUserId: user, trips, users: USERS, ...rest })
  host.ctx.db = db
  host.userlessCtx.db = db
  const drv = host.run(plugin)
  const call = async (method, path, payload = {}) => {
    const req = method === 'GET' ? { query: payload } : { body: payload }
    req.user = { id: user, username: USERS[user] ? USERS[user].username : 'user' + user, isAdmin: false }
    const res = await drv.route({ method, path }, req)
    return { status: res.status, body: res.body ? JSON.parse(res.body) : null }
  }
  return { host, drv, db, trips, call, get: (p, q) => call('GET', p, q), post: (p, b) => call('POST', p, b) }
}

/** A loaded plugin with user 1 plus a helper to act as another member on the same data. */
async function setup(opts = {}) {
  const main = makeHost(opts)
  await main.drv.load()
  main.as = (user, extra = {}) => makeHost({ ...opts, ...extra, user, db: main.db, trips: main.trips })
  return main
}

module.exports = { realDb, makeHost, setup, tripFixtures, USERS, DAYS, plugin, manifest }
