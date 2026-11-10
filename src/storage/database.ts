import { createRequire } from "node:module";
import { dirname } from "node:path";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import initSqlJs, { type Database as SqlDatabase, type SqlValue } from "sql.js";

const require = createRequire(import.meta.url);

export class LocalDatabase {
  private transactionActive = false;
  private constructor(
    private readonly database: SqlDatabase,
    private readonly filePath: string,
  ) {}

  static async open(filePath: string): Promise<LocalDatabase> {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
    const sql = await initSqlJs({
      locateFile: (file) => require.resolve(`sql.js/dist/${file}`),
    });
    let bytes: Uint8Array | undefined;
    try {
      bytes = await readFile(filePath);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
    }

    const database = bytes ? new sql.Database(bytes) : new sql.Database();
    database.run("PRAGMA foreign_keys = ON");
    database.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS account_profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        user_label TEXT,
        project_id TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS account_profiles_project_id ON account_profiles(project_id);
      CREATE TABLE IF NOT EXISTS api_credentials (
        id TEXT PRIMARY KEY,
        account_profile_id TEXT NOT NULL REFERENCES account_profiles(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL,
        secret_reference TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );
      CREATE INDEX IF NOT EXISTS api_credentials_project_id ON api_credentials(project_id);
      CREATE TABLE IF NOT EXISTS project_health (
        project_id TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        cooldown_until TEXT,
        last_error_category TEXT,
        last_success_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, model)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_metadata (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        model_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS session_events (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_operations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        tool_name TEXT NOT NULL,
        status TEXT NOT NULL,
        idempotent INTEGER NOT NULL,
        input_json TEXT NOT NULL,
        result_json TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );
    `);
    const localDatabase = new LocalDatabase(database, filePath);
    await localDatabase.persist();
    return localDatabase;
  }

  query<T extends object>(sql: string, params: SqlValue[] = []): T[] {
    const statement = this.database.prepare(sql, params);
    const rows: T[] = [];
    try {
      while (statement.step()) rows.push(statement.getAsObject() as T);
      return rows;
    } finally {
      statement.free();
    }
  }

  queryOne<T extends object>(
    sql: string,
    params: SqlValue[] = [],
  ): T | undefined {
    return this.query<T>(sql, params)[0];
  }

  async execute(sql: string, params: SqlValue[] = []): Promise<void> {
    this.database.run(sql, params);
    if (!this.transactionActive) await this.persist();
  }

  async transaction<T>(
    operation: (database: LocalDatabase) => T | Promise<T>,
  ): Promise<T> {
    this.database.run("BEGIN IMMEDIATE");
    this.transactionActive = true;
    let committed = false;
    try {
      const result = await operation(this);
      this.database.run("COMMIT");
      committed = true;
      this.transactionActive = false;
      await this.persist();
      return result;
    } catch (error) {
      if (!committed) {
        this.database.run("ROLLBACK");
        this.transactionActive = false;
      }
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  private async persist(): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp-${process.pid}`;
    try {
      await writeFile(temporaryPath, this.database.export(), { mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
