// Entscheidungen — the pre-booking phase of a group trip: collect options, weigh
// pros and cons, vote, and turn the winner into a TREK booking + cost.
//
// Runs in TREK's isolated plugin child. `trek-plugin-sdk` is injected by the host
// at runtime (devDependency only — never vendored).
const { definePlugin } = require('trek-plugin-sdk')
const { migrate } = require('./lib/schema')
const { routes } = require('./lib/routes')
const hooks = require('./lib/hooks')

module.exports = definePlugin({
  async onLoad(ctx) {
    await migrate(ctx.db)
    ctx.log.info('entscheidungen loaded')
  },

  routes,

  // Native TREK surfaces: map markers, planner banner, dashboard badge.
  hooks,
})
