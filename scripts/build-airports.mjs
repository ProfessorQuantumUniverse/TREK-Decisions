#!/usr/bin/env node
// Builds server/data/airports.json from OurAirports (public domain,
// https://davidmegginson.github.io/ourairports-data/). Keeps large and medium
// airports that carry an IATA code; the timezone is derived from the
// coordinates with tz-lookup (devDependency, never shipped).
//
// Output shape (compact on purpose, it ships inside plugin.zip):
//   { "SVQ": [lat, lng, "Europe/Madrid", "Seville Airport", "Sevilla"], ... }
//
// Usage: node scripts/build-airports.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tzLookup from 'tz-lookup';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'server', 'data', 'airports.json');
const SRC = 'https://davidmegginson.github.io/ourairports-data/airports.csv';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const res = await fetch(SRC);
if (!res.ok) throw new Error(`HTTP ${res.status} for ${SRC}`);
const [header, ...rows] = parseCsv(await res.text());
const col = (name) => header.indexOf(name);
const iType = col('type'), iName = col('name'), iLat = col('latitude_deg'), iLng = col('longitude_deg');
const iCity = col('municipality'), iIata = col('iata_code'), iSched = col('scheduled_service');

const out = {};
for (const r of rows) {
  const iata = (r[iIata] || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(iata)) continue;
  const type = r[iType];
  if (type !== 'large_airport' && type !== 'medium_airport') continue;
  const lat = Number(r[iLat]);
  const lng = Number(r[iLng]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
  // Prefer an airport with scheduled service when two rows claim the same code.
  if (out[iata] && r[iSched] !== 'yes') continue;
  let tz = null;
  try { tz = tzLookup(lat, lng); } catch { tz = null; }
  out[iata] = [Math.round(lat * 1e4) / 1e4, Math.round(lng * 1e4) / 1e4, tz, r[iName], r[iCity] || ''];
}

const sorted = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(sorted) + '\n');
console.log(`wrote ${Object.keys(sorted).length} airports to ${path.relative(process.cwd(), OUT)} (${fs.statSync(OUT).size} bytes)`);
