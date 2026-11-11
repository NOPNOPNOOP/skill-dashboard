import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, relative, resolve } from "path";
import YAML from "yaml";
import {
  type ActionGroup,
  type ActionItem,
  type ConfigLayerStatus,
  type FormField,
  type ManifestSymbolProvenance,
  type PartialSkillManifest,
  type SkillEnvVar,
  type SkillManifest,
  SkillManifestSchema,
  type SkillView,
} from "./types.ts";

export function inferFormAndTemplateFromSynopsis(rawCmd: string): {
  commandTemplate: string;
  form: FormField[];
  danger: "safe" | "warn" | "danger";
  requiresHumanApprovalFlag?: string;
  interactive: boolean;
} {
  let cmd = rawCmd.trim();
  const form: FormField[] = [];
  const usedKeys = new Set<string>();

  const uniqueKey = (raw: string) => {
    const base = raw.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^_+|_+$/g, "") || "arg";
    let candidate = base;
    let idx = 2;
    while (usedKeys.has(candidate)) {
      candidate = `${base}_${idx++}`;
    }
    usedKeys.add(candidate);
    return candidate;
  };

  let requiresHumanApprovalFlag: string | undefined;
  if (cmd.includes("--human-approved")) {
    requiresHumanApprovalFlag = "--human-approved";
    cmd = cmd.replace(/\s*--human-approved\b/g, "");
  }

  // Normalize python interpreter & skill directory references
  cmd = cmd.replace(
    /^python3?\s+(?:~\/\.agents\/skills\/[^/\s]+\/|local\/)/,
    "{{python}} {{skill_dir}}/"
  );
  cmd = cmd.replace(/^python3?\b/, "{{python}}");
  cmd = cmd.replace(/~\/\.agents\/skills\/[^/\s]+/g, "{{skill_dir}}");

  // Skip CLI synopsis placeholder extraction for inline script strings (e.g. python -c '...')
  if (/\s-c\s+['"]/.test(cmd)) {
    return {
      commandTemplate: cmd,
      form: [],
      danger: "safe",
      requiresHumanApprovalFlag,
      interactive: false,
    };
  }

  // 1. --flag {a|b|c} or [--flag {a|b|c}]
  cmd = cmd.replace(/(\[\s*)?(--[a-zA-Z0-9_-]+)\s+\{([^}]+)\}(\s*\])?/g, (_match, optOpen, flag, choicesRaw) => {
    const key = uniqueKey(flag.replace(/^--+/, ""));
    const choices = choicesRaw.split("|").map((s: string) => s.trim()).filter(Boolean);
    form.push({
      key,
      label: flag,
      type: "select",
      flag,
      required: !optOpen,
      default: choices[0],
      options: choices.map((c: string) => ({ label: c, value: c })),
    });
    return `{{form.${key}}}`;
  });

  // 2. [--flag <placeholder>] or --flag <placeholder> or [-o <placeholder>]
  cmd = cmd.replace(/(\[\s*)?(-{1,2}[a-zA-Z0-9_-]+)\s+<([^>]+)>(\s*\])?/g, (_match, optOpen, flag, ph) => {
    const key = uniqueKey(flag.replace(/^-+/, ""));
    const isFile = /\.(xlsx|xls|pdf|json|csv|yaml|yml|md|py|sh|txt|zip)/i.test(ph) || /file|path|snapshot/i.test(key);
    const isDir = /dir|folder|workspace/i.test(key);
    form.push({
      key,
      label: `${flag} (${ph})`,
      type: isDir ? "directory" : isFile ? "file" : "text",
      flag,
      placeholder: ph,
      required: !optOpen,
    });
    return `{{form.${key}}}`;
  });

  // 3. [--flag EXAMPLE_VAL] or [-o snapshot.json]
  cmd = cmd.replace(/\[\s*(-{1,2}[a-zA-Z0-9_-]+)\s+([^\][\s]+)\s*\]/g, (_match, flag, exampleVal) => {
    const key = uniqueKey(flag.replace(/^-+/, ""));
    const cleanedVal = exampleVal.replace(/^["']|["']$/g, "");
    const isNum = /^\d+$/.test(cleanedVal);
    const isFile = /\.(xlsx|xls|pdf|json|csv|yaml|yml|md|py|sh)/i.test(cleanedVal);
    form.push({
      key,
      label: flag,
      type: isNum ? "number" : isFile ? "file" : "text",
      flag,
      placeholder: cleanedVal,
      default: isNum ? Number(cleanedVal) : undefined,
      required: false,
    });
    return `{{form.${key}}}`;
  });

  // 4. Optional boolean flags [--dry-run]
  cmd = cmd.replace(/\[\s*(--[a-zA-Z0-9_-]+)\s*\]/g, (_match, flag) => {
    const key = uniqueKey(flag.replace(/^--+/, ""));
    form.push({
      key,
      label: flag,
      type: "boolean",
      flag,
      default: flag === "--dry-run",
    });
    return `{{form.${key}}}`;
  });

  // 5. [COMMAND] or [subcommand] or [target]
  cmd = cmd.replace(/\[\s*([A-Za-z0-9_|-]+)\s*\]/g, (_match, token) => {
    const key = uniqueKey(token.toLowerCase());
    if (token.includes("|")) {
      const opts = token.split("|").map((s: string) => s.trim());
      form.push({
        key,
        label: "Subcommand",
        type: "select",
        positional: true,
        default: opts[0],
        options: opts.map((o: string) => ({ label: o, value: o })),
      });
    } else {
      form.push({
        key,
        label: token,
        type: "text",
        positional: true,
        placeholder: token,
        required: false,
      });
    }
    return `{{form.${key}}}`;
  });

  // 6. Positional <arg>
  cmd = cmd.replace(/<([^>]+)>/g, (_match, ph) => {
    const key = uniqueKey(ph);
    const isFile = /\.(xlsx|xls|pdf|json|csv|yaml|yml|md|py|sh)/i.test(ph);
    form.push({
      key,
      label: ph,
      type: isFile ? "file" : "text",
      positional: true,
      placeholder: ph,
      required: true,
    });
    return `{{form.${key}}}`;
  });

  const unquotedForRisk = rawCmd
    .replace(/'\s*[\[{][\s\S]*?[\]}]\s*'/g, "''")
    .replace(/"\s*[\[{][\s\S]*?[\]}]\s*"/g, '""');
  const isDanger = /purge|clear-all|drop|delete|destroy|\bprod\b/i.test(unquotedForRisk);
  const isWarn = Boolean(requiresHumanApprovalFlag) || /sync|push|restore|clear|seed|bind|import/i.test(unquotedForRisk);
  const interactive = /\btui\b|switch_roles\.py\s*$/i.test(rawCmd);

  return {
    commandTemplate: rawCmd.includes("\n") ? cmd.trim() : cmd.replace(/\s+/g, " ").trim(),
    form,
    danger: isDanger ? "danger" : isWarn ? "warn" : "safe",
    requiresHumanApprovalFlag,
    interactive,
  };
}

export interface ParsedBashStatement {
  command: string;
  comment: string;
  isMultiLine: boolean;
}

/**
 * Aggregates raw lines inside a fenced bash block into complete shell statements,
 * merging trailing backslash continuations (`\`), unclosed single/double quotes
 * across lines (e.g. `curl ... -d '{\n...\n}'`), and heredocs (`<<EOF ... EOF`).
 */
export function splitBashBlockIntoStatements(lines: string[]): ParsedBashStatement[] {
  const statements: ParsedBashStatement[] = [];
  let pendingComment = "";
  let currentLines: string[] = [];
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let heredocDelim: string | null = null;

  const updateQuoteState = (line: string) => {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\" && !inSingleQuote) {
        i++; // skip escaped char
        continue;
      }
      if (ch === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
      } else if (ch === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
      } else if (ch === "#" && !inSingleQuote && !inDoubleQuote && (i === 0 || /\s/.test(line[i - 1]))) {
        // Inline comment starts outside quotes; ignore rest of line for quote tracking
        break;
      }
    }
  };

  const hasTrailingContinuation = (line: string): boolean => {
    const trimmedRight = line.trimEnd();
    if (!trimmedRight.endsWith("\\")) return false;
    // Count trailing backslashes to ensure it's an odd number (unescaped)
    let count = 0;
    for (let i = trimmedRight.length - 1; i >= 0 && trimmedRight[i] === "\\"; i--) {
      count++;
    }
    return count % 2 === 1;
  };

  const isStandaloneOutputFragment = (fullCmd: string): boolean => {
    const firstToken = fullCmd.split(/\s+/)[0] || "";
    return (
      /^[{[\]}]/.test(firstToken) ||
      (/^["']/.test(firstToken) && !fullCmd.includes("=") && !fullCmd.includes("/"))
    );
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (currentLines.length === 0) {
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) {
        const commentBody = trimmed.replace(/^#+\s*/, "").trim();
        if (!commentBody.startsWith("⚠️") && !commentBody.toLowerCase().startsWith("or ")) {
          pendingComment = commentBody.replace(/^\d+\.\s*/, "");
        }
        continue;
      }
    }

    currentLines.push(rawLine);

    if (heredocDelim) {
      if (trimmed === heredocDelim) {
        heredocDelim = null;
      }
    } else {
      updateQuoteState(rawLine);
      if (!inSingleQuote && !inDoubleQuote) {
        const hdMatch = rawLine.match(/(?:^|[^<])<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
        if (hdMatch) {
          heredocDelim = hdMatch[1];
        }
      }
    }

    const continuesNextLine =
      Boolean(heredocDelim) || inSingleQuote || inDoubleQuote || hasTrailingContinuation(rawLine);

    if (!continuesNextLine) {
      const fullCmd = currentLines.join("\n").trim();
      if (fullCmd && !isStandaloneOutputFragment(fullCmd)) {
        statements.push({
          command: fullCmd,
          comment: pendingComment,
          isMultiLine: currentLines.length > 1,
        });
      }
      currentLines = [];
      pendingComment = "";
      inSingleQuote = false;
      inDoubleQuote = false;
      heredocDelim = null;
    }
  }

  // Flush any trailing unclosed statement
  if (currentLines.length > 0) {
    const fullCmd = currentLines.join("\n").trim();
    if (fullCmd && !isStandaloneOutputFragment(fullCmd)) {
      statements.push({
        command: fullCmd,
        comment: pendingComment,
        isMultiLine: currentLines.length > 1,
      });
    }
  }

  return statements;
}

export function normalizeGroupSubgroups(group: ActionGroup): ActionGroup {
  if (group.subgroups && group.subgroups.length > 0) {
    // Also collect all subgroup actions into group.actions if group.actions is empty so flat consumers work seamlessly
    const flatActions =
      group.actions && group.actions.length > 0
        ? group.actions
        : group.subgroups.flatMap((sg) =>
            sg.actions.map((a) => ({ ...a, subgroup: a.subgroup || sg.name }))
          );
    return {
      ...group,
      actions: flatActions,
      subgroups: group.subgroups.map((sg) => ({
        ...sg,
        actions: sg.actions.map((a) => ({ ...a, subgroup: a.subgroup || sg.name })),
      })),
    };
  }

  // Build subgroups from action.subgroup if present
  const hasExplicitSubgroup = (group.actions || []).some((a) => Boolean(a.subgroup));
  if (!hasExplicitSubgroup) {
    return {
      ...group,
      actions: group.actions || [],
    };
  }

  const subMap = new Map<string, ActionItem[]>();
  for (const act of group.actions || []) {
    const sgName = act.subgroup || "General";
    const list = subMap.get(sgName) || [];
    list.push({ ...act, subgroup: sgName });
    subMap.set(sgName, list);
  }

  const subgroups: ActionGroup[] = [];
  for (const [sgName, acts] of subMap.entries()) {
    subgroups.push({
      name: sgName,
      actions: acts,
    });
  }

  return {
    ...group,
    subgroups,
    actions: (group.actions || []).map((a) => ({ ...a, subgroup: a.subgroup || "General" })),
  };
}

function parseFrontmatter(md: string): { frontmatter: Record<string, any>; body: string } {
  const match = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: md };
  try {
    const parsed = YAML.parse(match[1]);
    return {
      frontmatter: parsed && typeof parsed === "object" ? parsed : {},
      body: match[2] || "",
    };
  } catch {
    return { frontmatter: {}, body: match[2] || md };
  }
}

function guessCategory(id: string, description: string, body: string): string {
  const text = `${id} ${description} ${body.slice(0, 500)}`.toLowerCase();
  if (/vsip|database|postgres|migration|etl|excel|data/.test(text)) return "Data & Platform";
  if (/review|refactor|test|tdd|qa|bug|security/.test(text)) return "Quality & Review";
  if (/obsidian|markdown|writing|article|canvas|knap|defuddle/.test(text)) return "Knowledge & Docs";
  if (/orca|worktree|terminal|computer|crabbox|orchestrat|loop|dashboard/.test(text)) return "Agent & Automation";
  if (/design|ui|dataviz|artifact|diagram/.test(text)) return "Design & Visualization";
  return "Engineering Tools";
}

export function inferSemanticTags(
  skillId: string,
  description: string,
  mdBody: string,
  canonicalPath: string
): string[] {
  const tags = new Set<string>();
  const text = `${skillId} ${description} ${mdBody.slice(0, 1200)}`.toLowerCase();

  // Domain & Technology keywords
  const rules: Array<[RegExp, string]> = [
    [/\b(vsip)\b/, "vsip"],
    [/\b(python|pytest|py|uv|fastapi|pydantic)\b/, "python"],
    [/\b(typescript|ts|bun|node|npx|javascript|react)\b/, "typescript"],
    [/\b(git|worktree|branch|commit|merge|rebase|pr)\b/, "git"],
    [/\b(database|postgres|sql|sqlite|alembic|migration)\b/, "database"],
    [/\b(excel|xlsx|csv|spreadsheet|etl)\b/, "excel"],
    [/\b(review|refactor|audit|lint|quality)\b/, "code-review"],
    [/\b(test|tdd|qa|debug|diagnos|bug)\b/, "testing"],
    [/\b(obsidian|vault|wikilink|canvas|knap|defuddle)\b/, "obsidian"],
    [/\b(writing|article|prose|beat|fragment|markdown|doc|prd|issue|triage)\b/, "docs-writing"],
    [/\b(orca|terminal|tty|pty|otty|zellij|tmux|shell)\b/, "terminal"],
    [/\b(agent|orchestrat|subagent|handoff|worker|dag|claude|codex)\b/, "multi-agent"],
    [/\b(architecture|domain|ubiq|interface|adr|rfc|design)\b/, "architecture"],
    [/\b(ui|ux|chart|dataviz|svg|image|html|browser|gui)\b/, "ui-visual"],
    [/\b(tui|prompt_toolkit|interactive)\b/, "tui"],
    [/\b(k8s|kubernetes|kubectl|pod|uat|prod|aws|s3)\b/, "devops-cloud"],
  ];

  for (const [regex, tag] of rules) {
    if (regex.test(text)) tags.add(tag);
  }

  // Structural tags
  if (existsSync(join(canonicalPath, "scripts")) || existsSync(join(canonicalPath, "tools"))) {
    tags.add("has-scripts");
  }
  if (existsSync(join(canonicalPath, "references"))) {
    tags.add("has-references");
  }
  if (existsSync(join(canonicalPath, ".dashboard/manifest.yaml"))) {
    tags.add("studio-ready");
  }

  return [...tags].slice(0, 7);
}

export function parseZeroConfigSkill(skillId: string, canonicalPath: string): SkillManifest {
  let name = skillId;
  let description = `Local skill located at ${basename(canonicalPath)}`;
  let icon: string | undefined;
  let banner: string | undefined;
  let defaultPrompt: string | undefined;
  const tags = new Set<string>();
  const views: SkillView[] = [];
  const envVarsMap = new Map<string, SkillEnvVar>();
  const actionGroupsMap = new Map<string, ActionItem[]>();

  // 1. Check Codex agents/openai.yaml if present
  const openAiYamlPath = join(canonicalPath, "agents/openai.yaml");
  if (existsSync(openAiYamlPath)) {
    try {
      const parsed = YAML.parse(readFileSync(openAiYamlPath, "utf-8"));
      const iface = parsed?.interface;
      if (iface) {
        if (iface.display_name) name = String(iface.display_name);
        if (iface.short_description) description = String(iface.short_description);
        if (iface.icon_small) icon = String(iface.icon_small);
        if (iface.icon_large) banner = String(iface.icon_large);
        if (iface.default_prompt) defaultPrompt = String(iface.default_prompt);
        tags.add("codex-native");
      }
    } catch {
      // ignore malformed yaml
    }
  }

  // 2. Check SKILL.md / skill.md / README.md
  const entryCandidates = ["SKILL.md", "skill.md", "README.md"];
  let entryFile: string | undefined;
  for (const c of entryCandidates) {
    if (existsSync(join(canonicalPath, c))) {
      entryFile = c;
      break;
    }
  }

  let mdBody = "";
  if (entryFile) {
    const rawMd = readFileSync(join(canonicalPath, entryFile), "utf-8");
    const { frontmatter, body } = parseFrontmatter(rawMd);
    mdBody = body;

    if (frontmatter.name && name === skillId) name = String(frontmatter.name);
    if (frontmatter.description) description = String(frontmatter.description).trim();
    if (Array.isArray(frontmatter.tags)) {
      for (const t of frontmatter.tags) tags.add(String(t));
    }

    views.push({
      id: "overview",
      title: "Overview (SKILL.md)",
      type: "markdown",
      source: entryFile,
    });

    // Extract environment variable declarations (e.g. export FOO=bar or FOO_BAR_KEY)
    for (const m of body.matchAll(/\bexport\s+([A-Z][A-Z0-9_]{2,})=([^\s`"\n]*)/g)) {
      const envKey = m[1];
      const defVal = m[2]?.replace(/^['"]|['"]$/g, "") || "";
      if (!envVarsMap.has(envKey)) {
        envVarsMap.set(envKey, {
          key: envKey,
          label: envKey,
          default: defVal && !defVal.startsWith("<") ? defVal : undefined,
          placeholder: defVal || undefined,
          secret: /SECRET|TOKEN|PASSWORD|KEY/i.test(envKey),
        });
      }
    }

    // Extract reference markdown links from body
    const seenSources = new Set<string>([entryFile]);
    for (const m of body.matchAll(/\[([^\]]+)\]\(((?:\.\/)?[a-zA-Z0-9_./-]+\.md)\)/g)) {
      const linkTitle = m[1].replace(/`/g, "").trim();
      const relSource = m[2].replace(/^\.\//, "");
      if (!seenSources.has(relSource) && existsSync(join(canonicalPath, relSource))) {
        seenSources.add(relSource);
        views.push({
          id: relSource.replace(/[^a-zA-Z0-9_-]/g, "-"),
          title: linkTitle || basename(relSource, ".md"),
          type: "markdown",
          source: relSource,
        });
      }
    }

    // Extract bash / sh fenced blocks into Multi-Level ActionGroups (H2/H3 -> H4/Subgroup)
    const lines = body.split(/\r?\n/);
    let currentH2 = "Quick Actions";
    let currentH3 = "";
    let currentH4 = "";
    let inBash = false;
    let bashBuf: string[] = [];
    let actionCounter = 1;

    for (const line of lines) {
      if (!inBash && line.startsWith("## ")) {
        currentH2 = line.slice(3).replace(/`/g, "").trim();
        currentH3 = "";
        currentH4 = "";
      } else if (!inBash && line.startsWith("### ")) {
        currentH3 = line.slice(4).replace(/`/g, "").trim();
        currentH4 = "";
      } else if (!inBash && line.startsWith("#### ")) {
        currentH4 = line.slice(5).replace(/`/g, "").trim();
      } else if (!inBash && /^```(bash|sh|zsh)\b/i.test(line.trim())) {
        inBash = true;
        bashBuf = [];
      } else if (inBash && line.trim().startsWith("```")) {
        inBash = false;
        const groupName = currentH3 || currentH2 || "Commands";
        const subgroupName = currentH4 || (currentH3 ? currentH2 : undefined);
        const statements = splitBashBlockIntoStatements(bashBuf);
        for (const stmt of statements) {
          const firstLine = stmt.command.split(/\r?\n/)[0].trim();
          const firstLineClean = firstLine.replace(/\s*\\\s*$/, "").replace(/\s+#\s+.*$/, "");
          const inlineCommentMatch = !stmt.isMultiLine ? stmt.command.match(/\s+#\s+(.*)$/) : null;
          const cmdForSynopsis = stmt.isMultiLine
            ? stmt.command
            : stmt.command.replace(/\s+#\s+.*$/, "");

          const titleHint =
            stmt.comment ||
            (inlineCommentMatch ? inlineCommentMatch[1].trim() : "") ||
            firstLineClean
              .replace(/^(python3?|uv run|bun|npx|sh|bash)\s+/, "")
              .replace(/^~\/\.agents\/skills\/[^/]+\/(tools|scripts)\//, "")
              .slice(0, 56);

          // Only run brackets/flag form synopsis extraction on single-line commands so multi-line JSON arrays/payloads are untouched
          const unquotedMulti = stmt.command
            .replace(/'\s*[\[{][\s\S]*?[\]}]\s*'/g, "''")
            .replace(/"\s*[\[{][\s\S]*?[\]}]\s*"/g, '""');
          const multiApprovalMatch = unquotedMulti.match(
            /\s+(--(?:human-approved|confirm-destroy|yes|force))\b/
          );
          const multiCleanCmd = multiApprovalMatch
            ? stmt.command.replace(multiApprovalMatch[0], "")
            : stmt.command;
          const inferred = stmt.isMultiLine
            ? {
                commandTemplate: multiCleanCmd,
                form: [] as FormField[],
                danger: (/purge|clear-all|drop|delete|destroy|\bprod\b/i.test(unquotedMulti)
                  ? "danger"
                  : Boolean(multiApprovalMatch) ||
                      /sync|push|restore|clear|seed|bind|import/i.test(unquotedMulti)
                    ? "warn"
                    : "safe") as "safe" | "warn" | "danger",
                requiresHumanApprovalFlag: multiApprovalMatch?.[1],
                interactive: /\btui\b|switch_roles\.py\s*$/i.test(unquotedMulti),
              }
            : inferFormAndTemplateFromSynopsis(cmdForSynopsis);

          const list = actionGroupsMap.get(groupName) || [];
          list.push({
            id: `cmd-${actionCounter++}`,
            title: titleHint,
            subgroup: subgroupName,
            description: firstLineClean,
            danger: inferred.danger,
            requiresHumanApprovalFlag: inferred.requiresHumanApprovalFlag,
            interactive: inferred.interactive,
            defaultRunner: "web_terminal",
            cwd: "project_root",
            command: inferred.commandTemplate,
            form: inferred.form.length > 0 ? inferred.form : undefined,
          });
          actionGroupsMap.set(groupName, list);
        }
      } else if (inBash) {
        bashBuf.push(line);
      }
    }
  }

  // 3. Scan scripts/ or tools/ if no bash commands were extracted
  if (actionGroupsMap.size === 0) {
    for (const subDir of ["scripts", "tools"]) {
      const fullSub = join(canonicalPath, subDir);
      if (existsSync(fullSub) && statSync(fullSub).isDirectory()) {
        const scriptActions: ActionItem[] = [];
        for (const f of readdirSync(fullSub)) {
          if (f.startsWith(".") || f.startsWith("__")) continue;
          const ext = extname(f);
          if ([".py", ".sh", ".ts", ".js"].includes(ext)) {
            const runner = ext === ".py" ? "{{python}}" : ext === ".sh" ? "bash" : "bun";
            scriptActions.push({
              id: `script-${f.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
              title: `Run ${f}`,
              subgroup: subDir,
              description: `${subDir}/${f}`,
              danger: "safe",
              defaultRunner: "web_terminal",
              cwd: "project_root",
              command: `${runner} {{skill_dir}}/${subDir}/${f} {{form.args}}`,
              form: [
                {
                  key: "args",
                  label: "Arguments",
                  type: "text",
                  positional: true,
                  placeholder: "--help",
                },
              ],
            });
          }
        }
        if (scriptActions.length > 0) {
          actionGroupsMap.set("Scripts & Tools", scriptActions);
        }
      }
    }
  }

  // 4. Always provide a Default Agent Invocation action if still empty
  if (actionGroupsMap.size === 0) {
    actionGroupsMap.set("Agent Invocation", [
      {
        id: "invoke-skill",
        title: `Invoke /${skillId} Skill`,
        subgroup: "Prompt Handoff",
        description: defaultPrompt || `Copy or run /${skillId} prompt in your coding agent`,
        danger: "safe",
        defaultRunner: "copy_agent_prompt",
        cwd: "project_root",
        command: defaultPrompt || `/${skillId} {{form.prompt}}`,
        form: [
          {
            key: "prompt",
            label: "Task / Arguments",
            type: "text",
            positional: true,
            placeholder: "Describe what to do with this skill...",
          },
        ],
      },
    ]);
  }

  const category = guessCategory(skillId, description, mdBody);
  for (const st of inferSemanticTags(skillId, description, mdBody, canonicalPath)) {
    tags.add(st);
  }
  if (tags.size === 0) {
    tags.add(category.toLowerCase().split(/\s+/)[0]);
  }

  const actionGroups: ActionGroup[] = [];
  for (const [grpName, actions] of actionGroupsMap.entries()) {
    actionGroups.push(normalizeGroupSubgroups({ name: grpName, actions }));
  }

  return {
    id: skillId,
    name,
    category,
    description,
    icon,
    banner,
    envVars: [...envVarsMap.values()],
    context: [],
    data: [],
    tags: [...tags],
    defaultPrompt: defaultPrompt || `/${skillId}`,
    views,
    actionGroups,
  };
}

function resolveIncludeFilePaths(baseDir: string, spec: string, dashboardRoot?: string): string[] {
  const full = resolve(baseDir, spec);
  const rootAllowed = dashboardRoot ? resolve(dashboardRoot) : resolve(baseDir);
  const isInside = (p: string) => {
    const abs = resolve(p);
    return abs === rootAllowed || abs.startsWith(rootAllowed + "/");
  };
  if (!spec.includes("*")) {
    return isInside(full) && existsSync(full) && statSync(full).isFile() ? [full] : [];
  }
  const dir = dirname(full);
  const pat = basename(full);
  if (!isInside(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) return [];
  const rx = new RegExp(
    "^" +
      pat
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
    "i"
  );
  return readdirSync(dir)
    .filter((f) => !f.startsWith(".") && rx.test(f))
    .sort()
    .map((f) => join(dir, f))
    .filter((p) => isInside(p) && statSync(p).isFile());
}

function resolveDefsRefs(obj: any, defs: Record<string, any>): any {
  if (Array.isArray(obj)) return obj.map((item) => resolveDefsRefs(item, defs));
  if (obj && typeof obj === "object") {
    if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/defs/")) {
      const defKey = obj.$ref.slice("#/defs/".length);
      const base = defs[defKey] || {};
      const rest = { ...obj };
      delete rest.$ref;
      return resolveDefsRefs({ ...base, ...rest }, defs);
    }
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = resolveDefsRefs(v, defs);
    }
    return out;
  }
  return obj;
}

function expandArrayLevelIncludes(
  items: any[] | undefined,
  baseDir: string,
  dashboardDir: string,
  provenanceList: string[],
  visitedFiles: Set<string>,
  onFileItem?: (item: any, relFile: string) => void
): any[] {
  if (!Array.isArray(items)) return [];
  const out: any[] = [];
  for (const item of items) {
    if (item && typeof item === "object" && typeof item.$include === "string") {
      const targetFiles = resolveIncludeFilePaths(baseDir, item.$include, dashboardDir);
      for (const tf of targetFiles) {
        const relFile = relative(dashboardDir, tf);
        if (!provenanceList.includes(relFile)) provenanceList.push(relFile);
        if (visitedFiles.has(tf)) continue;
        visitedFiles.add(tf);
        try {
          const parsed = tf.endsWith(".json")
            ? JSON.parse(readFileSync(tf, "utf-8"))
            : YAML.parse(readFileSync(tf, "utf-8"));
          const subItems = Array.isArray(parsed) ? parsed : [parsed];
          for (const sub of subItems) {
            if (sub && typeof sub === "object") {
              onFileItem?.(sub, relFile);
              out.push(sub);
            }
          }
        } catch {
          // ignore invalid include fragment
        }
      }
    } else {
      out.push(item);
    }
  }
  return out;
}
export function loadAndLinkManifestFile(
  filePath: string,
  dashboardRoot?: string
): {
  manifest: PartialSkillManifest | null;
  rawParsed: any;
  provenance: ManifestSymbolProvenance;
} {
  const rootDir = dashboardRoot || dirname(filePath);
  const provenance: ManifestSymbolProvenance = {
    moduleFiles: [],
    defs: {},
    context: {},
    data: {},
    actions: {},
    views: {},
    contextSource: {},
    dataSource: {},
    actionSource: {},
    viewSource: {},
  };
  if (!existsSync(filePath)) {
    return { manifest: null, rawParsed: null, provenance };
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const rootParsed = (filePath.endsWith(".json") ? JSON.parse(raw) : YAML.parse(raw)) || {};
    const rootRel = relative(rootDir, filePath) || basename(filePath);
    provenance.moduleFiles.push(rootRel);

    const defs: Record<string, any> = {};
    const mergedContext: any[] = [];
    const mergedData: any[] = [];
    const mergedViews: any[] = [];
    const mergedGroups = new Map<string, any>();
    const visitedIncludes = new Set<string>([resolve(filePath)]);

    const ingestModuleObject = (modObj: any, modFilePath: string) => {
      if (!modObj || typeof modObj !== "object") return;
      const modDir = dirname(modFilePath);
      const relFile = relative(rootDir, modFilePath) || basename(modFilePath);
      if (!provenance.moduleFiles.includes(relFile)) {
        provenance.moduleFiles.push(relFile);
      }

      if (modObj.defs && typeof modObj.defs === "object") {
        for (const [dk, dv] of Object.entries(modObj.defs)) {
          defs[dk] = dv;
          provenance.defs[dk] = relFile;
        }
      }

      if (Array.isArray(modObj.includes)) {
        for (const incSpec of modObj.includes) {
          if (typeof incSpec !== "string") continue;
          for (const incFile of resolveIncludeFilePaths(modDir, incSpec, rootDir)) {
            const absInc = resolve(incFile);
            if (visitedIncludes.has(absInc)) continue;
            visitedIncludes.add(absInc);
            try {
              const incParsed = incFile.endsWith(".json")
                ? JSON.parse(readFileSync(incFile, "utf-8"))
                : YAML.parse(readFileSync(incFile, "utf-8"));
              ingestModuleObject(incParsed, incFile);
            } catch {
              // ignore malformed module
            }
          }
        }
      }

      const ctxItems = expandArrayLevelIncludes(
        modObj.context,
        modDir,
        rootDir,
        provenance.moduleFiles,
        visitedIncludes,
        (it, rf) => {
          if (it?.key) {
            provenance.contextSource[it.key] = rf;
            provenance.context[it.key] = rf;
          }
        }
      );
      for (const c of ctxItems) {
        if (c?.key && !provenance.contextSource[c.key]) {
          provenance.contextSource[c.key] = relFile;
          provenance.context[c.key] = relFile;
        }
        mergedContext.push(c);
      }

      const dataItems = expandArrayLevelIncludes(
        modObj.data,
        modDir,
        rootDir,
        provenance.moduleFiles,
        visitedIncludes,
        (it, rf) => {
          if (it?.id) {
            provenance.dataSource[it.id] = rf;
            provenance.data[it.id] = rf;
          }
        }
      );
      for (const d of dataItems) {
        if (d?.id && !provenance.dataSource[d.id]) {
          provenance.dataSource[d.id] = relFile;
          provenance.data[d.id] = relFile;
        }
        mergedData.push(d);
      }

      const viewItems = expandArrayLevelIncludes(
        modObj.views,
        modDir,
        rootDir,
        provenance.moduleFiles,
        visitedIncludes,
        (it, rf) => {
          if (it?.id) {
            provenance.viewSource[it.id] = rf;
            provenance.views[it.id] = rf;
          }
        }
      );
      for (const v of viewItems) {
        if (v?.id && !provenance.viewSource[v.id]) {
          provenance.viewSource[v.id] = relFile;
          provenance.views[v.id] = relFile;
        }
        mergedViews.push(v);
      }

      const groupItems = expandArrayLevelIncludes(
        modObj.actionGroups,
        modDir,
        rootDir,
        provenance.moduleFiles,
        visitedIncludes
      );
      for (const grp of groupItems) {
        if (!grp || typeof grp !== "object" || !grp.name) continue;
        const expandedActions = expandArrayLevelIncludes(
          grp.actions,
          modDir,
          rootDir,
          provenance.moduleFiles,
          visitedIncludes,
          (act, rf) => {
            if (act?.id) {
              provenance.actionSource[act.id] = rf;
              provenance.actions[act.id] = { file: rf, group: grp.name };
            }
          }
        );
        for (const act of expandedActions) {
          if (act?.id && !provenance.actionSource[act.id]) {
            provenance.actionSource[act.id] = relFile;
            provenance.actions[act.id] = { file: relFile, group: grp.name };
          }
        }
        const existingGrp = mergedGroups.get(grp.name);
        if (existingGrp) {
          existingGrp.actions = [...(existingGrp.actions || []), ...expandedActions];
          if (grp.description && !existingGrp.description) existingGrp.description = grp.description;
          if (Array.isArray(grp.subgroups)) {
            existingGrp.subgroups = [...(existingGrp.subgroups || []), ...grp.subgroups];
          }
        } else {
          mergedGroups.set(grp.name, {
            ...grp,
            actions: expandedActions,
          });
        }
      }
    };

    ingestModuleObject(rootParsed, filePath);

    const assembled: Record<string, any> = {
      ...rootParsed,
      ...(mergedContext.length > 0 ? { context: mergedContext } : {}),
      ...(mergedData.length > 0 ? { data: mergedData } : {}),
      ...(mergedViews.length > 0 ? { views: mergedViews } : {}),
      ...(mergedGroups.size > 0 ? { actionGroups: [...mergedGroups.values()] } : {}),
    };

    const resolved = Object.keys(defs).length > 0 ? resolveDefsRefs(assembled, defs) : assembled;
    const validated = SkillManifestSchema.safeParse(resolved);
    return {
      manifest: validated.success ? validated.data : (resolved as PartialSkillManifest),
      rawParsed: resolved,
      provenance,
    };
  } catch {
    return { manifest: null, rawParsed: null, provenance };
  }
}

function readManifestFile(filePath: string): PartialSkillManifest | null {
  return loadAndLinkManifestFile(filePath).manifest;
}

export function mergeManifestLayer(base: SkillManifest, patch: PartialSkillManifest): SkillManifest {
  const rawGroups = patch.actionGroups && patch.actionGroups.length > 0 ? patch.actionGroups : base.actionGroups;
  return {
    id: patch.id || base.id,
    name: patch.name || base.name,
    category: patch.category || base.category,
    description: patch.description || base.description,
    icon: patch.icon ?? base.icon,
    banner: patch.banner ?? base.banner,
    defaultWorkspace: patch.defaultWorkspace ?? base.defaultWorkspace,
    tsPrelude: patch.tsPrelude ?? base.tsPrelude,
    includes: patch.includes ?? base.includes,
    defs: patch.defs ?? base.defs,
    envVars: patch.envVars && patch.envVars.length > 0 ? patch.envVars : base.envVars,
    context: patch.context && patch.context.length > 0 ? patch.context : base.context,
    data: patch.data && patch.data.length > 0 ? patch.data : base.data,
    tags: patch.tags && patch.tags.length > 0 ? Array.from(new Set([...base.tags, ...patch.tags])) : base.tags,
    defaultPrompt: patch.defaultPrompt ?? base.defaultPrompt,
    views: patch.views && patch.views.length > 0 ? patch.views : base.views,
    actionGroups: rawGroups.map((g) => normalizeGroupSubgroups(g)),
  };
}

export function resolveSkillCascade(
  skillId: string,
  canonicalPath: string,
  dataDir: string,
  activeWorkspace: string,
  overridesDir?: string
): { manifest: SkillManifest; layers: ConfigLayerStatus } {
  const zeroManifest = parseZeroConfigSkill(skillId, canonicalPath);

  const dashboardDir = join(canonicalPath, ".dashboard");
  const companionYaml = join(dashboardDir, "manifest.yaml");
  const companionJson = join(dashboardDir, "manifest.json");
  const companionPath = existsSync(companionYaml)
    ? companionYaml
    : existsSync(companionJson)
      ? companionJson
      : companionYaml;

  const globalCandidateXdg = overridesDir
    ? join(overridesDir, skillId, "manifest.yaml")
    : undefined;
  const globalCandidateCanonical = join(dirname(dataDir), "configs", skillId, "manifest.yaml");
  const globalCandidateLegacy = join(dataDir, "configs", skillId, "manifest.yaml");
  const globalOverridePath =
    globalCandidateXdg &&
    (existsSync(globalCandidateXdg) ||
      (!existsSync(globalCandidateCanonical) && !existsSync(globalCandidateLegacy)))
      ? globalCandidateXdg
      : existsSync(globalCandidateCanonical) || !existsSync(globalCandidateLegacy)
        ? globalCandidateCanonical
        : globalCandidateLegacy;
  const workspaceOverridePath = join(activeWorkspace, ".claude/skill-dashboard/configs", skillId, "manifest.yaml");

  const companionLinked = loadAndLinkManifestFile(companionPath, dashboardDir);
  const companionPatch = companionLinked.manifest;
  const globalPatch = readManifestFile(globalOverridePath);
  const workspacePatch = readManifestFile(workspaceOverridePath);

  let effective = zeroManifest;
  if (companionPatch) effective = mergeManifestLayer(effective, companionPatch);
  if (globalPatch) effective = mergeManifestLayer(effective, globalPatch);
  if (workspacePatch) effective = mergeManifestLayer(effective, workspacePatch);

  return {
    manifest: effective,
    layers: {
      zeroConfig: true,
      companion: Boolean(companionPatch),
      companionPath,
      moduleFiles: companionPatch ? companionLinked.provenance.moduleFiles : undefined,
      provenance: companionPatch ? companionLinked.provenance : undefined,
      globalOverride: Boolean(globalPatch),
      globalOverridePath,
      workspaceOverride: Boolean(workspacePatch),
      workspaceOverridePath,
    },
  };
}

export function saveSkillManifestLayer(
  canonicalPath: string,
  dataDir: string,
  activeWorkspace: string,
  skillId: string,
  layer: "companion" | "global" | "workspace",
  manifest: PartialSkillManifest,
  overridesDir?: string
): string {
  const targetPath =
    layer === "companion"
      ? join(canonicalPath, ".dashboard/manifest.yaml")
      : layer === "global"
        ? overridesDir
          ? join(overridesDir, skillId, "manifest.yaml")
          : join(dirname(dataDir), "configs", skillId, "manifest.yaml")
        : join(activeWorkspace, ".claude/skill-dashboard/configs", skillId, "manifest.yaml");

  mkdirSync(dirname(targetPath), { recursive: true });
  const yamlStr = YAML.stringify(manifest, { indent: 2, lineWidth: 100 });
  writeFileSync(targetPath, yamlStr, "utf-8");
  return targetPath;
}
