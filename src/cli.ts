#!/usr/bin/env bun
import { existsSync } from "fs";
import { join, resolve } from "path";
import { buildFrontendBundle } from "./build-ui.ts";
import { createDashboardServer } from "./server.ts";

async function findAvailableOrExistingInstance(preferredPort: number): Promise<{
  reuseUrl?: string;
  port: number;
}> {
  for (let p = preferredPort; p < preferredPort + 20; p++) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/api/health`, {
        signal: AbortSignal.timeout(400),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        if (data?.app === "skill-dashboard") {
          return { reuseUrl: `http://127.0.0.1:${p}`, port: p };
        }
      }
      // Port is occupied by another service; try next port
    } catch {
      // Nothing listening on this port — available!
      return { port: p };
    }
  }
  return { port: 0 };
}

async function main() {
  const args = process.argv.slice(2);
  let preferredPort = Number(process.env.PORT || "8766");
  let defaultWorkspace: string | undefined;
  let noOpen = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) {
      preferredPort = Number(args[++i]);
    } else if (a === "--workspace" && args[i + 1]) {
      defaultWorkspace = resolve(args[++i]);
    } else if (a === "--no-open") {
      noOpen = true;
    }
  }

  const distIndex = join(import.meta.dir, "../dist/index.html");
  if (!existsSync(distIndex)) {
    await buildFrontendBundle();
  }

  const probe = await findAvailableOrExistingInstance(preferredPort);
  if (probe.reuseUrl) {
    console.log(`⚡ Skill Dashboard is already running at ${probe.reuseUrl}`);
    if (!noOpen && process.platform === "darwin") {
      Bun.spawn(["open", probe.reuseUrl]);
    }
    return;
  }

  const instance = createDashboardServer({
    port: probe.port,
    defaultWorkspace,
  });

  const bootRes = await fetch(`${instance.url}/api/bootstrap`);
  const boot = (await bootRes.json()) as any;

  console.log(`\n⚡ Skill Dashboard Studio v1.0.0`);
  console.log(`✔ Discovered ${boot.skills?.length || 0} canonical skills (${boot.brokenMounts?.length || 0} broken mounts)`);
  console.log(`✔ Active Workspace: ${boot.activeWorkspace}`);
  console.log(`✔ Python Runtime:   ${boot.pythonExecutable}`);
  console.log(`🚀 Listening at:    ${instance.url}\n`);

  if (!noOpen && process.platform === "darwin") {
    Bun.spawn(["open", instance.url]);
  }

  const shutdown = async () => {
    console.log("\nShutting down Skill Dashboard...");
    await instance.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.main) {
  main();
}
