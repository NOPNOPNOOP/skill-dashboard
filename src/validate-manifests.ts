#!/usr/bin/env bun
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { discoverCanonicalSkills, getDefaultAgentRoots } from "./discovery.ts";
import { validateSkillManifest3Tier } from "./manifest-cli.ts";

function main() {
  const homeDir = homedir();
  const activeWorkspace = process.cwd();
  const dataDir = join(homeDir, ".claude/skill-dashboard/data");
  const lockfiles = [
    join(homeDir, ".agents/.skill-lock.json"),
    join(homeDir, "skills-lock.json"),
  ];

  const { skills, brokenMounts } = discoverCanonicalSkills({
    agentRoots: getDefaultAgentRoots(homeDir, activeWorkspace),
    lockfiles,
    dataDir,
    activeWorkspace,
    homeDir,
  });

  console.log("======================================================================");
  console.log("🔍 Skill Dashboard — 3-Tier Companion Manifest & Ecosystem Health Audit");
  console.log("======================================================================");
  console.log(`Total Canonical Skills Discovered : ${skills.length}`);
  console.log(`Skills in ~/.agents/skills Hub    : ${skills.filter((s) => s.inAgentsHub).length}`);
  console.log(`Skills Mounted in Claude Code     : ${skills.filter((s) => s.mounts.some((m) => m.agent === "claude")).length}`);
  console.log(`Broken Symlinks Detected          : ${brokenMounts.length}`);

  const companionSkills = skills.filter((s) => s.layers.companion);
  console.log(`Skills with .dashboard/manifest   : ${companionSkills.length} (${companionSkills.map((s) => s.id).join(", ")})`);
  console.log("----------------------------------------------------------------------");

  let errors = 0;
  for (const s of companionSkills) {
    const issues = validateSkillManifest3Tier(s);
    const errs = issues.filter((i) => i.severity === "error");
    const warns = issues.filter((i) => i.severity === "warn");
    errors += errs.length;

    const actCount = s.manifest.actionGroups.reduce((a, g) => a + g.actions.length, 0);
    const modCount = s.layers.moduleFiles?.length || 1;
    if (errs.length === 0 && warns.length === 0) {
      console.log(
        `✅ [${s.id.padEnd(20)}] Valid! (${modCount} module files, ${s.manifest.actionGroups.length} groups, ${actCount} actions, ${s.manifest.views.length} views, ${s.manifest.data.length} data nodes)`
      );
    } else {
      console.log(
        `${errs.length > 0 ? "❌" : "⚠️ "} [${s.id.padEnd(20)}] ${errs.length} error(s), ${warns.length} warning(s):`
      );
      for (const iss of issues) {
        console.log(
          `   [${iss.level}] (${iss.file}${iss.symbolId ? ` -> ${iss.symbolId}` : ""}): ${iss.message}`
        );
        if (iss.fixHint) console.log(`      💡 Fix: ${iss.fixHint}`);
      }
    }
  }

  const unconfiguredWithScripts = skills.filter(
    (s) =>
      !s.layers.companion &&
      (existsSync(join(s.canonicalPath, "scripts")) || existsSync(join(s.canonicalPath, "tools")))
  );
  if (unconfiguredWithScripts.length > 0) {
    console.log("----------------------------------------------------------------------");
    console.log(
      `💡 Skills with scripts/tools ready for Studio Manifest: ${unconfiguredWithScripts.map((s) => s.id).join(", ")}`
    );
  }

  if (errors > 0) {
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
