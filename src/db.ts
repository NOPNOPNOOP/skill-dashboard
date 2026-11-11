import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { normalizeStoredArtifacts } from "./artifacts.ts";
import type { ExecutionRun, RunArtifact, RunStatus, UnitEvent } from "./types.ts";

export class DashboardDatabase {
  public db: Database;
  public dataDir: string;
  public logsDir: string;
  public closed = false;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.logsDir = join(dataDir, "logs");
    mkdirSync(this.logsDir, { recursive: true });

    const dbPath = join(dataDir, "dashboard.db");
    this.db = new Database(dbPath);
    this.db.run("PRAGMA journal_mode = WAL;");
    this.initSchema();
  }

  private initSchema() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        action_title TEXT NOT NULL,
        status TEXT NOT NULL,
        command TEXT NOT NULL,
        masked_command TEXT NOT NULL,
        cwd TEXT NOT NULL,
        pid INTEGER,
        exit_code INTEGER,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        duration_ms INTEGER,
        params_json TEXT NOT NULL,
        log_path TEXT NOT NULL,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        interactive INTEGER NOT NULL DEFAULT 0
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS ix_runs_skill_started ON runs(skill_id, started_at DESC)
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS unit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        unit_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE INDEX IF NOT EXISTS ix_unit_events_unit_id ON unit_events(unit_id, id DESC)
    `);
  }

  public reconcileStaleRuns(): number {
    const runningRows = this.db
      .query("SELECT id, pid, started_at, log_path FROM runs WHERE status = 'running'")
      .all() as Array<{ id: string; pid: number | null; started_at: number; log_path: string }>;

    let reconciled = 0;
    const now = Date.now();
    for (const row of runningRows) {
      let alive = false;
      if (row.pid && row.pid > 0) {
        try {
          process.kill(row.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (!alive) {
        this.db
          .prepare(
            `UPDATE runs
             SET status = 'interrupted',
                 finished_at = $now,
                 duration_ms = $duration
             WHERE id = $id`
          )
          .run({
            $id: row.id,
            $now: now,
            $duration: Math.max(0, now - row.started_at),
          });
        if (existsSync(row.log_path)) {
          try {
            appendFileSync(
              row.log_path,
              "\r\n\x1b[?1049l\x1b[0m\x1b[33m[Dashboard Reconciled: Process terminated while server was offline]\x1b[0m\r\n"
            );
          } catch {
            // ignore
          }
        }
        reconciled++;
      }
    }
    return reconciled;
  }

  public insertRun(run: ExecutionRun): void {
    this.db
      .prepare(
        `INSERT INTO runs (
          id, skill_id, action_id, action_title, status, command, masked_command,
          cwd, pid, exit_code, started_at, finished_at, duration_ms,
          params_json, log_path, artifacts_json, interactive
        ) VALUES (
          $id, $skillId, $actionId, $actionTitle, $status, $command, $maskedCommand,
          $cwd, $pid, $exitCode, $startedAt, $finishedAt, $durationMs,
          $paramsJson, $logPath, $artifactsJson, $interactive
        )`
      )
      .run({
        $id: run.id,
        $skillId: run.skillId,
        $actionId: run.actionId,
        $actionTitle: run.actionTitle,
        $status: run.status,
        $command: run.command,
        $maskedCommand: run.maskedCommand,
        $cwd: run.cwd,
        $pid: run.pid,
        $exitCode: run.exitCode,
        $startedAt: run.startedAt,
        $finishedAt: run.finishedAt,
        $durationMs: run.durationMs,
        $paramsJson: run.paramsJson,
        $logPath: run.logPath,
        $artifactsJson: JSON.stringify(run.artifacts || []),
        $interactive: run.interactive ? 1 : 0,
      });
  }

  public updateRunCompletion(params: {
    id: string;
    status: RunStatus;
    exitCode: number | null;
    finishedAt: number;
    durationMs: number;
    artifacts: Array<string | RunArtifact>;
  }): void {
    if (this.closed) return;
    this.db
      .prepare(
        `UPDATE runs
         SET status = $status,
             exit_code = $exitCode,
             finished_at = $finishedAt,
             duration_ms = $durationMs,
             artifacts_json = $artifactsJson
         WHERE id = $id`
      )
      .run({
        $id: params.id,
        $status: params.status,
        $exitCode: params.exitCode,
        $finishedAt: params.finishedAt,
        $durationMs: params.durationMs,
        $artifactsJson: JSON.stringify(params.artifacts),
      });
  }

  public updateRunPid(id: string, pid: number): void {
    this.db.prepare("UPDATE runs SET pid = $pid WHERE id = $id").run({ $id: id, $pid: pid });
  }

  public getRun(id: string): ExecutionRun | null {
    const row = this.db.query("SELECT * FROM runs WHERE id = $id").get({ $id: id }) as any;
    return row ? this.mapRow(row) : null;
  }

  public listRuns(skillId?: string, limit = 40): ExecutionRun[] {
    const rows = skillId
      ? (this.db
          .query("SELECT * FROM runs WHERE skill_id = $skillId ORDER BY started_at DESC LIMIT $limit")
          .all({ $skillId: skillId, $limit: limit }) as any[])
      : (this.db
          .query("SELECT * FROM runs ORDER BY started_at DESC LIMIT $limit")
          .all({ $limit: limit }) as any[]);
    return rows.map((r) => this.mapRow(r));
  }

  public deleteRun(id: string): void {
    const row = this.db.query("SELECT log_path FROM runs WHERE id = $id").get({ $id: id }) as any;
    if (row?.log_path && existsSync(row.log_path)) {
      try {
        rmSync(row.log_path, { force: true });
      } catch {
        // ignore
      }
    }
    this.db.prepare("DELETE FROM runs WHERE id = $id").run({ $id: id });
  }

  public pruneOldRuns(maxRuns = 200): number {
    const oldRows = this.db
      .query(
        `SELECT id, log_path FROM runs
         WHERE status != 'running'
         ORDER BY started_at DESC
         LIMIT -1 OFFSET $offset`
      )
      .all({ $offset: maxRuns }) as Array<{ id: string; log_path: string }>;

    for (const r of oldRows) {
      if (existsSync(r.log_path)) {
        try {
          rmSync(r.log_path, { force: true });
        } catch {
          // ignore
        }
      }
      this.db.prepare("DELETE FROM runs WHERE id = $id").run({ $id: r.id });
    }
    return oldRows.length;
  }

  public getSetting(key: string): string | null {
    const row = this.db.query("SELECT value FROM settings WHERE key = $key").get({ $key: key }) as any;
    return row ? row.value : null;
  }

  public setSetting(key: string, value: string): void {
    this.db
      .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ($key, $value)")
      .run({ $key: key, $value: value });
  }

  public getSkillWorkspace(skillId: string): string | null {
    return this.getSetting(`skill_workspace:${skillId}`);
  }

  public setSkillWorkspace(skillId: string, workspacePath: string): void {
    this.setSetting(`skill_workspace:${skillId}`, workspacePath);
  }

  public getSkillEnv(skillId: string): Record<string, string> {
    const raw = this.getSetting(`skill_env:${skillId}`);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  public setSkillEnv(skillId: string, env: Record<string, string>): void {
    this.setSetting(`skill_env:${skillId}`, JSON.stringify(env));
  }

  public insertUnitEvent(params: {
    unitId: string;
    eventType: "run_completed" | "decision_submitted";
    payload: Record<string, unknown>;
  }): UnitEvent {
    const createdAt = Date.now();
    const res = this.db
      .prepare(
        `INSERT INTO unit_events (unit_id, event_type, payload_json, created_at)
         VALUES ($unitId, $eventType, $payloadJson, $createdAt)`
      )
      .run({
        $unitId: params.unitId,
        $eventType: params.eventType,
        $payloadJson: JSON.stringify(params.payload || {}),
        $createdAt: createdAt,
      });
    return {
      id: Number(res.lastInsertRowid),
      unitId: params.unitId,
      eventType: params.eventType,
      payload: params.payload || {},
      createdAt,
    };
  }

  public listUnitEvents(params: {
    unitId: string;
    sinceId?: number;
    sinceTs?: number;
    limit?: number;
  }): UnitEvent[] {
    const limit = params.limit || 20;
    const rows =
      params.sinceId !== undefined && params.sinceId > 0
        ? (this.db
            .query(
              `SELECT * FROM unit_events
               WHERE unit_id = $unitId AND id > $sinceId
               ORDER BY id ASC LIMIT $limit`
            )
            .all({ $unitId: params.unitId, $sinceId: params.sinceId, $limit: limit }) as any[])
        : params.sinceTs !== undefined && params.sinceTs > 0
          ? (this.db
              .query(
                `SELECT * FROM unit_events
                 WHERE unit_id = $unitId AND created_at > $sinceTs
                 ORDER BY id ASC LIMIT $limit`
              )
              .all({ $unitId: params.unitId, $sinceTs: params.sinceTs, $limit: limit }) as any[])
          : (this.db
              .query(
                `SELECT * FROM unit_events
                 WHERE unit_id = $unitId
                 ORDER BY id DESC LIMIT $limit`
              )
              .all({ $unitId: params.unitId, $limit: limit }) as any[]);

    return rows.map((r) => {
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(r.payload_json || "{}");
      } catch {}
      return {
        id: Number(r.id),
        unitId: String(r.unit_id),
        eventType: r.event_type as "run_completed" | "decision_submitted",
        payload,
        createdAt: Number(r.created_at),
      };
    });
  }

  private mapRow(row: any): ExecutionRun {
    let rawArtifacts: unknown = [];
    try {
      rawArtifacts = JSON.parse(row.artifacts_json || "[]");
    } catch {
      rawArtifacts = [];
    }
    const normalized = normalizeStoredArtifacts(rawArtifacts);
    return {
      id: row.id,
      skillId: row.skill_id,
      actionId: row.action_id,
      actionTitle: row.action_title,
      status: row.status as RunStatus,
      command: row.command,
      maskedCommand: row.masked_command,
      cwd: row.cwd,
      pid: row.pid,
      exitCode: row.exit_code,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      paramsJson: row.params_json,
      logPath: row.log_path,
      artifacts: Array.isArray(rawArtifacts) && rawArtifacts.length > 0 ? (rawArtifacts as any) : normalized.paths,
      artifactItems: normalized.items,
      interactive: Boolean(row.interactive),
    };
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
