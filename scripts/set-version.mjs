#!/usr/bin/env node
// Sets the plugin version in trek-plugin.json and package.json (they must match the
// release tag: v1.2.3 ↔ "1.2.3").
//
// Usage: npm run version:set -- 1.2.3
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const version = (process.argv[2] || '').replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error('usage: npm run version:set -- <major.minor.patch>')
  process.exit(1)
}
for (const file of ['trek-plugin.json', 'package.json', 'package-lock.json']) {
  const p = path.join(root, file)
  if (!fs.existsSync(p)) continue
  const json = JSON.parse(fs.readFileSync(p, 'utf8'))
  json.version = version
  if (json.packages && json.packages['']) json.packages[''].version = version // lockfile root entry
  fs.writeFileSync(p, JSON.stringify(json, null, 2) + '\n')
}
console.log(`version set to ${version} — next: commit, then  git tag v${version} && git push --follow-tags`)
