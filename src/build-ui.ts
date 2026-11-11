import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, resolve } from "path";

export async function buildFrontendBundle(): Promise<void> {
  const rootDir = resolve(import.meta.dir, "..");
  const distDir = join(rootDir, "dist");
  mkdirSync(distDir, { recursive: true });

  const buildResult = await Bun.build({
    entrypoints: [join(rootDir, "src/ui/main.tsx")],
    outdir: distDir,
    naming: "app.js",
    minify: true,
    target: "browser",
  });

  if (!buildResult.success) {
    console.error("Frontend build failed:", buildResult.logs);
    throw new Error("Frontend build failed");
  }

  const xtermCssPath = join(rootDir, "node_modules/@xterm/xterm/css/xterm.css");
  const xtermCss = readFileSync(xtermCssPath, "utf-8");
  writeFileSync(join(distDir, "xterm.css"), xtermCss, "utf-8");

  const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none">
  <defs>
    <linearGradient id="sdGrad" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#0284C7" />
      <stop offset="100%" stop-color="#4F46E5" />
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="16" fill="url(#sdGrad)" />
  <rect x="10" y="12" width="44" height="40" rx="8" fill="#0F172A" fill-opacity="0.88" stroke="#7DD3FC" stroke-width="2" />
  <path d="M18 26L26 32L18 38" stroke="#38BDF8" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M30 38H42" stroke="#34D399" stroke-width="3.5" stroke-linecap="round" />
  <circle cx="46" cy="20" r="3" fill="#34D399" />
</svg>`;
  writeFileSync(join(distDir, "favicon.svg"), faviconSvg, "utf-8");

  const indexHtml = `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Skill Dashboard Studio</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = { darkMode: 'class' };
  </script>
  <link rel="stylesheet" href="/xterm.css" />
  <style>
    :root, html[data-theme="light"] {
      --bg-app: #f5f4ef;
      --bg-header: rgba(250, 249, 245, 0.92);
      --bg-sidebar: #efede6;
      --bg-surface: #ffffff;
      --bg-subcard: #f8f7f3;
      --bg-muted: #eae7df;
      --bg-code: #f4f3ee;
      --bg-input: #ffffff;
      --border-subtle: #e2dfd5;
      --border-strong: #cbc6b8;
      --text-primary: #1e293b;
      --text-secondary: #475569;
      --text-muted: #64748b;
      --tok-comment: #6b7280;
      --tok-string: #047857;
      --tok-placeholder: #b45309;
      --tok-placeholder-bg: rgba(245, 158, 11, 0.14);
      --tok-flag: #0369a1;
      --tok-key: #6d28d9;
      --tok-keyword: #be123c;
      --tok-number: #c2410c;
    }

    html[data-theme="dark"] {
      --bg-app: #161920;
      --bg-header: rgba(26, 30, 39, 0.92);
      --bg-sidebar: #1a1e27;
      --bg-surface: #212631;
      --bg-subcard: #191d26;
      --bg-muted: #14171f;
      --bg-code: #13161d;
      --bg-input: #151921;
      --border-subtle: #2c3342;
      --border-strong: #3d4659;
      --text-primary: #e5e9f0;
      --text-secondary: #a7b1c2;
      --text-muted: #7a8599;
      --tok-comment: #6e788c;
      --tok-string: #34d399;
      --tok-placeholder: #fbbf24;
      --tok-placeholder-bg: rgba(251, 191, 36, 0.15);
      --tok-flag: #38bdf8;
      --tok-key: #c084fc;
      --tok-keyword: #fb7185;
      --tok-number: #fb923c;
    }

    body {
      background-color: var(--bg-app);
      color: var(--text-primary);
      font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
    }

    .st-app { background-color: var(--bg-app); color: var(--text-primary); }
    .st-header { background-color: var(--bg-header); }
    .st-sidebar { background-color: var(--bg-sidebar); }
    .st-card { background-color: var(--bg-surface); border: 1px solid var(--border-subtle); box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .st-surface { background-color: var(--bg-surface); }
    .st-subcard { background-color: var(--bg-subcard); border: 1px solid var(--border-subtle); }
    .st-surface-muted { background-color: var(--bg-muted); }
    .st-code-surface { background-color: var(--bg-code); color: var(--text-primary); }
    .st-input { background-color: var(--bg-input); border: 1px solid var(--border-subtle); color: var(--text-primary); }
    .st-border { border-color: var(--border-subtle); }
    .st-border-strong { border-color: var(--border-strong); }
    .st-text-primary { color: var(--text-primary); }
    .st-text-secondary { color: var(--text-secondary); }
    .st-text-muted { color: var(--text-muted); }
    .st-pill { background-color: var(--bg-muted); color: var(--text-secondary); border: 1px solid var(--border-subtle); }
    .st-badge-accent { background-color: rgba(2, 132, 199, 0.12); color: #0284c7; border: 1px solid rgba(2, 132, 199, 0.25); }
    html[data-theme="dark"] .st-badge-accent { background-color: rgba(56, 189, 248, 0.14); color: #7dd3fc; border-color: rgba(56, 189, 248, 0.28); }
    .st-btn-secondary { background-color: var(--bg-subcard); color: var(--text-primary); border: 1px solid var(--border-subtle); }
    .st-btn-secondary:hover { background-color: var(--bg-muted); border-color: var(--border-strong); }
    .st-skill-item-active { background-color: var(--bg-surface); border-color: #0284c7 !important; }

    /* Syntax Highlighting Token Classes */
    .tok-comment { color: var(--tok-comment); font-style: italic; }
    .tok-string { color: var(--tok-string); }
    .tok-placeholder { color: var(--tok-placeholder); background: var(--tok-placeholder-bg); padding: 0.05rem 0.28rem; border-radius: 0.25rem; font-weight: 600; }
    .tok-flag { color: var(--tok-flag); font-weight: 600; }
    .tok-key { color: var(--tok-key); font-weight: 600; }
    .tok-keyword { color: var(--tok-keyword); font-weight: 600; }
    .tok-number { color: var(--tok-number); }

    .code-line { display: flex; align-items: baseline; }
    .code-ln { width: 2.75rem; flex-shrink: 0; text-align: right; padding-right: 0.85rem; color: var(--text-muted); opacity: 0.6; user-select: none; font-size: 11.5px; }
    .code-lc { flex: 1; white-space: pre; }

    .no-scrollbar::-webkit-scrollbar { display: none; }
    .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

    /* Ergonomic Markdown Typography */
    .markdown-body { color: var(--text-primary); font-size: 14.5px; line-height: 1.68; }
    .markdown-body h1 { font-size: 1.5rem; font-weight: 700; color: var(--text-primary); margin: 1.1rem 0 0.75rem; border-bottom: 1px solid var(--border-subtle); padding-bottom: 0.45rem; }
    .markdown-body h2 { font-size: 1.22rem; font-weight: 700; color: #0284c7; margin: 1.35rem 0 0.55rem; }
    html[data-theme="dark"] .markdown-body h2 { color: #38bdf8; }
    .markdown-body h3 { font-size: 1.05rem; font-weight: 600; color: var(--text-primary); margin: 1.1rem 0 0.4rem; }
    .markdown-body h4 { font-size: 0.95rem; font-weight: 600; color: var(--text-secondary); margin: 0.85rem 0 0.3rem; }
    .markdown-body p { margin: 0.6rem 0; }
    .markdown-body ul, .markdown-body ol { margin: 0.6rem 0; padding-left: 1.5rem; }
    .markdown-body ul { list-style-type: disc; }
    .markdown-body ol { list-style-type: decimal; }
    .markdown-body li { margin: 0.3rem 0; }
    .markdown-body code { font-family: 'JetBrains Mono', 'SF Mono', Menlo, monospace; font-size: 0.86em; background: var(--bg-code); color: var(--tok-flag); padding: 0.15rem 0.4rem; border-radius: 0.3rem; border: 1px solid var(--border-subtle); }
    .markdown-body pre { background: var(--bg-code); padding: 0.9rem 1.1rem; border-radius: 0.65rem; border: 1px solid var(--border-subtle); overflow-x: auto; margin: 0.85rem 0; }
    .markdown-body pre code { background: transparent; border: none; padding: 0; color: var(--text-primary); }
    .markdown-body a { color: #0284c7; text-decoration: underline; font-weight: 500; }
    html[data-theme="dark"] .markdown-body a { color: #38bdf8; }
    .markdown-body blockquote { border-left: 3px solid #0284c7; background: var(--bg-subcard); padding: 0.6rem 1rem; border-radius: 0 0.5rem 0.5rem 0; margin: 0.75rem 0; color: var(--text-secondary); }
    .markdown-body table { width: 100%; border-collapse: collapse; margin: 0.85rem 0; font-size: 0.88rem; }
    .markdown-body th, .markdown-body td { border: 1px solid var(--border-subtle); padding: 0.5rem 0.75rem; text-align: left; }
    .markdown-body th { background: var(--bg-subcard); color: var(--text-primary); font-weight: 600; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/app.js"></script>
</body>
</html>`;

  writeFileSync(join(distDir, "index.html"), indexHtml, "utf-8");
}

if (import.meta.main) {
  await buildFrontendBundle();
  console.log("Frontend bundle built successfully in dist/");
}
