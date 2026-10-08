#!/usr/bin/env node
// Seeds the `trek-plugin dev` database (.trek-dev/db.sqlite) with the example
// decisions from dev-fixtures.json → "seed". The fixtures can only feed the mock
// host (trips, members, days); the plugin's own SQLite has to be filled directly —
// which also lets the seed carry votes and pros/cons of other group members.
//
// Usage: npm run seed   (replaces every decision of the seed trip)
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const { MIGRATIONS } = require(path.join(root, 'server', 'lib', 'schema.js'))
const fixtures = JSON.parse(fs.readFileSync(path.join(root, 'dev-fixtures.json'), 'utf8'))
const seed = fixtures.seed
if (!seed) throw new Error('dev-fixtures.json has no "seed" block')

const file = path.join(root, '.trek-dev', 'db.sqlite')
fs.mkdirSync(path.dirname(file), { recursive: true })
const db = new DatabaseSync(file)
for (const [, sql] of MIGRATIONS) db.exec(sql)

const tripId = seed.tripId
const now = Date.now()
const iso = (offsetMs = 0) => new Date(now + offsetMs).toISOString()

db.exec('BEGIN')
try {
  const sub = 'SELECT o.id FROM options o JOIN decisions d ON d.id = o.decision_id WHERE d.trip_id = ?'
  db.prepare(`DELETE FROM votes WHERE option_id IN (${sub})`).run(tripId)
  db.prepare(`DELETE FROM pros_cons WHERE option_id IN (${sub})`).run(tripId)
  db.prepare('DELETE FROM options WHERE trip_id = ?').run(tripId)
  db.prepare('DELETE FROM decisions WHERE trip_id = ?').run(tripId)
  db.prepare('DELETE FROM trip_settings WHERE trip_id = ?').run(tripId)

  const insD = db.prepare(`INSERT INTO decisions (trip_id, title, category, description, status, deadline, created_by, created_at)
                           VALUES (?, ?, ?, ?, 'offen', ?, ?, ?) RETURNING id`)
  const insO = db.prepare(`INSERT INTO options (decision_id, trip_id, title, url, price_total, currency, price_note, details_json,
                                                lat, lng, notes, created_by, created_at, archived)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING id`)
  const insP = db.prepare('INSERT INTO pros_cons (option_id, kind, text, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
  const insV = db.prepare('INSERT INTO votes (option_id, user_id, value) VALUES (?, ?, ?)')

  seed.decisions.forEach((d, di) => {
    const deadline = d.deadlineInHours ? iso(d.deadlineInHours * 3600_000) : null
    const { id: decisionId } = insD.get(tripId, d.title, d.category, d.description ?? null, deadline, d.created_by, iso(-(10 - di) * 86400_000))
    d.options.forEach((o, oi) => {
      const { id: optionId } = insO.get(
        decisionId, tripId, o.title, o.url ?? null, o.price_total ?? null, o.currency ?? null, o.price_note ?? null,
        JSON.stringify(o.details ?? {}), o.lat ?? null, o.lng ?? null, o.notes ?? null, o.created_by, iso(-(9 - di) * 86400_000 + oi * 60_000),
      )
      for (const [user, text] of o.pros ?? []) insP.run(optionId, 'pro', text, user, iso())
      for (const [user, text] of o.cons ?? []) insP.run(optionId, 'con', text, user, iso())
      for (const user of o.up ?? []) insV.run(optionId, user, 'up')
      for (const user of o.veto ?? []) insV.run(optionId, user, 'veto')
    })
  })
  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK')
  throw e
}
db.close()
console.log(`seeded ${seed.decisions.length} decisions into ${path.relative(root, file)}`)
