import type { ServerWebSocket } from "bun";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join, resolve } from "path";
import { extractRunArtifacts } from "./artifacts.ts";
import type { DashboardDatabase } from "./db.ts";
import { shellEscape } from "./interpolator.ts";
import type { ArtifactRule, ExecutionRun, RunArtifact, RunStatus } from "./types.ts";

export interface WsClientData {
  runId: string;
  offset: number;
}

interface ActiveRunSession {
  run: ExecutionRun;
  proc: ReturnType<typeof Bun.spawn>;
  subscribers: Set<ServerWebSocket<WsClientData>>;
  byteOffset: number;
  usedAltScreen: boolean;
  closedAltScreen: boolean;
  detectedArtifacts: Set<string>;
  cancelled: boolean;
  tempZdotDir?: string;
  tempScriptPath?: string;
}

export function writeIsolatedShellScript(
  command: string,
  runId?: string,
  scriptsDir?: string
): string {
  const id = runId || `ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const targetDir = scriptsDir || tmpdir();
  mkdirSync(targetDir, { recursive: true });
  const scriptPath = join(targetDir, `sd-script-${id}.sh`);
  const hasShebang = command.trimStart().startsWith("#!");
  const content = hasShebang
    ? command + "\n"
    : `#!/bin/zsh\nset -e\n${command}\n`;
  writeFileSync(scriptPath, content, { encoding: "utf-8", mode: 0o755 });
  return scriptPath;
}

function findWorkspaceVenvDir(workspacePath: string): string | null {
  let curr = resolve(workspacePath);
  for (let i = 0; i < 4; i++) {
    const venvDir = join(curr, ".venv");
    if (existsSync(join(venvDir, "bin/python"))) {
      return venvDir;
    }
    const parent = dirname(curr);
    if (parent === curr) break;
    curr = parent;
  }
  return null;
}

function createInteractiveZdotDir(params: {
  cwd: string;
  skillDir: string;
  env?: Record<string, string>;
}): string {
  const zdot = mkdtempSync(join(tmpdir(), "skill-dashboard-zsh-"));
  const venvDir = findWorkspaceVenvDir(params.cwd);
  const envExports = Object.entries(params.env || {})
    .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
    .join("\n");

  const zshrcContent = `
export DISABLE_AUTO_UPDATE="true"
if [ -f "$HOME/.zshrc" ]; then
  source "$HOME/.zshrc"
fi
export SKILL_DIR=${shellEscape(params.skillDir)}
export PROJECT_ROOT=${shellEscape(params.cwd)}
${envExports}
${venvDir ? `export VIRTUAL_ENV=${shellEscape(venvDir)}\nexport PATH="${venvDir}/bin:$PATH"` : ""}
`.trim();

  writeFileSync(join(zdot, ".zshrc"), zshrcContent + "\n", "utf-8");
  return zdot;
}

export class RunExecutionManager {
  private db: DashboardDatabase;
  private sessions = new Map<string, ActiveRunSession>();
  private runtimeScriptsDir?: string;

  constructor(db: DashboardDatabase, runtimeScriptsDir?: string) {
    this.db = db;
    this.runtimeScriptsDir = runtimeScriptsDir;
  }

  public allocateRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  public startPtyRun(params: {
    runId?: string;
    skillId: string;
    skillDir?: string;
    actionId: string;
    actionTitle: string;
    command: string;
    maskedCommand: string;
    cwd: string;
    env?: Record<string, string>;
    maskedParams: Record<string, unknown>;
    interactive?: boolean;
    isInteractiveShell?: boolean;
    keepShellOpen?: boolean;
    declaredArtifacts?: string[];
    artifactRules?: ArtifactRule[];
    runArtifactsDir?: string;
    interpolateArtifactPath?: (tpl: string) => string;
    cols?: number;
    rows?: number;
    onCompleted?: (info: { run: ExecutionRun; rawStdout: string; artifactItems: RunArtifact[] }) => void;
  }): ExecutionRun {
    const runId = params.runId || this.allocateRunId();
    const logPath = join(this.db.logsDir, `${runId}.log`);
    writeFileSync(logPath, "");

    let tempZdotDir: string | undefined;
    if (params.isInteractiveShell || params.keepShellOpen) {
      tempZdotDir = createInteractiveZdotDir({
        cwd: params.cwd,
        skillDir: params.skillDir || params.cwd,
        env: params.env,
      });
    }

    const startedAt = Date.now();
    const isInteractive = Boolean(params.interactive || params.isInteractiveShell || params.keepShellOpen);
    const run: ExecutionRun = {
      id: runId,
      skillId: params.skillId,
      actionId: params.actionId,
      actionTitle: params.actionTitle,
      status: "running",
      command: params.command,
      maskedCommand: params.maskedCommand,
      cwd: params.cwd,
      pid: null,
      exitCode: null,
      startedAt,
      finishedAt: null,
      durationMs: null,
      paramsJson: JSON.stringify(params.maskedParams),
      logPath,
      artifacts: [...(params.declaredArtifacts || [])],
      interactive: isInteractive,
    };

    const bannerLine = `\x1b[90m$ cd ${params.cwd} && ${params.maskedCommand}\x1b[0m\r\n`;
    appendFileSync(logPath, bannerLine);
    const initialBytes = Buffer.byteLength(bannerLine, "utf-8");

    const isMultiLineScript = params.command.includes("\n");
    let tempScriptPath: string | undefined;
    if (!params.isInteractiveShell && isMultiLineScript) {
      tempScriptPath = writeIsolatedShellScript(params.command, runId, this.runtimeScriptsDir);
    }

    const session: ActiveRunSession = {
      run,
      proc: null as any,
      subscribers: new Set(),
      byteOffset: initialBytes,
      usedAltScreen: false,
      closedAltScreen: false,
      detectedArtifacts: new Set(params.declaredArtifacts || []),
      cancelled: false,
      tempZdotDir,
      tempScriptPath,
    };

    const decoder = new TextDecoder();
    const cols = params.cols || 120;
    const rows = params.rows || 34;

    const effectiveCommand = tempScriptPath
      ? `/bin/zsh ${shellEscape(tempScriptPath)}`
      : params.command;

    const spawnArgs = params.isInteractiveShell
      ? ["/bin/zsh", "-i"]
      : params.keepShellOpen
        ? ["/bin/zsh", "-c", `${effectiveCommand}; exec /bin/zsh -i`]
        : tempScriptPath
          ? ["/bin/zsh", tempScriptPath]
          : ["/bin/zsh", "-c", params.command];

    const venvDir = findWorkspaceVenvDir(params.cwd);
    const basePath = process.env.PATH || "/usr/local/bin:/usr/bin:/bin";

    const proc = Bun.spawn(spawnArgs, {
      cwd: params.cwd,
      env: {
        ...process.env,
        LANG: process.env.LANG || "en_US.UTF-8",
        LC_ALL: process.env.LC_ALL || "en_US.UTF-8",
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        FORCE_COLOR: "1",
        PYTHONUNBUFFERED: "1",
        SKILL_DIR: params.skillDir || params.cwd,
        PROJECT_ROOT: params.cwd,
        ...(venvDir
          ? {
              VIRTUAL_ENV: venvDir,
              PATH: `${venvDir}/bin:${basePath}`,
            }
          : {}),
        ...(tempZdotDir ? { ZDOTDIR: tempZdotDir } : {}),
        ...(params.env || {}),
      },
      terminal: {
        cols,
        rows,
        data: (_term, chunk) => {
          // Use { stream: true } so multi-byte UTF-8 sequences (like box-drawing ─ U+2500) split across chunks never corrupt into U+FFFD ()
          const text = decoder.decode(chunk, { stream: true });
          if (text.includes("\x1b[?1049h")) session.usedAltScreen = true;
          if (text.includes("\x1b[?1049l")) session.closedAltScreen = true;

          try {
            appendFileSync(logPath, Buffer.from(chunk));
          } catch {
            // ignore write error
          }
          session.byteOffset += chunk.byteLength;

          const msg = JSON.stringify({
            type: "output",
            runId,
            data: text,
            offset: session.byteOffset,
          });
          for (const ws of session.subscribers) {
            try {
              ws.send(msg);
            } catch {
              // ignore closed socket
            }
          }
        },
      },
    });

    run.pid = proc.pid;
    session.proc = proc;
    this.sessions.set(runId, session);
    this.db.insertRun(run);

    proc.exited.then((exitCode) => {
      try {
        proc.terminal?.close();
      } catch {
        // ignore
      }
      if (session.tempZdotDir) {
        try {
          rmSync(session.tempZdotDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      }
      if (session.tempScriptPath) {
        try {
          rmSync(session.tempScriptPath, { force: true });
        } catch {
          // ignore
        }
      }
      const finishedAt = Date.now();
      const durationMs = Math.max(0, finishedAt - startedAt);
      const status: RunStatus = session.cancelled
        ? "cancelled"
        : exitCode === 0
          ? "completed"
          : "failed";

      // Sanitize alternate screen buffer if left open
      if (session.usedAltScreen && !session.closedAltScreen) {
        const resetSeq = "\x1b[?1049l\x1b[0m\x1b[?25h";
        try {
          appendFileSync(logPath, resetSeq);
          session.byteOffset += Buffer.byteLength(resetSeq);
        } catch {
          // ignore
        }
      }

      const footerColor = status === "completed" ? "\x1b[32m" : status === "cancelled" ? "\x1b[33m" : "\x1b[31m";
      const footerLine = `\r\n${footerColor}[Process ${status.toUpperCase()} — exit code ${exitCode ?? "null"} in ${(durationMs / 1000).toFixed(2)}s]\x1b[0m\r\n`;
      try {
        appendFileSync(logPath, footerLine);
        session.byteOffset += Buffer.byteLength(footerLine);
      } catch {
        // ignore
      }

      let rawStdout = "";
      if (existsSync(logPath)) {
        try {
          const rawLog = readFileSync(logPath, "utf-8");
          rawStdout = rawLog
            .replace(/^\x1b\[90m\$ cd .*?\x1b\[0m\r?\n/, "")
            .replace(/\r?\n\x1b\[\d+m\[Process .*?\]\x1b\[0m\r?\n?$/, "")
            .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
        } catch {}
      }

      const extractedItems = extractRunArtifacts({
        rules: params.artifactRules || (params.declaredArtifacts as ArtifactRule[] | undefined),
        rawStdout,
        cwd: params.cwd,
        runArtifactsDir: params.runArtifactsDir,
        startedAt,
        interpolatePath: params.interpolateArtifactPath,
      });

      const mergedPaths = new Set<string>(
        extractedItems.map((it) => it.path).concat([...session.detectedArtifacts])
      );
      const finalArtifactItems: RunArtifact[] = [...extractedItems];
      for (const p of mergedPaths) {
        if (!finalArtifactItems.some((it) => it.path === p)) {
          let sz = 0;
          try {
            if (existsSync(p)) sz = statSync(p).size;
          } catch {}
          finalArtifactItems.push({
            label: p.split("/").pop() || p,
            path: p,
            filename: p.split("/").pop() || p,
            kind: p.endsWith(".html") ? "html" : p.endsWith(".json") ? "json" : "file",
            sizeBytes: sz,
            onComplete: "badge",
          });
        }
      }

      run.status = status;
      run.exitCode = exitCode;
      run.finishedAt = finishedAt;
      run.durationMs = durationMs;
      run.artifacts = finalArtifactItems.length > 0 ? finalArtifactItems : [...mergedPaths];
      run.artifactItems = finalArtifactItems;

      this.db.updateRunCompletion({
        id: runId,
        status,
        exitCode,
        finishedAt,
        durationMs,
        artifacts: run.artifacts,
      });

      const exitOutputMsg = JSON.stringify({
        type: "output",
        runId,
        data: footerLine,
        offset: session.byteOffset,
      });
      const statusMsg = JSON.stringify({
        type: "status",
        runId,
        status,
        exitCode,
        durationMs,
        artifacts: run.artifacts,
        artifactItems: finalArtifactItems,
      });

      for (const ws of session.subscribers) {
        try {
          ws.send(exitOutputMsg);
          ws.send(statusMsg);
        } catch {
          // ignore
        }
      }

      if (params.onCompleted) {
        try {
          params.onCompleted({ run, rawStdout, artifactItems: finalArtifactItems });
        } catch {
          // ignore callback errors
        }
      }

      this.sessions.delete(runId);
    });

    return run;
  }

  public attachClient(ws: ServerWebSocket<WsClientData>): void {
    const { runId, offset = 0 } = ws.data;
    const run = this.sessions.get(runId)?.run || this.db.getRun(runId);
    if (!run) {
      ws.send(JSON.stringify({ type: "error", message: `Run ${runId} not found` }));
      ws.close();
      return;
    }

    // Tier 2 Disk Replay from offset
    if (existsSync(run.logPath)) {
      try {
        const st = statSync(run.logPath);
        if (st.size > offset) {
          const buf = readFileSync(run.logPath);
          const slice = offset > 0 ? buf.subarray(offset) : buf;
          const text = new TextDecoder().decode(slice);
          ws.send(
            JSON.stringify({
              type: "replay",
              runId,
              data: text,
              nextOffset: buf.byteLength,
            })
          );
        }
      } catch {
        // ignore
      }
    }

    const active = this.sessions.get(runId);
    if (active) {
      active.subscribers.add(ws);
      ws.send(
        JSON.stringify({
          type: "status",
          runId,
          status: "running",
          exitCode: null,
          durationMs: Date.now() - active.run.startedAt,
          artifacts: [...active.detectedArtifacts],
        })
      );
    } else {
      ws.send(
        JSON.stringify({
          type: "status",
          runId,
          status: run.status,
          exitCode: run.exitCode,
          durationMs: run.durationMs || 0,
          artifacts: run.artifacts,
        })
      );
    }
  }

  public detachClient(ws: ServerWebSocket<WsClientData>): void {
    const active = this.sessions.get(ws.data.runId);
    if (active) {
      active.subscribers.delete(ws);
    }
  }

  public handleClientMessage(ws: ServerWebSocket<WsClientData>, rawMessage: string): void {
    const active = this.sessions.get(ws.data.runId);
    if (!active) return;
    try {
      const msg = JSON.parse(rawMessage);
      if (msg.type === "input" && typeof msg.data === "string") {
        active.proc.terminal?.write(msg.data);
      } else if (
        msg.type === "resize" &&
        typeof msg.cols === "number" &&
        typeof msg.rows === "number"
      ) {
        active.proc.terminal?.resize(Math.max(20, msg.cols), Math.max(5, msg.rows));
      }
    } catch {
      // ignore invalid JSON
    }
  }

  public async stopRun(runId: string): Promise<{ stopped: boolean; status: RunStatus }> {
    const active = this.sessions.get(runId);
    if (!active) {
      const dbRun = this.db.getRun(runId);
      return { stopped: false, status: dbRun?.status || "cancelled" };
    }

    active.cancelled = true;
    const pid = active.run.pid;
    if (pid && pid > 0) {
      try {
        // Because Bun PTY calls setsid(), pid === pgid. Negative PID kills the entire process group!
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already exited
        }
      }

      // Escalate to SIGKILL if still running after 600ms
      setTimeout(() => {
        if (this.sessions.has(runId)) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // ignore
            }
          }
        }
      }, 600);
    }

    return { stopped: true, status: "cancelled" };
  }

  public async stopAllActiveRuns(): Promise<void> {
    const activeList = [...this.sessions.values()];
    await Promise.all(activeList.map((s) => this.stopRun(s.run.id)));
    await Promise.allSettled(
      activeList.map((s) =>
        Promise.race([
          s.proc.exited,
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ])
      )
    );
  }
}

export function buildAppleScriptTerminalCommand(params: {
  command: string;
  cwd: string;
  terminalApp?: "Terminal" | "iTerm";
}): string {
  let execTarget = params.command;
  if (params.command.includes("\n")) {
    const scriptPath = writeIsolatedShellScript(params.command);
    execTarget = `/bin/zsh ${shellEscape(scriptPath)}`;
  }
  const fullShellCmd = `cd ${JSON.stringify(params.cwd)} && ${execTarget}`;
  const escapedForAppleScript = fullShellCmd.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  if (params.terminalApp === "iTerm") {
    return `
      tell application "iTerm"
        activate
        if (count of windows) = 0 then
          create window with default profile
        end if
        tell current window
          create tab with default profile
          tell current session
            write text "${escapedForAppleScript}"
          end tell
        end tell
      end tell
    `.trim();
  }
  return `
    tell application "Terminal"
      activate
      do script "${escapedForAppleScript}"
    end tell
  `.trim();
}

export async function launchExternalMacTerminal(params: {
  command: string;
  cwd: string;
  terminalApp?: "Terminal" | "iTerm";
}): Promise<{ launched: boolean; appleScript: string }> {
  const appleScript = buildAppleScriptTerminalCommand(params);
  if (process.platform === "darwin") {
    Bun.spawn(["osascript", "-e", appleScript], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return { launched: true, appleScript };
  }
  return { launched: false, appleScript };
}
