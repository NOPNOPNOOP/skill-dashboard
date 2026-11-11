export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const TOKEN_REGEX =
  /(#.*$|\/\/.*$)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(\{\{[^}]+\}\}|<[a-zA-Z0-9_./-]+>|\[\s*--?[a-zA-Z0-9_|-]+[^\]]*\]|\{[a-zA-Z0-9_|-]+\|[a-zA-Z0-9_|-]+\})|(\s--?[a-zA-Z0-9_-]+)|(^[\s-]*[a-zA-Z0-9_-]+(?=\s*:))|\b(python3?|uv|bun|npx|git|curl|export|import|from|def|class|async|await|return|if|elif|else|for|while|in|try|except|finally|with|as|pass|raise|yield|const|let|var|function|interface|type|enum|implements|extends|true|false|null|undefined|None|True|False|SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|JOIN|LEFT|INNER|ORDER|BY|GROUP|LIMIT|AND|OR|NOT|NULL)\b|\b(\d+(?:\.\d+)?)\b/gm;

export function highlightCodeToHtml(code: string, _lang = "text", withLineNumbers = false): string {
  const highlightSingleLine = (line: string): string => {
    let result = "";
    let lastIdx = 0;
    TOKEN_REGEX.lastIndex = 0;
    for (const match of line.matchAll(TOKEN_REGEX)) {
      const idx = match.index!;
      if (idx > lastIdx) {
        result += escapeHtml(line.slice(lastIdx, idx));
      }
      const [full, comment, str, placeholder, flag, yamlKey, kw, num] = match;
      if (comment) {
        result += `<span class="tok-comment">${escapeHtml(full)}</span>`;
      } else if (str) {
        result += `<span class="tok-string">${escapeHtml(full)}</span>`;
      } else if (placeholder) {
        result += `<span class="tok-placeholder">${escapeHtml(full)}</span>`;
      } else if (flag) {
        const leadingSpace = full.slice(0, full.length - full.trimStart().length);
        result += `${escapeHtml(leadingSpace)}<span class="tok-flag">${escapeHtml(full.trimStart())}</span>`;
      } else if (yamlKey) {
        result += `<span class="tok-key">${escapeHtml(full)}</span>`;
      } else if (kw) {
        result += `<span class="tok-keyword">${escapeHtml(full)}</span>`;
      } else if (num) {
        result += `<span class="tok-number">${escapeHtml(full)}</span>`;
      } else {
        result += escapeHtml(full);
      }
      lastIdx = idx + full.length;
    }
    if (lastIdx < line.length) {
      result += escapeHtml(line.slice(lastIdx));
    }
    return result;
  };

  const lines = code.replace(/\r\n/g, "\n").split("\n");
  if (!withLineNumbers) {
    return lines.map(highlightSingleLine).join("\n");
  }

  return lines
    .map(
      (line, idx) =>
        `<div class="code-line"><span class="code-ln">${idx + 1}</span><span class="code-lc">${highlightSingleLine(line) || " "}</span></div>`
    )
    .join("");
}

export type MarkdownSegment =
  | { type: "prose"; markdown: string }
  | {
      type: "code";
      lang: string;
      rawCode: string;
      isExecutableShell: boolean;
      commands: Array<{ comment?: string; command: string }>;
    };

const EXECUTABLE_PREFIX_REGEX =
  /^(?:python3?|uv|bun|npx|npm|pnpm|yarn|node|sh|bash|zsh|git|curl|docker|kubectl|alembic|pytest|ruff|mypy|make|cargo|go|open|ln|mkdir|cp|mv|rm|cat|ls|find|grep|export|env|~\/|\.\/|\/|\{\{python\}\}|\{\{skill_dir\}\})\b/;

export function extractExecutableCommandsFromShellBlock(
  rawCode: string
): Array<{ comment?: string; command: string }> {
  const rawLines = rawCode.replace(/\r\n/g, "\n").split("\n");
  const commands: Array<{ comment?: string; command: string }> = [];
  let pendingComment = "";
  let currentLines: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let heredocDelim: string | null = null;

  const updateQuotes = (line: string) => {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "\\" && !inSingle) {
        i++;
        continue;
      }
      if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
        break;
      }
    }
  };

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (currentLines.length === 0) {
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) {
        const c = trimmed.replace(/^#+\s*/, "").trim();
        if (!c.startsWith("⚠️") && !c.toLowerCase().startsWith("or ")) {
          pendingComment = c;
        }
        continue;
      }
    }

    currentLines.push(line);
    if (heredocDelim) {
      if (trimmed === heredocDelim) heredocDelim = null;
    } else {
      updateQuotes(line);
      if (!inSingle && !inDouble) {
        const hd = line.match(/(?:^|[^<])<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
        if (hd) heredocDelim = hd[1];
      }
    }

    const trimmedRight = line.trimEnd();
    let bsCount = 0;
    for (let i = trimmedRight.length - 1; i >= 0 && trimmedRight[i] === "\\"; i--) bsCount++;
    const hasTrailingBackslash = bsCount % 2 === 1;

    const continues =
      Boolean(heredocDelim) || inSingle || inDouble || hasTrailingBackslash;

    if (!continues) {
      const joined = currentLines.join("\n").trim();
      const firstLine = joined.split("\n")[0].trim();
      const withoutInlineComment =
        currentLines.length === 1 ? joined.replace(/\s+#\s+.*$/, "").trim() : joined;
      const inlineMatch = currentLines.length === 1 ? joined.match(/\s+#\s+(.*)$/) : null;
      if (EXECUTABLE_PREFIX_REGEX.test(firstLine)) {
        commands.push({
          comment: pendingComment || (inlineMatch ? inlineMatch[1].trim() : undefined),
          command: withoutInlineComment,
        });
      }
      currentLines = [];
      pendingComment = "";
      inSingle = false;
      inDouble = false;
      heredocDelim = null;
    }
  }

  return commands;
}

export function splitMarkdownIntoSegments(md: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  const fenceRegex = /^```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;

  let lastIdx = 0;
  for (const match of md.matchAll(fenceRegex)) {
    const idx = match.index!;
    if (idx > lastIdx) {
      const prose = md.slice(lastIdx, idx);
      if (prose.trim()) {
        segments.push({ type: "prose", markdown: prose });
      }
    }
    const lang = (match[1] || "text").trim().toLowerCase();
    const rawCode = (match[2] || "").replace(/\s+$/, "");
    const isShell = ["bash", "sh", "zsh", "shell", "console"].includes(lang);
    const commands = isShell ? extractExecutableCommandsFromShellBlock(rawCode) : [];

    segments.push({
      type: "code",
      lang: lang || "text",
      rawCode,
      isExecutableShell: isShell && commands.length > 0,
      commands,
    });

    lastIdx = idx + match[0].length;
  }

  if (lastIdx < md.length) {
    const tail = md.slice(lastIdx);
    if (tail.trim()) {
      segments.push({ type: "prose", markdown: tail });
    }
  }

  return segments;
}

export function ansiToHtml(raw: string): string {
  const esc = escapeHtml(raw);
  const colorMap: Record<string, string> = {
    "30": "#64748b",
    "31": "#ef4444",
    "32": "#10b981",
    "33": "#d97706",
    "34": "#2563eb",
    "35": "#9333ea",
    "36": "#0891b2",
    "37": "var(--text-primary)",
    "90": "#94a3b8",
    "91": "#f87171",
    "92": "#34d399",
    "93": "#fbbf24",
    "94": "#60a5fa",
    "95": "#c084fc",
    "96": "#22d3ee",
    "97": "var(--text-primary)",
  };

  let openSpans = 0;
  const out = esc.replace(/\x1b\[([0-9;]*)m/g, (_m, codesStr: string) => {
    const codes = codesStr ? codesStr.split(";") : ["0"];
    if (codes.includes("0") || codesStr === "") {
      const closing = "</span>".repeat(openSpans);
      openSpans = 0;
      return closing;
    }
    const styles: string[] = [];
    for (const c of codes) {
      if (c === "1") styles.push("font-weight:700");
      else if (c === "2") styles.push("opacity:0.75");
      else if (colorMap[c]) styles.push(`color:${colorMap[c]}`);
    }
    if (styles.length > 0) {
      openSpans++;
      return `<span style="${styles.join(";")}">`;
    }
    return "";
  });
  return out + "</span>".repeat(openSpans);
}

