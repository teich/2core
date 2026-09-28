import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL, result TEXT);`);
  }
  get(key, fallback = null) {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  set(key, value) {
    this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value));
  }
  event(kind, data) {
    this.db.prepare('INSERT INTO events(at,kind,data) VALUES (?,?,?)').run(new Date().toISOString(), kind, JSON.stringify(data));
    this.db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 1000)');
  }
  events() {
    return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 50').all().map(e => ({ ...e, data: JSON.parse(e.data) }));
  }
  command(id) { return this.db.prepare('SELECT * FROM commands WHERE id=?').get(id); }
  begin(id, fingerprint) { this.db.prepare('INSERT INTO commands VALUES (?,?,?,NULL)').run(id, fingerprint, 'pending'); }
  finish(id, state, result) { this.db.prepare('UPDATE commands SET state=?,result=? WHERE id=?').run(state, JSON.stringify(result), id); }
  close() { this.db.close(); }
}
