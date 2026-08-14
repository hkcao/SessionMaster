import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Session } from "@session-master/core";

export class LocalStore {
  readonly #db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, backend_id TEXT NOT NULL, native_session_id TEXT,
        title TEXT, project_name TEXT, cwd TEXT, created_at TEXT, updated_at TEXT,
        status TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS continuations (
        child_session_id TEXT PRIMARY KEY, parent_session_id TEXT NOT NULL,
        continued_from_backend TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_search ON sessions(title, project_name, cwd);
    `);
  }

  upsertSessions(sessions: Session[]): void {
    const statement = this.#db.prepare(`
      INSERT INTO sessions (id, backend_id, native_session_id, title, project_name, cwd, created_at, updated_at, status, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, project_name=excluded.project_name,
        cwd=excluded.cwd, updated_at=excluded.updated_at, status=excluded.status, metadata_json=excluded.metadata_json
    `);
    this.#db.exec("BEGIN");
    try {
      for (const session of sessions) statement.run(session.id, session.backendId, session.nativeSessionId ?? null, session.title ?? null, session.projectName ?? null, session.cwd ?? null, session.createdAt ?? null, session.updatedAt ?? null, session.status, JSON.stringify(session.metadata ?? {}));
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  recordContinuation(childId: string, parentId: string, backendId: string): void {
    this.#db.prepare("INSERT OR REPLACE INTO continuations VALUES (?, ?, ?, ?)").run(childId, parentId, backendId, new Date().toISOString());
  }
}
