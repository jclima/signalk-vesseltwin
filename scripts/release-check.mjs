#!/usr/bin/env node
// Release-train checks. Zero dependencies (node: built-ins and global fetch only).
//
//   node scripts/release-check.mjs --help      usage and exit codes
//
// Findings print `ERROR|WARN <id>  <file>[:<line>]  <message>`. Messages are fixed strings; only
// values that match the strict semver/tag patterns are ever interpolated. File contents and
// environment values are never printed.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export class EnvError extends Error {}

const NUM = '(0|[1-9]\\d*)';
const PRE_ID = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const SEMVER_RE = new RegExp(`^${NUM}\\.${NUM}\\.${NUM}(?:-(${PRE_ID}(?:\\.${PRE_ID})*))?$`);
const NO_UPLOAD_COPY = 'Data upload is not available in this version.';
const README_UPLOAD_COPY = [
  'Sending readings is not available in this version',
  'Uploading is not available yet',
];
const INGEST_ROUTE = '/v1/integrations/signalk/';
const REGISTRY = 'https://registry.npmjs.org/';
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

const USAGE = `Usage: node scripts/release-check.mjs <mode> [options]

Modes (exactly one):
  --ci                       static consistency checks (no git, no network)
  --plan [--online]          print baseline, allowed next versions, Unreleased bullet counts
  --release X.Y.Z [--pre-tag] [--online]
                             readiness for a release (--pre-tag: also HEAD == origin/main, tag absent)
  --tag vX.Y.Z [--online]    checks run by the release workflow before publishing
  --verify-published X.Y.Z   check the npm registry after publishing
  --print-notes X.Y.Z        print the CHANGELOG section body for that version
  --help                     this text

Exit codes: 0 ok (warnings allowed), 1 error findings, 2 usage, 3 environment error.
Exit 3 (git or file missing, origin/main missing, registry unreachable) is never a pass.`;

// ---------------------------------------------------------------- semver

/** Strict semver X.Y.Z with optional -prerelease. No v prefix, leading zeros, or build metadata. */
export function parseSemver(s) {
  if (typeof s !== 'string') return null;
  const m = SEMVER_RE.exec(s);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? null : m[4].split('.'),
    raw: s,
  };
}

function toParsed(v) {
  const p = typeof v === 'string' ? parseSemver(v) : v;
  if (!p) throw new TypeError('invalid semver');
  return p;
}

function comparePre(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // a release outranks its prereleases
  if (b === null) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareSemver(a, b) {
  const x = toParsed(a);
  const y = toParsed(b);
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}

/** Allowed next versions after a released baseline. Under 1.0.0 a "major" bump is 1.0.0. */
export function nextVersions(base) {
  const b = toParsed(base);
  return {
    patch: `${b.major}.${b.minor}.${b.patch + 1}`,
    minor: `${b.major}.${b.minor + 1}.0`,
    major: b.major === 0 ? '1.0.0' : `${b.major + 1}.0.0`,
  };
}

/** Only values matching the strict semver pattern are echoed back in messages. */
function sv(v) {
  return typeof v === 'string' && parseSemver(v) ? v : '<invalid>';
}

// ---------------------------------------------------------------- findings

const err = (id, file, message, line) => ({ sev: 'ERROR', id, file, line: line ?? 0, message });
const warn = (id, file, message, line) => ({ sev: 'WARN', id, file, line: line ?? 0, message });

export function formatFindings(findings) {
  const lines = findings.map(
    (f) => `${f.sev} ${f.id}  ${f.file}${f.line > 0 ? `:${f.line}` : ''}  ${f.message}`,
  );
  const errors = findings.filter((f) => f.sev === 'ERROR').length;
  const warnings = findings.length - errors;
  lines.push(
    errors === 0 && warnings === 0
      ? 'release-check: ok'
      : `release-check: ${errors} error(s), ${warnings} warning(s)`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------- text helpers

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Strip blockquote prefixes and bold markers, collapse whitespace. */
export function normaliseReadme(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/^\s*>\s?/, ''))
    .join(' ')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripComments(ts) {
  return ts.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

// ---------------------------------------------------------------- changelog

const RELEASE_HEADING = /^## \[([^\]]+)\](?:\s+-\s+(\S+))?\s*$/;

/** @returns {{unreleased: {line:number, body:string}|null, releases: {version:string, date:string|null, line:number, body:string}[]}} */
export function parseChangelog(text) {
  const lines = text.split('\n');
  const sections = [];
  let cur = null;
  lines.forEach((l, i) => {
    if (/^## /.test(l)) {
      const m = RELEASE_HEADING.exec(l);
      cur = { name: m?.[1] ?? '', date: m?.[2] ?? null, line: i + 1, body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(l);
    }
  });
  const out = { unreleased: null, releases: [] };
  for (const s of sections) {
    const body = s.body.join('\n');
    if (s.name.toLowerCase() === 'unreleased') {
      out.unreleased ??= { line: s.line, body };
    } else {
      out.releases.push({ version: s.name, date: s.date, line: s.line, body });
    }
  }
  return out;
}

function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms).toISOString().slice(0, 10);
  return back === s ? ms : null;
}

const CL = 'CHANGELOG.md';

export function checkChangelogDated(parsed, pkgVersion) {
  if (pkgVersion === '0.0.0') return [];
  const r = parsed.releases.find((x) => x.version === pkgVersion);
  if (!r || validDate(r.date) === null) {
    return [
      err(
        'changelog/bump-has-section',
        CL,
        `package version ${sv(pkgVersion)} needs a dated "## [${sv(pkgVersion)}] - YYYY-MM-DD" section`,
        r?.line,
      ),
    ];
  }
  return [];
}

export function checkChangelog(parsed, target, { now }) {
  const f = [];
  const idx = parsed.releases.findIndex((r) => r.version === target);
  const sec = parsed.releases[idx];
  if (!sec) {
    f.push(err('changelog/section', CL, `no section for version ${sv(target)}`));
  } else {
    if (idx !== 0) {
      f.push(err('changelog/section', CL, 'target section is not the topmost release', sec.line));
    }
    const ms = validDate(sec.date);
    if (ms === null) {
      f.push(
        err('changelog/section', CL, 'section date is missing or not a valid YYYY-MM-DD', sec.line),
      );
    } else if (ms > now.getTime() + 86_400_000) {
      f.push(err('changelog/section', CL, 'section date is in the future', sec.line));
    }
    if (!/^- /m.test(sec.body)) {
      f.push(err('changelog/section', CL, 'section has no bullet entries', sec.line));
    }
  }
  for (let i = 1; i < parsed.releases.length; i++) {
    const a = parsed.releases[i - 1];
    const b = parsed.releases[i];
    if (!a || !b) continue;
    if (!parseSemver(a.version) || !parseSemver(b.version)) {
      f.push(err('changelog/section', CL, 'release heading is not a valid version', b.line));
    } else if (compareSemver(a.version, b.version) <= 0) {
      f.push(err('changelog/section', CL, 'releases are not in descending order', b.line));
    }
  }
  if (parsed.unreleased && parsed.unreleased.body.trim() !== '') {
    f.push(
      err(
        'changelog/unreleased',
        CL,
        'Unreleased must be empty; move its entries into the release section',
        parsed.unreleased.line,
      ),
    );
  }
  return f;
}

// ---------------------------------------------------------------- baseline and bump

export function pickBaseline({ tags = [], changelogVersions = [], registryLatest = null, target }) {
  const candidates = [];
  for (const t of tags) {
    if (/^v/.test(t)) candidates.push(t.slice(1));
  }
  candidates.push(...changelogVersions);
  if (registryLatest) candidates.push(registryLatest);
  let best = null;
  for (const c of candidates) {
    const p = parseSemver(c);
    if (!p || p.pre !== null) continue;
    if (target !== undefined && target !== null && c === target) continue;
    if (best === null || compareSemver(c, best) > 0) best = c;
  }
  return best;
}

export function checkBump(target, baseline) {
  if (baseline === null) {
    return [
      warn('release/bump', '-', 'no earlier release found; treating this as the first release'),
    ];
  }
  const t = parseSemver(target);
  if (!t || t.pre !== null) return [];
  const allowed = Object.values(nextVersions(baseline));
  if (!allowed.includes(target)) {
    return [
      err(
        'release/bump',
        '-',
        `version ${sv(target)} is not the next patch, minor or major after ${sv(baseline)} (allowed: ${allowed.join(', ')})`,
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------- static checks

function readmeStatusBlock(readme) {
  const lines = readme.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (/^\s*>/.test(lines[i] ?? '')) {
      const start = i;
      const block = [];
      while (i < lines.length && /^\s*>/.test(lines[i] ?? '')) block.push(lines[i++]);
      const text = normaliseReadme(block.join('\n'));
      if (/Status/i.test(text)) return { text, line: start + 1 };
    } else {
      i++;
    }
  }
  return null;
}

export function checkVersionSync({ pkgVersion, pluginTs, readme }) {
  const f = [];
  const m = /PLUGIN_VERSION\s*=\s*(['"])([^'"]*)\1/.exec(pluginTs);
  if (!m) {
    f.push(err('version-sync/plugin', 'src/plugin.ts', 'PLUGIN_VERSION literal not found'));
  } else if (m[2] !== pkgVersion) {
    f.push(
      err(
        'version-sync/plugin',
        'src/plugin.ts',
        `PLUGIN_VERSION does not equal package.json version ${sv(pkgVersion)}`,
        lineOf(pluginTs, m.index),
      ),
    );
  }
  const block = readmeStatusBlock(readme);
  if (!block) {
    f.push(err('version-sync/readme', 'README.md', 'Status blockquote not found'));
  } else {
    const versions = block.text.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g) ?? [];
    if (versions.length === 0) {
      f.push(
        err('version-sync/readme', 'README.md', 'Status blockquote states no version', block.line),
      );
    } else if (versions.some((v) => v !== pkgVersion)) {
      f.push(
        err(
          'version-sync/readme',
          'README.md',
          `Status blockquote version does not equal package.json version ${sv(pkgVersion)}`,
          block.line,
        ),
      );
    }
  }
  return f;
}

export function checkUploadHonesty({ mappingTs, pluginTs, readme, srcFiles }) {
  const f = [];
  const mapping = stripComments(mappingTs);
  if (!/\bPATH_RULES\b[^=;]*=\s*\[\s*\]\s*;/.test(mapping)) {
    f.push(
      err(
        'upload/mapping-empty',
        'src/mapping.ts',
        'PATH_RULES is not the empty list: upload work not approved; see AGENTS.md',
      ),
    );
  }
  if (!pluginTs.includes(NO_UPLOAD_COPY)) {
    f.push(
      err(
        'upload/status-copy',
        'src/plugin.ts',
        'the "upload not available" status copy is missing',
      ),
    );
  }
  const norm = normaliseReadme(readme);
  if (!README_UPLOAD_COPY.every((s) => norm.includes(s))) {
    f.push(err('upload/readme', 'README.md', 'README no longer says that upload is unavailable'));
  }
  for (const file of srcFiles) {
    file.text.split('\n').forEach((l, i) => {
      if (l.includes(INGEST_ROUTE)) {
        f.push(
          err(
            'upload/no-ingest-route',
            file.path,
            'ingest route referenced: upload work not approved; see AGENTS.md',
            i + 1,
          ),
        );
      }
    });
  }
  return f;
}

export function checkContractDoc({ contractTs, apiMd }) {
  const c = /CONTRACT_VERSION\s*=\s*(\d+)/.exec(contractTs);
  const d = /current contract is `(\d+)`/.exec(apiMd.replace(/\s+/g, ' '));
  if (!c) return [err('contract/doc', 'src/contract.ts', 'CONTRACT_VERSION literal not found')];
  if (!d) return [err('contract/doc', 'docs/api.md', 'current contract statement not found')];
  if (c[1] !== d[1]) {
    return [
      err('contract/doc', 'docs/api.md', 'stated current contract differs from CONTRACT_VERSION'),
    ];
  }
  return [];
}

const STALE_COPY = [/not yet published/i, /once published/i];

export function checkReadmeReleased({ readme, changelogSection }) {
  const f = [];
  const norm = normaliseReadme(readme);
  if (STALE_COPY.some((re) => re.test(norm))) {
    f.push(
      err(
        'readme/released-copy',
        'README.md',
        'README still says the package is not yet published',
      ),
    );
  }
  if (changelogSection !== undefined && STALE_COPY.some((re) => re.test(changelogSection))) {
    f.push(
      err(
        'readme/released-copy',
        CL,
        'release section still says the package is not yet published',
      ),
    );
  }
  return f;
}

export function checkVersionArg(target, pkgVersion) {
  const p = parseSemver(target);
  if (!p) return [err('release/version-arg', '-', 'version is not strict X.Y.Z semver')];
  if (p.pre !== null) {
    return [err('release/version-arg', '-', 'prerelease versions are not supported yet')];
  }
  if (target !== pkgVersion) {
    return [
      err(
        'release/version-arg',
        'package.json',
        `version ${sv(target)} differs from package.json version ${sv(pkgVersion)}`,
      ),
    ];
  }
  return [];
}

// ---------------------------------------------------------------- git state

export function checkGitState({ porcelain, head, originMain, preTag, tagLocal, tagRemote }) {
  const f = [];
  if (porcelain.trim() !== '') {
    f.push(err('git/clean', '-', 'working tree has uncommitted or untracked changes'));
  }
  if (preTag) {
    if (head !== originMain) {
      f.push(
        err(
          'git/at-origin-main',
          '-',
          'HEAD is not origin/main; git fetch origin; release from the merged commit',
        ),
      );
    }
    if (tagLocal || tagRemote === true) {
      f.push(err('git/tag-absent', '-', 'the release tag already exists'));
    }
  }
  return f;
}

export function checkTagMatch(tag, pkgVersion) {
  return tag === `v${pkgVersion}`
    ? []
    : [err('tag/match', 'package.json', `tag ${tag} does not equal v${sv(pkgVersion)}`)];
}

export function checkTagAncestry({ isAncestor }) {
  return isAncestor
    ? []
    : [err('tag/on-main', '-', 'tagged commit is not reachable from origin/main')];
}

// ---------------------------------------------------------------- registry

export function registryUrl(name) {
  if (!NPM_NAME_RE.test(name)) throw new EnvError('invalid package name');
  return REGISTRY + (name.startsWith('@') ? name.replace('/', '%2F') : name);
}

export async function fetchRegistry(name, { fetch: fetchFn, timeoutMs = 10_000 }) {
  const url = registryUrl(name);
  let res;
  try {
    res = await fetchFn(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new EnvError('npm registry unreachable');
  }
  if (res.status === 404) return { status: 'unpublished' };
  if (!res.ok) throw new EnvError('npm registry returned an unexpected status');
  let body;
  try {
    body = await res.json();
  } catch {
    throw new EnvError('npm registry returned malformed data');
  }
  if (typeof body !== 'object' || body === null) {
    throw new EnvError('npm registry returned malformed data');
  }
  const tags =
    typeof body['dist-tags'] === 'object' && body['dist-tags'] !== null ? body['dist-tags'] : {};
  const versions = typeof body.versions === 'object' && body.versions !== null ? body.versions : {};
  return {
    status: 'published',
    latest: typeof tags.latest === 'string' ? tags.latest : null,
    versions,
  };
}

export function checkRegistry(target, reg) {
  if (reg.status === 'unpublished') return [];
  if (Object.hasOwn(reg.versions, target)) {
    return [err('registry/not-published', '-', `version ${sv(target)} is already on npm`)];
  }
  if (reg.latest && parseSemver(reg.latest) && compareSemver(target, reg.latest) <= 0) {
    return [
      err(
        'registry/bump',
        '-',
        `version ${sv(target)} is not above the npm latest ${sv(reg.latest)}`,
      ),
    ];
  }
  return [];
}

export function checkVerify(version, reg) {
  const entry = reg.status === 'published' ? reg.versions[version] : undefined;
  if (!entry) return [err('verify/present', '-', `version ${sv(version)} is not on npm`)];
  const f = [];
  if (reg.latest !== version) {
    f.push(err('verify/latest', '-', `npm latest tag is not ${sv(version)}`));
  }
  if (!entry.dist?.attestations) {
    f.push(
      warn(
        'verify/provenance',
        '-',
        'no provenance attestation found (expected for a manual publish)',
      ),
    );
  }
  return f;
}

// ---------------------------------------------------------------- context

function readFile(root, rel) {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch {
    throw new EnvError(`cannot read ${rel}`);
  }
}

function walkSrc(root, rel) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    throw new EnvError('cannot read src/');
  }
  for (const e of entries) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...walkSrc(root, p));
    else if (e.isFile()) out.push({ path: p, text: readFile(root, p) });
  }
  return out;
}

function loadContext(root) {
  let pkg;
  try {
    pkg = JSON.parse(readFile(root, 'package.json'));
  } catch (e) {
    if (e instanceof EnvError) throw e;
    throw new EnvError('package.json is not valid JSON');
  }
  if (typeof pkg?.version !== 'string' || typeof pkg?.name !== 'string') {
    throw new EnvError('package.json lacks name or version');
  }
  return {
    pkgName: pkg.name,
    pkgVersion: pkg.version,
    pluginTs: readFile(root, 'src/plugin.ts'),
    mappingTs: readFile(root, 'src/mapping.ts'),
    contractTs: readFile(root, 'src/contract.ts'),
    readme: readFile(root, 'README.md'),
    apiMd: readFile(root, 'docs/api.md'),
    changelogText: readFile(root, CL),
    srcFiles: walkSrc(root, 'src'),
  };
}

function ciFindings(ctx, parsed) {
  return [
    ...checkVersionSync(ctx),
    ...checkChangelogDated(parsed, ctx.pkgVersion),
    ...checkContractDoc(ctx),
    ...checkUploadHonesty(ctx),
  ];
}

// ---------------------------------------------------------------- git helpers

function makeGit(deps) {
  const run = (args) => {
    try {
      return deps.git(args);
    } catch (e) {
      if (e && typeof e === 'object' && e.status === 1) return null;
      throw new EnvError('git is unavailable or a git command failed');
    }
  };
  return {
    /** stdout, or null when git exited 1; other failures are environment errors. */
    run,
    out: (args) => {
      const r = run(args);
      if (r === null) throw new EnvError('git is unavailable or a git command failed');
      return r;
    },
    originMain: () => {
      const r = run(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main^{commit}']);
      if (r === null || r.trim() === '')
        throw new EnvError('origin/main not found; run git fetch origin');
      return r.trim();
    },
  };
}

function listTags(git) {
  return git
    .out(['tag', '-l', 'v*.*.*'])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- modes

function bulletCounts(body) {
  const counts = [];
  let cur = null;
  for (const l of body.split('\n')) {
    const h = /^### (.+?)\s*$/.exec(l);
    if (h) {
      cur = { heading: h[1], count: 0 };
      counts.push(cur);
    } else if (/^- /.test(l)) {
      if (!cur) {
        cur = { heading: '(no heading)', count: 0 };
        counts.push(cur);
      }
      cur.count++;
    }
  }
  return counts;
}

async function registryLatestFor(ctx, deps) {
  const reg = await fetchRegistry(ctx.pkgName, { fetch: deps.fetch });
  return reg;
}

async function runPlan(ctx, parsed, opts, deps, git) {
  const reg = opts.online ? await registryLatestFor(ctx, deps) : null;
  const baseline = pickBaseline({
    tags: listTags(git),
    changelogVersions: parsed.releases
      .filter((r) => validDate(r.date) !== null)
      .map((r) => r.version),
    registryLatest: reg?.status === 'published' ? reg.latest : null,
    target: null,
  });
  deps.stdout(`baseline: ${baseline ?? '(none; first release)'}`);
  if (baseline === null) {
    deps.stdout('allowed next versions: any of 0.0.1, 0.1.0, 1.0.0 (first release)');
  } else {
    const n = nextVersions(baseline);
    deps.stdout(`allowed next versions: patch ${n.patch}, minor ${n.minor}, major ${n.major}`);
  }
  if (!parsed.unreleased) {
    deps.stdout('Unreleased: (no section)');
  } else {
    const counts = bulletCounts(parsed.unreleased.body);
    deps.stdout('Unreleased entries:');
    if (counts.length === 0) deps.stdout('  (none)');
    for (const c of counts) deps.stdout(`  ${c.heading}: ${c.count}`);
  }
  return 0;
}

async function runRelease(ctx, parsed, opts, deps, git) {
  const { target, mode } = opts;
  const now = deps.now();
  const f = [...ciFindings(ctx, parsed)];
  f.push(...checkVersionArg(target, ctx.pkgVersion));
  if (mode === 'tag') f.push(...checkTagMatch(opts.tag, ctx.pkgVersion));
  const reg = opts.online ? await registryLatestFor(ctx, deps) : null;
  const baseline = pickBaseline({
    tags: listTags(git),
    changelogVersions: parsed.releases
      .filter((r) => validDate(r.date) !== null)
      .map((r) => r.version),
    registryLatest: reg?.status === 'published' ? reg.latest : null,
    target,
  });
  if (parseSemver(target)?.pre === null) f.push(...checkBump(target, baseline));
  f.push(...checkChangelog(parsed, target, { now }));
  const section = parsed.releases.find((r) => r.version === target);
  f.push(...checkReadmeReleased({ readme: ctx.readme, changelogSection: section?.body }));
  if (reg) f.push(...checkRegistry(target, reg));
  if (mode === 'release') {
    const porcelain = git.out(['status', '--porcelain']);
    let head = '';
    let originMain = '';
    let tagLocal = false;
    let tagRemote = null;
    if (opts.preTag) {
      head = git.out(['rev-parse', 'HEAD']).trim();
      originMain = git.originMain();
      tagLocal = git.out(['tag', '-l', `v${target}`]).trim() !== '';
      if (opts.online) {
        tagRemote =
          git.out(['ls-remote', '--tags', 'origin', `refs/tags/v${target}`]).trim() !== '';
      }
    }
    f.push(
      ...checkGitState({ porcelain, head, originMain, preTag: opts.preTag, tagLocal, tagRemote }),
    );
  } else {
    git.originMain();
    const isAncestor =
      git.run(['merge-base', '--is-ancestor', 'HEAD', 'refs/remotes/origin/main']) !== null;
    f.push(...checkTagAncestry({ isAncestor }));
  }
  return f;
}

// ---------------------------------------------------------------- CLI

function parseArgs(argv) {
  const o = { modes: [], online: false, preTag: false };
  const takeVal = (i, kind) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return null;
    o.modes.push({ kind, value: v });
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--ci' || a === '--plan' || a === '--help') o.modes.push({ kind: a.slice(2) });
    else if (a === '--online') o.online = true;
    else if (a === '--pre-tag') o.preTag = true;
    else if (
      a === '--release' ||
      a === '--tag' ||
      a === '--verify-published' ||
      a === '--print-notes'
    ) {
      if (takeVal(i, a.slice(2)) === null) return { error: true };
      i++;
    } else return { error: true };
  }
  return o;
}

export async function main(argv, deps = {}) {
  const root = deps.root ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const d = {
    fetch: globalThis.fetch,
    now: () => new Date(),
    git: (args) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }),
    stdout: (s) => process.stdout.write(`${s}\n`),
    stderr: (s) => process.stderr.write(`${s}\n`),
    ...deps,
    root,
  };
  const usage = (msg) => {
    d.stderr(`release-check: ${msg}`);
    d.stderr(USAGE);
    return 2;
  };
  const o = parseArgs(argv);
  if (o.error) return usage('invalid arguments');
  if (o.modes.length !== 1) return usage('exactly one mode is required');
  const mode = o.modes[0];
  if (mode.kind === 'help') {
    if (o.online || o.preTag) return usage('--help takes no options');
    d.stdout(USAGE);
    return 0;
  }
  if (o.preTag && mode.kind !== 'release') return usage('--pre-tag only applies to --release');
  if (o.online && !['plan', 'release', 'tag'].includes(mode.kind)) {
    return usage('--online does not apply to this mode');
  }
  let target = mode.value;
  if (mode.kind === 'tag') {
    if (!target?.startsWith('v') || !parseSemver(target.slice(1)))
      return usage('--tag needs vX.Y.Z');
    target = target.slice(1);
  } else if (target !== undefined && !parseSemver(target)) {
    return usage(`--${mode.kind} needs X.Y.Z`);
  }
  try {
    const ctx = loadContext(d.root);
    const parsed = parseChangelog(ctx.changelogText);
    const git = makeGit(d);
    let findings;
    if (mode.kind === 'ci') {
      findings = ciFindings(ctx, parsed);
    } else if (mode.kind === 'plan') {
      return await runPlan(ctx, parsed, o, d, git);
    } else if (mode.kind === 'print-notes') {
      const sec = parsed.releases.find((r) => r.version === target);
      if (!sec) {
        d.stdout(
          formatFindings([err('changelog/section', CL, `no section for version ${sv(target)}`)]),
        );
        return 1;
      }
      d.stdout(sec.body.trim());
      return 0;
    } else if (mode.kind === 'verify-published') {
      const reg = await fetchRegistry(ctx.pkgName, { fetch: d.fetch });
      findings = checkVerify(target, reg);
    } else {
      findings = await runRelease(
        ctx,
        parsed,
        { mode: mode.kind, target, tag: mode.value, preTag: o.preTag, online: o.online },
        d,
        git,
      );
    }
    d.stdout(formatFindings(findings));
    return findings.some((x) => x.sev === 'ERROR') ? 1 : 0;
  } catch (e) {
    if (e instanceof EnvError) {
      d.stderr(`release-check: environment error: ${e.message}`);
      return 3;
    }
    throw e;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.stderr.write('release-check: unexpected internal error\n');
      process.exitCode = 3;
    },
  );
}
