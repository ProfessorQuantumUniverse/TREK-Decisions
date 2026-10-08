// Own SQLite schema (ctx.db, `db:own`). The plugin database is a separate file the
// host keeps per plugin, so every row carries its trip_id and every read filters on
// it. Foreign keys are declared nowhere: PRAGMA is refused on plugin databases, so
// cascades could never be switched on — deletes are done by hand in one ctx.db.tx.
//
// Note for future migrations: the host refuses any statement that merely contains
// one of ATTACH / DETACH / VACUUM / PRAGMA / RECURSIVE / LOAD_EXTENSION.

const MIGRATIONS = [
  ['001_init', `
    CREATE TABLE IF NOT EXISTS decisions (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id               INTEGER NOT NULL,
      title                 TEXT    NOT NULL,
      category              TEXT    NOT NULL,
      description           TEXT,
      status                TEXT    NOT NULL DEFAULT 'offen',
      deadline              TEXT,
      winner_option_id      INTEGER,
      created_by            INTEGER NOT NULL,
      created_at            TEXT    NOT NULL,
      decided_by            INTEGER,
      decided_at            TEXT,
      linked_poll_id        INTEGER,
      linked_reservation_id INTEGER,
      linked_cost_id        INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_decisions_trip ON decisions (trip_id);

    CREATE TABLE IF NOT EXISTS options (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      decision_id  INTEGER NOT NULL,
      trip_id      INTEGER NOT NULL,
      title        TEXT    NOT NULL,
      url          TEXT,
      price_total  REAL,
      currency     TEXT,
      price_note   TEXT,
      details_json TEXT    NOT NULL DEFAULT '{}',
      lat          REAL,
      lng          REAL,
      notes        TEXT,
      created_by   INTEGER NOT NULL,
      created_at   TEXT    NOT NULL,
      -- 0 = active, 1 = archived by hand, 2 = archived when the decision was made
      -- (only those come back when the decision is reopened)
      archived     INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_options_decision ON options (decision_id);
    CREATE INDEX IF NOT EXISTS idx_options_trip ON options (trip_id);

    CREATE TABLE IF NOT EXISTS pros_cons (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      option_id  INTEGER NOT NULL,
      kind       TEXT    NOT NULL CHECK (kind IN ('pro', 'con')),
      text       TEXT    NOT NULL,
      created_by INTEGER NOT NULL,
      created_at TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pros_cons_option ON pros_cons (option_id);

    CREATE TABLE IF NOT EXISTS votes (
      option_id INTEGER NOT NULL,
      user_id   INTEGER NOT NULL,
      value     TEXT    NOT NULL CHECK (value IN ('up', 'veto')),
      PRIMARY KEY (option_id, user_id, value)
    );
    CREATE INDEX IF NOT EXISTS idx_votes_user ON votes (user_id);

    -- Per-trip plugin settings: the price-per-person divisor (NULL = number of trip
    -- members) and whether a cost write already failed because the Costs addon is off.
    CREATE TABLE IF NOT EXISTS trip_settings (
      trip_id           INTEGER PRIMARY KEY,
      divisor           INTEGER,
      costs_unavailable INTEGER NOT NULL DEFAULT 0
    );
  `],
  // Phase 2: which plugin option sits at which index of the posted collab poll, and
  // the language last used on the trip (for host-rendered marker/warning/badge text,
  // which reaches the plugin without a locale).
  // One ALTER per migration: SQLite has no ADD COLUMN IF NOT EXISTS, so each step must
  // be re-runnable on its own (see migrate()).
  ['002_poll_option_ids', 'ALTER TABLE decisions ADD COLUMN poll_option_ids TEXT'],
  ['003_trip_locale', 'ALTER TABLE trip_settings ADD COLUMN locale TEXT'],
]

/**
 * The host records a migration id once it succeeded, but `trek-plugin dev` only keeps
 * them in memory, so after a restart an ADD COLUMN would run again. A column that is
 * already there means the step is done.
 */
async function migrate(db) {
  for (const [id, sql] of MIGRATIONS) {
    try {
      await db.migrate(id, sql)
    } catch (e) {
      if (!/duplicate column name/i.test(String(e && e.message))) throw e
    }
  }
}

module.exports = { MIGRATIONS, migrate }
