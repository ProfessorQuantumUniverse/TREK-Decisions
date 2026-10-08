// Entscheidungen — the pre-booking phase of a group trip: collect options, weigh
// pros and cons, vote, and turn the winner into a TREK booking + cost.
//
// Runs in TREK's isolated plugin child. `trek-plugin-sdk` is injected by the host
// at runtime (devDependency only — never vendored).
const { definePlugin } = require('trek-plugin-sdk')
const { migrate } = require('./lib/schema')
const { routes } = require('./lib/routes')
const hooks = require('./lib/hooks')
const mcp = require('./lib/mcp')
const gdpr = require('./lib/gdpr')

module.exports = definePlugin({
  async onLoad(ctx) {
    await migrate(ctx.db)
    ctx.log.info('entscheidungen loaded')
  },

  routes,

  hooks: {
    // Native TREK surfaces: map markers, planner banner, dashboard badge.
    ...hooks,
    // Tools for an assistant connected to TREK's MCP server.
    mcpToolProvider: mcp.create(routes),
  },

  // GDPR erasure / export (hook:user-data).
  deleteUserData: gdpr.deleteUserData,
  exportUserData: gdpr.exportUserData,
})
