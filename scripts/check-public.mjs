#!/usr/bin/env node
// Public-repo guard. Zero dependencies (node: built-ins only).
//
//   node scripts/check-public.mjs            scan tracked files (git ls-files)
//   node scripts/check-public.mjs --staged   scan staged blobs (pre-commit hook)
//   node scripts/check-public.mjs --commits <range>   also scan commit messages in a git range
//   node scripts/check-public.mjs --pack     assert the npm tarball contents (run after `pnpm build`)
//
// Extra deny patterns (one regex per line, `#` comments, optional `(?i)` prefix for
// case-insensitive) are read from the gitignored `.public-guard.local` in the repo root and
// from the file named by the PUBLIC_GUARD_EXTRA_FILE environment variable.
// Findings print `file:line  rule`; matched values are never printed.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Tracked paths that must never be published. Tested against the repo-relative path. */
export const FORBIDDEN_PATHS = [
  { rule: 'forbidden-file: local agent notes', re: /(^|\/)CLAUDE\.local\.md$/ },
  { rule: 'forbidden-file: local agent override', re: /(^|\/)AGENTS\.override\.md$/ },
  {
    rule: 'forbidden-dir: editor or agent config',
    re: /(^|\/)\.(claude|cursor|kiro|codex|windsurf|vscode|idea)\//,
  },
  { rule: 'forbidden-file: MCP config', re: /(^|\/)\.mcp\.json$/ },
  { rule: 'forbidden-file: env file', re: /(^|\/)\.env[^/]*$/ },
  { rule: 'forbidden-file: local guard patterns', re: /(^|\/)\.public-guard\.local$/ },
  { rule: 'forbidden-file: *.local.*', re: /(^|\/)[^/]*\.local\.[^/]*$/ },
  { rule: 'forbidden-file: key material', re: /\.(pem|key)$/ },
  { rule: 'forbidden-file: .npmrc', re: /(^|\/)\.npmrc$/ },
  { rule: 'forbidden-dir: local dev data', re: /(^|\/)\.signalk-dev\// },
];

const FILLER_WORDS = /fake|test|filler|example|sample|dummy|placeholder|redacted|secret|xxxx/i;

/** True when a token body is obviously not a real secret. */
export function isFiller(body) {
  if (FILLER_WORDS.test(body)) return true;
  if (/^(.)\1+$/.test(body)) return true;
  if (new Set(body.toLowerCase()).size < 10) return true;
  return false;
}

// Patterns are written so this file does not match its own rules.
const CONTENT_RULES = [
  { rule: 'personal-path: macOS home', re: /\/Users\/[^/\s<>$*"'`]+\//g },
  {
    rule: 'personal-path: Linux home',
    re: /\/home\/(?!node\/)[^/\s<>$*"'`]+\//g,
  },
  { rule: 'personal-path: Windows home', re: /C:\\Users\\/gi },
  { rule: 'private-key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { rule: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  { rule: 'github-token', re: /gh[pousr]_[A-Za-z0-9]{30,}/g },
  { rule: 'github-pat', re: /github_pat_[A-Za-z0-9_]{30,}/g },
  { rule: 'npm-token', re: /npm_[A-Za-z0-9]{30,}/g },
  {
    rule: 'vti-credential-like',
    re: /vti_([A-Za-z0-9_-]{20,})/g,
    accept: (m) => isFiller(m[1] ?? ''),
  },
  {
    rule: 'bearer-token',
    re: /Bearer\s+([A-Za-z0-9._~+/=-]{24,})/g,
    accept: (m) => isFiller(m[1] ?? ''),
  },
];

/**
 * Parse deny-pattern text: one regex per line, `#` comments and blank lines ignored.
 * A leading `(?i)` makes that line case-insensitive.
 */
export function parseDenyPatterns(text, source = 'extra') {
  const out = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const ci = line.startsWith('(?i)');
    const src = ci ? line.slice(4) : line;
    try {
      out.push({ rule: `local-deny (${source}:${i + 1})`, re: new RegExp(src, ci ? 'gi' : 'g') });
    } catch {
      throw new Error(`invalid deny pattern at ${source}:${i + 1}`);
    }
  }
  return out;
}

export function loadExtraPatterns(root, env = process.env) {
  const out = [];
  const local = join(root, '.public-guard.local');
  if (existsSync(local))
    out.push(...parseDenyPatterns(readFileSync(local, 'utf8'), '.public-guard.local'));
  const extra = env.PUBLIC_GUARD_EXTRA_FILE;
  if (extra) {
    if (!existsSync(extra)) throw new Error('PUBLIC_GUARD_EXTRA_FILE does not exist');
    out.push(...parseDenyPatterns(readFileSync(extra, 'utf8'), 'PUBLIC_GUARD_EXTRA_FILE'));
  }
  return out;
}

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Scan one text for content rules plus extra deny patterns. Returns findings without values. */
export function scanText(path, text, extra = []) {
  const findings = [];
  for (const { rule, re, accept } of [...CONTENT_RULES, ...extra]) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (accept?.(m)) continue;
      findings.push({ path, line: lineOf(text, m.index ?? 0), rule });
    }
  }
  return findings;
}

/** Check repo-relative paths against the forbidden list and extra deny patterns. */
export function checkPaths(paths, extra = []) {
  const findings = [];
  for (const p of paths) {
    for (const { rule, re } of FORBIDDEN_PATHS)
      if (re.test(p)) findings.push({ path: p, line: 0, rule });
    for (const { rule, re } of extra) {
      re.lastIndex = 0;
      if (re.test(p)) findings.push({ path: p, line: 0, rule: `${rule} (path)` });
    }
  }
  return findings;
}

const SKIP_CONTENT = new Set(['pnpm-lock.yaml', 'LICENSE']);

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

/** Scan a list of `{path, read}` entries; `read` returns a Buffer or null (skip). */
export function scanEntries(entries, extra = []) {
  const findings = [];
  for (const { path, read } of entries) {
    if (SKIP_CONTENT.has(path)) continue;
    const buf = read();
    if (buf === null || isBinary(buf)) continue;
    findings.push(...scanText(path, buf.toString('utf8'), extra));
  }
  return findings;
}

/** Scan commit messages (raw text blocks keyed by short sha). */
export function scanCommitMessages(messages, extra = []) {
  const findings = [];
  for (const { sha, body } of messages) {
    for (const f of scanText(`commit:${sha}`, body, extra)) findings.push(f);
  }
  return findings;
}

export const PACK_ALLOWED_FILES = new Set(['README.md', 'LICENSE', 'SECURITY.md', 'package.json']);

/**
 * The pairing page served by SignalK as a webapp. Exactly these files, no `public/` prefix rule:
 * source maps, declaration files and nested paths under public/ stay rejected.
 */
export const PACK_ALLOWED_UI_FILES = new Set([
  'public/index.html',
  'public/style.css',
  'public/app.js',
  'public/view.js',
  'public/controller.js',
]);

/**
 * Assert an npm pack file list contains only plugin/**, README.md, LICENSE, SECURITY.md,
 * package.json and the five pairing page files in PACK_ALLOWED_UI_FILES.
 */
export function checkPackFiles(paths) {
  const findings = [];
  for (const p of paths) {
    if (p.startsWith('plugin/') || PACK_ALLOWED_FILES.has(p) || PACK_ALLOWED_UI_FILES.has(p))
      continue;
    findings.push({ path: p, line: 0, rule: 'pack: unexpected file in npm tarball' });
  }
  if (!paths.some((p) => p.startsWith('plugin/'))) {
    findings.push({
      path: 'plugin/',
      line: 0,
      rule: 'pack: tarball has no plugin/ files (run pnpm build first)',
    });
  }
  return findings;
}

function git(root, args, opts = {}) {
  return execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024, ...opts });
}

function listNul(buf) {
  return buf
    .toString('utf8')
    .split('\0')
    .filter((s) => s !== '');
}

/** Run repo checks. mode: 'tracked' (default) or 'staged'. Returns findings. */
export function runRepoChecks({ root, mode = 'tracked', commits, env = process.env }) {
  const extra = loadExtraPatterns(root, env);
  let paths;
  let entries;
  if (mode === 'staged') {
    paths = listNul(git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']));
    entries = paths.map((path) => ({
      path,
      read: () => {
        try {
          return git(root, ['show', `:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] });
        } catch {
          return null;
        }
      },
    }));
  } else {
    paths = listNul(git(root, ['ls-files', '-z']));
    entries = paths.map((path) => ({
      path,
      read: () => {
        const full = join(root, path);
        try {
          if (!lstatSync(full).isFile()) return null; // symlinks (CLAUDE.md) and gitlinks
          return readFileSync(full);
        } catch {
          return null;
        }
      },
    }));
  }
  const findings = [...checkPaths(paths, extra), ...scanEntries(entries, extra)];
  if (commits) {
    const raw = git(root, ['log', '--format=%h%x00%B%x01', commits]).toString('utf8');
    const messages = raw
      .split('\x01')
      .map((r) => r.replace(/^\n+/, ''))
      .filter((r) => r !== '')
      .map((r) => {
        const [sha = '', ...rest] = r.split('\0');
        return { sha, body: rest.join('\0') };
      });
    findings.push(...scanCommitMessages(messages, extra));
  }
  return findings;
}

export function runPackCheck(root) {
  if (!existsSync(join(root, 'plugin'))) {
    return [{ path: 'plugin/', line: 0, rule: 'pack: plugin/ not built (run pnpm build first)' }];
  }
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  }).toString('utf8');
  const parsed = JSON.parse(out);
  const files = (parsed[0]?.files ?? []).map((f) => f.path);
  return checkPackFiles(files);
}

export function formatFindings(findings) {
  return findings.map((f) => `${f.path}${f.line > 0 ? `:${f.line}` : ''}  ${f.rule}`).join('\n');
}

export function main(argv, root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  const args = argv.slice(2);
  let findings;
  if (args.includes('--pack')) {
    findings = runPackCheck(root);
  } else {
    const ci = args.indexOf('--commits');
    const commits = ci >= 0 ? args[ci + 1] : undefined;
    if (ci >= 0 && !commits) {
      console.error('--commits needs a git range');
      return 2;
    }
    findings = runRepoChecks({
      root,
      mode: args.includes('--staged') ? 'staged' : 'tracked',
      commits,
    });
  }
  if (findings.length > 0) {
    console.error(formatFindings(findings));
    console.error(`\ncheck-public: ${findings.length} problem(s). Matched values are not printed.`);
    return 1;
  }
  console.log('check-public: ok');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv);
}
