// IATA → coordinates/timezone, from the bundled OurAirports extract
// (server/data/airports.json, built by scripts/build-airports.mjs). TREK stores a
// flight's from/to endpoints only with coordinates, and plugins cannot reach TREK's
// own airport search, so the lookup ships with the plugin.

let table = null

function load() {
  if (!table) {
    try {
      table = require('../data/airports.json')
    } catch {
      table = {}
    }
  }
  return table
}

function findAirport(code) {
  if (typeof code !== 'string' || !/^[A-Za-z]{3}$/.test(code)) return null
  const iata = code.toUpperCase()
  const row = load()[iata]
  if (!row) return null
  const [lat, lng, tz, name, city] = row
  return { iata, lat, lng, tz: tz || null, name, city }
}

module.exports = { findAirport }
