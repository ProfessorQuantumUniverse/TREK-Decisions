// GDPR data-subject hooks (`hook:user-data`). Both run userless and touch only the
// plugin's own database. TREK calls deleteUserData durably (retried until it succeeds),
// so it must be idempotent — running it twice simply finds nothing left to do.
//
// What is personal here: a user's votes, their pros/cons and the "created/decided by"
// marks. Votes and pros/cons are removed; decisions and options are shared group
// content, so they stay and only lose the link to the person (DELETED_USER).

const DELETED_USER = 0

async function deleteUserData({ userId }, ctx) {
  const uid = Number(userId)
  if (!Number.isInteger(uid) || uid <= 0) return
  await ctx.db.tx([
    { sql: 'DELETE FROM votes WHERE user_id = ?', args: [uid] },
    { sql: 'DELETE FROM pros_cons WHERE created_by = ?', args: [uid] },
    { sql: 'UPDATE options SET created_by = ? WHERE created_by = ?', args: [DELETED_USER, uid] },
    { sql: 'UPDATE decisions SET created_by = ? WHERE created_by = ?', args: [DELETED_USER, uid] },
    { sql: 'UPDATE decisions SET decided_by = ? WHERE decided_by = ?', args: [DELETED_USER, uid] },
  ])
}

async function exportUserData({ userId }, ctx) {
  const uid = Number(userId)
  if (!Number.isInteger(uid) || uid <= 0) return {}
  const [votes, points, options, decisions] = await Promise.all([
    ctx.db.query(
      `SELECT v.value, o.title AS option, d.title AS decision, d.trip_id
         FROM votes v JOIN options o ON o.id = v.option_id JOIN decisions d ON d.id = o.decision_id
        WHERE v.user_id = ? ORDER BY d.trip_id, d.id`, uid),
    ctx.db.query(
      `SELECT p.kind, p.text, p.created_at, o.title AS option, d.title AS decision, d.trip_id
         FROM pros_cons p JOIN options o ON o.id = p.option_id JOIN decisions d ON d.id = o.decision_id
        WHERE p.created_by = ? ORDER BY p.id`, uid),
    ctx.db.query(
      `SELECT o.title, o.url, o.price_total, o.currency, o.created_at, d.title AS decision, d.trip_id
         FROM options o JOIN decisions d ON d.id = o.decision_id WHERE o.created_by = ? ORDER BY o.id`, uid),
    ctx.db.query(
      `SELECT title, category, status, created_at, trip_id, CASE WHEN decided_by = ? THEN decided_at END AS decided_at
         FROM decisions WHERE created_by = ? OR decided_by = ? ORDER BY id`, uid, uid, uid),
  ])
  return { votes, pros_cons: points, options_created: options, decisions_created_or_decided: decisions }
}

module.exports = { deleteUserData, exportUserData, DELETED_USER }
