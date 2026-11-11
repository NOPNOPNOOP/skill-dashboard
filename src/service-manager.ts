#!/usr/bin/env bun
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import { ensureDashboardDirectories, resolveDashboardPaths } from "./paths.ts";

const LABEL = "com.local.skill-dashboard";
const HOME = homedir();
const PATHS = resolveDashboardPaths({ homeDir: HOME });
ensureDashboardDirectories(PATHS);
const PLIST_DIR = join(HOME, "Library/LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const LOG_PATH = PATHS.daemonLogPath;

function buildPlistXml(port: number, workspace: string): string {
  const bunBin = process.execPath;
  const cliScript = resolve(import.meta.dir, "cli.ts");
  const pathEnv = process.env.PATH || "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunBin}</string>
    <string>${cliScript}</string>
    <string>--port</string>
    <string>${port}</string>
    <string>--workspace</string>
    <string>${workspace}</string>
    <string>--no-open</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${resolve(import.meta.dir, "..")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>LANG</key>
    <string>en_US.UTF-8</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
</dict>
</plist>
`;
}

async function getStatus(port: number) {
  const plistExists = existsSync(PLIST_PATH);
  let healthOk = false;
  let activeWs = "";
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(500),
    });
    if (res.ok) {
      const d = (await res.json()) as any;
      healthOk = d?.app === "skill-dashboard";
      activeWs = d?.activeWorkspace || "";
    }
  } catch {
    healthOk = false;
  }

  const dbPath = PATHS.dbPath;
  const dbSizeKb = existsSync(dbPath) ? (statSync(dbPath).size / 1024).toFixed(1) : "0.0";

  console.log(`Server Listening (127.0.0.1:${port}) : ${healthOk ? "\x1b[32mONLINE\x1b[0m" : "\x1b[31mOFFLINE\x1b[0m"}`);
  console.log(`macOS LaunchAgent (${LABEL}) : ${plistExists ? "\x1b[32mINSTALLED (Auto Keep-Alive)\x1b[0m" : "\x1b[33mNOT INSTALLED (Manual Mode)\x1b[0m"}`);
  console.log(`SQLite Index (dashboard.db)       : ${dbSizeKb} KB (${dbPath})`);
  console.log(`XDG Config / Cache                : ${PATHS.configDir} | ${PATHS.cacheDir}`);
  if (activeWs) {
    console.log(`Default Bound Workspace           : ${activeWs}`);
  }
}

async function main() {
  const action = process.argv[2] || "status";
  const port = Number(process.env.PORT || "8766");
  const workspace =
    process.argv[3] || process.env.SD_DEFAULT_WORKSPACE || process.cwd();

  if (action === "status") {
    await getStatus(port);
    return;
  }

  if (action === "install") {
    mkdirSync(PLIST_DIR, { recursive: true });
    const xml = buildPlistXml(port, workspace);
    writeFileSync(PLIST_PATH, xml, "utf-8");

    // Unload existing if any, then load
    Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
    const loadRes = Bun.spawnSync(["launchctl", "load", "-w", PLIST_PATH]);
    if (loadRes.exitCode === 0) {
      console.log(`✅ Installed and started macOS Keep-Alive LaunchAgent at ${PLIST_PATH}`);
    } else {
      console.log(`⚠️ Written plist to ${PLIST_PATH}, launchctl exited with ${loadRes.exitCode}`);
    }
    await new Promise((r) => setTimeout(r, 400));
    await getStatus(port);
    return;
  }

  if (action === "restart") {
    mkdirSync(PLIST_DIR, { recursive: true });
    const xml = buildPlistXml(port, workspace);
    writeFileSync(PLIST_PATH, xml, "utf-8");
    Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
    Bun.spawnSync(["launchctl", "load", "-w", PLIST_PATH]);
    console.log(`🔄 Restarted macOS Keep-Alive LaunchAgent (${LABEL}) on port ${port}`);
    await new Promise((r) => setTimeout(r, 400));
    await getStatus(port);
    return;
  }

  if (action === "uninstall") {
    if (existsSync(PLIST_PATH)) {
      Bun.spawnSync(["launchctl", "unload", PLIST_PATH]);
      rmSync(PLIST_PATH, { force: true });
      console.log(`✅ Uninstalled LaunchAgent ${PLIST_PATH}`);
    } else {
      console.log(`LaunchAgent ${PLIST_PATH} is not installed.`);
    }
    return;
  }
}

if (import.meta.main) {
  main();
}
