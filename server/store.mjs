import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT);
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, kind TEXT NOT NULL, body TEXT NOT NULL, acceptedAt TEXT NOT NULL, deadline TEXT NOT NULL, phase TEXT NOT NULL);`);
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value));
  }
  // Every setting whose key starts with prefix, keyed by the rest of the key.
  prefixed(prefix) {
    const rows = this.db
      .prepare('SELECT key, value FROM settings WHERE substr(key, 1, ?) = ?')
      .all(prefix.length, prefix);
    return Object.fromEntries(rows.map(row => [row.key.slice(prefix.length), JSON.parse(row.value)]));
  }
  event(kind, data) {
    this.db
      .prepare('INSERT INTO events(at,kind,data) VALUES (?,?,?)')
      .run(new Date().toISOString(), kind, JSON.stringify(data));
    this.db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 1000)');
  }
  events() {
    return this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT 50')
      .all()
      .map(e => ({ ...e, data: JSON.parse(e.data) }));
  }
  command(id) {
    return this.db.prepare('SELECT * FROM commands WHERE id=?').get(id);
  }
  begin(id, fingerprint) {
    this.db.prepare('INSERT INTO commands VALUES (?,?,?,NULL)').run(id, fingerprint, 'pending');
  }
  acceptCommand(id, fingerprint, kind, body, deadline, acceptedAt) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.begin(id, fingerprint);
      this.db
        .prepare('INSERT INTO operations VALUES (?,?,?,?,?,?)')
        .run(id, kind, JSON.stringify(body), acceptedAt, deadline, 'queued');
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  phase(id, phase) {
    this.db.prepare('UPDATE operations SET phase=? WHERE id=?').run(phase, id);
  }
  operation(id) {
    const row = this.db
      .prepare('SELECT o.*, c.state, c.result FROM operations o JOIN commands c USING(id) WHERE id=?')
      .get(id);
    return row ? { ...row, body: JSON.parse(row.body), result: row.result ? JSON.parse(row.result) : null } : null;
  }
  operations() {
    return this.db
      .prepare(
        "SELECT o.id FROM operations o JOIN commands c USING(id) ORDER BY (c.state='pending') DESC, o.rowid DESC LIMIT 50",
      )
      .all()
      .map(row => this.operation(row.id));
  }
  interruptPending() {
    const result = JSON.stringify({
      error: 'Server restarted before confirmation; outcome may be unknown. Refresh and inspect before a new request.',
    });
    this.db.prepare("UPDATE commands SET state='failed', result=? WHERE state='pending'").run(result);
    this.db.exec("UPDATE operations SET phase='failed' WHERE id IN (SELECT id FROM commands WHERE state='failed')");
  }
  finish(id, state, result) {
    this.db.prepare('UPDATE commands SET state=?,result=? WHERE id=?').run(state, JSON.stringify(result), id);
  }
  close() {
    this.db.close();
  }
}
