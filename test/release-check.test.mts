import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EnvError,
  checkBump,
  checkChangelog,
  checkChangelogDated,
  checkContractDoc,
  checkGitState,
  checkReadmeReleased,
  checkRegistry,
  checkTagAncestry,
  checkTagMatch,
  checkUploadHonesty,
  checkVerify,
  checkVersionSync,
  compareSemver,
  fetchRegistry,
  formatFindings,
  main,
  nextVersions,
  parseChangelog,
  parseSemver,
  pickBaseline,
  registryUrl,
  type Finding,
  type MainDeps,
} from '../scripts/release-check.mjs';

const REAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NOW = new Date('2026-06-15T12:00:00Z');
const FAKE_VTI = 'vti_' + 'x'.repeat(43);

const ids = (f: Finding[]) => f.map((x) => x.id);

const PLUGIN = (v: string) =>
  `export const PLUGIN_VERSION = '${v}';\nconst NO_UPLOAD = 'Data upload is not available in this version.';\n`;
const MAPPING = 'export const PATH_RULES: readonly PathRule[] = [];\n';
const README = (v: string, extra = '') =>
  `# x\n\n> **Status: pre-release (${v}).** Connecting works. **Sending readings is not available\n> in this version yet**; the plugin says so. ${extra}\n\nUploading is not available yet.\n`;
const CHANGELOG_GOOD = `# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-06-01\n\n### Added\n\n- Pairing.\n`;

describe('semver', () => {
  it('accepts strict versions and rejects the rest', () => {
    for (const ok of ['0.0.0', '1.2.3', '10.20.30', '1.0.0-rc.1', '1.0.0-0', '1.0.0-alpha-1']) {
      expect(parseSemver(ok), ok).not.toBeNull();
    }
    for (const bad of [
      'v1.2.3',
      '01.2.3',
      '1.02.3',
      '1.2.03',
      '1.2',
      '1.2.3+build',
      '1.2.3-',
      '1.2.3-01',
      '',
      ' 1.2.3',
      '1.2.3.4',
    ]) {
      expect(parseSemver(bad), bad).toBeNull();
    }
    expect(parseSemver(3)).toBeNull();
  });

  it('orders versions as a total order (antisymmetry and transitivity)', () => {
    const vs = [
      '0.0.0',
      '0.0.1',
      '0.1.0',
      '1.0.0-alpha',
      '1.0.0-alpha.1',
      '1.0.0-alpha.beta',
      '1.0.0-beta',
      '1.0.0-beta.2',
      '1.0.0-beta.11',
      '1.0.0-rc.1',
      '1.0.0',
      '1.0.1',
      '1.1.0',
      '2.0.0',
      '10.0.0',
    ];
    for (const a of vs) {
      expect(compareSemver(a, a)).toBe(0);
      for (const b of vs) {
        expect(compareSemver(a, b) + compareSemver(b, a)).toBe(0);
        for (const c of vs) {
          if (compareSemver(a, b) <= 0 && compareSemver(b, c) <= 0) {
            expect(compareSemver(a, c)).toBeLessThanOrEqual(0);
          }
        }
      }
    }
    // The list above is sorted ascending, so every pair must compare accordingly.
    for (let i = 0; i < vs.length; i++) {
      for (let j = i + 1; j < vs.length; j++) {
        expect(compareSemver(vs[i] as string, vs[j] as string), `${vs[i]} < ${vs[j]}`).toBe(-1);
      }
    }
  });

  it('computes the allowed next versions', () => {
    expect(nextVersions('0.0.0')).toEqual({ patch: '0.0.1', minor: '0.1.0', major: '1.0.0' });
    expect(nextVersions('1.2.3')).toEqual({ patch: '1.2.4', minor: '1.3.0', major: '2.0.0' });
    expect(nextVersions('0.9.9').major).toBe('1.0.0');
  });
});

describe('pickBaseline and checkBump', () => {
  it('takes the highest non-prerelease version and excludes the target', () => {
    expect(
      pickBaseline({
        tags: ['v0.1.0', 'v0.2.0', 'nonsense', 'v1.0.0-rc.1'],
        changelogVersions: ['0.3.0', 'x'],
        registryLatest: '0.2.5',
        target: '0.3.0',
      }),
    ).toBe('0.2.5');
    expect(pickBaseline({ tags: ['v0.1.0'], target: '0.1.0' })).toBeNull();
    expect(pickBaseline({ target: '0.1.0' })).toBeNull();
    expect(pickBaseline({ tags: ['v0.0.1'], target: '0.1.0' })).toBe('0.0.1');
  });

  it('validates the bump', () => {
    expect(checkBump('0.1.0', '0.1.0')).toHaveLength(1); // equal
    expect(checkBump('0.3.0', '0.1.0')[0]?.sev).toBe('ERROR'); // skipped a minor
    expect(checkBump('0.0.9', '0.1.0')[0]?.sev).toBe('ERROR'); // lower
    expect(checkBump('0.2.0', '0.1.0')).toEqual([]);
    expect(checkBump('0.1.1', '0.1.0')).toEqual([]);
    expect(checkBump('1.0.0', '0.4.2')).toEqual([]);
    expect(checkBump('0.2.0-rc.1', '0.1.0')).toEqual([]); // reported by version-arg instead
    const first = checkBump('0.1.0', null);
    expect(first).toHaveLength(1);
    expect(first[0]?.sev).toBe('WARN');
  });
});

describe('changelog', () => {
  it('parses sections', () => {
    const p = parseChangelog(CHANGELOG_GOOD);
    expect(p.unreleased?.body.trim()).toBe('');
    expect(p.releases).toHaveLength(1);
    expect(p.releases[0]).toMatchObject({ version: '0.1.0', date: '2026-06-01' });
  });

  it('fails release mode on the repository CHANGELOG today', () => {
    const p = parseChangelog(readFileSync(join(REAL_ROOT, 'CHANGELOG.md'), 'utf8'));
    expect(ids(checkChangelog(p, '0.1.0', { now: NOW }))).toEqual([
      'changelog/section',
      'changelog/unreleased',
    ]);
  });

  it('passes a good changelog, with Unreleased absent or empty', () => {
    expect(checkChangelog(parseChangelog(CHANGELOG_GOOD), '0.1.0', { now: NOW })).toEqual([]);
    const noUnreleased = '# C\n\n## [0.1.0] - 2026-06-01\n\n- a\n';
    expect(checkChangelog(parseChangelog(noUnreleased), '0.1.0', { now: NOW })).toEqual([]);
  });

  it('rejects bad sections', () => {
    const run = (text: string) => checkChangelog(parseChangelog(text), '0.1.0', { now: NOW });
    expect(ids(run('## [0.1.0] - 2026-06-17\n\n- a\n'))).toContain('changelog/section'); // future
    expect(run('## [0.1.0] - 2026-06-16\n\n- a\n')).toEqual([]); // within one day
    expect(ids(run('## [0.1.0] - 2026-13-01\n\n- a\n'))).toContain('changelog/section');
    expect(ids(run('## [0.1.0] - 2026-02-30\n\n- a\n'))).toContain('changelog/section');
    expect(ids(run('## [0.1.0]\n\n- a\n'))).toContain('changelog/section'); // no date
    expect(ids(run('## [0.1.0] - 2026-06-01\n\nProse only.\n'))).toContain('changelog/section');
    expect(
      ids(run('## [0.2.0] - 2026-06-02\n\n- a\n\n## [0.1.0] - 2026-06-01\n\n- b\n')),
    ).toContain('changelog/section'); // not topmost
    expect(
      ids(run('## [0.1.0] - 2026-06-02\n\n- a\n\n## [0.2.0] - 2026-06-01\n\n- b\n')),
    ).toContain('changelog/section'); // wrong order
    expect(ids(run('## [Unreleased]\n\n- stuff\n\n## [0.1.0] - 2026-06-01\n\n- a\n'))).toEqual([
      'changelog/unreleased',
    ]);
  });

  it('requires a dated section once the version is bumped', () => {
    const p = parseChangelog(CHANGELOG_GOOD);
    expect(checkChangelogDated(p, '0.0.0')).toEqual([]);
    expect(checkChangelogDated(p, '0.1.0')).toEqual([]);
    expect(ids(checkChangelogDated(p, '0.2.0'))).toEqual(['changelog/bump-has-section']);
    expect(ids(checkChangelogDated(parseChangelog('## [0.2.0]\n\n- a\n'), '0.2.0'))).toEqual([
      'changelog/bump-has-section',
    ]);
  });
});

describe('version sync', () => {
  it('passes for the repository files', () => {
    const f = (p: string) => readFileSync(join(REAL_ROOT, p), 'utf8');
    const pkg = JSON.parse(f('package.json')) as { version: string };
    expect(
      checkVersionSync({
        pkgVersion: pkg.version,
        pluginTs: f('src/plugin.ts'),
        readme: f('README.md'),
      }),
    ).toEqual([]);
  });

  it('flags mismatches and a missing literal', () => {
    expect(
      ids(
        checkVersionSync({
          pkgVersion: '0.1.0',
          pluginTs: PLUGIN('0.0.0'),
          readme: README('0.1.0'),
        }),
      ),
    ).toEqual(['version-sync/plugin']);
    expect(
      ids(
        checkVersionSync({
          pkgVersion: '0.1.0',
          pluginTs: PLUGIN('0.1.0'),
          readme: README('0.0.0'),
        }),
      ),
    ).toEqual(['version-sync/readme']);
    expect(
      ids(
        checkVersionSync({
          pkgVersion: '0.1.0',
          pluginTs: 'const x = 1;',
          readme: README('0.1.0'),
        }),
      ),
    ).toEqual(['version-sync/plugin']);
    expect(
      ids(
        checkVersionSync({
          pkgVersion: '0.1.0',
          pluginTs: PLUGIN('0.1.0'),
          readme: '# no status\n',
        }),
      ),
    ).toEqual(['version-sync/readme']);
    expect(
      ids(
        checkVersionSync({
          pkgVersion: '0.1.0',
          pluginTs: PLUGIN('0.1.0'),
          readme: '> Status: none\n',
        }),
      ),
    ).toEqual(['version-sync/readme']);
  });
});

describe('upload honesty', () => {
  const base = () => ({
    mappingTs: MAPPING,
    pluginTs: PLUGIN('0.0.0'),
    readme: README('0.0.0'),
    srcFiles: [{ path: 'src/a.ts', text: 'export const a = 1;\n' }],
  });

  it('passes for the repository files', () => {
    const f = (p: string) => readFileSync(join(REAL_ROOT, p), 'utf8');
    expect(
      checkUploadHonesty({
        mappingTs: f('src/mapping.ts'),
        pluginTs: f('src/plugin.ts'),
        readme: f('README.md'),
        srcFiles: [{ path: 'src/plugin.ts', text: f('src/plugin.ts') }],
      }),
    ).toEqual([]);
  });

  it('passes with the README wording split across blockquote lines and bold markers', () => {
    expect(checkUploadHonesty(base())).toEqual([]);
  });

  it('fails when PATH_RULES is not empty, even if a comment says it is', () => {
    const mappingTs = `// PATH_RULES = [];\nexport const PATH_RULES: readonly PathRule[] = [{ pattern: 'a.*.b', category: 'tanks' }];\n`;
    expect(ids(checkUploadHonesty({ ...base(), mappingTs }))).toEqual(['upload/mapping-empty']);
    expect(ids(checkUploadHonesty({ ...base(), mappingTs: '' }))).toEqual(['upload/mapping-empty']);
  });

  it('fails when the status copy or README wording is removed', () => {
    expect(
      ids(checkUploadHonesty({ ...base(), pluginTs: PLUGIN('0.0.0').split('\n')[0] ?? '' })),
    ).toEqual(['upload/status-copy']);
    expect(ids(checkUploadHonesty({ ...base(), readme: '> Status: 0.0.0\n' }))).toEqual([
      'upload/readme',
    ]);
  });

  it('fails when an ingest route appears in src, with a line number', () => {
    const srcFiles = [
      { path: 'src/u.ts', text: "a;\nfetch('/v1/integrations/signalk/ingest');\n" },
    ];
    const f = checkUploadHonesty({ ...base(), srcFiles });
    expect(ids(f)).toEqual(['upload/no-ingest-route']);
    expect(f[0]).toMatchObject({ file: 'src/u.ts', line: 2 });
  });
});

describe('contract doc', () => {
  it('compares the stated contract with CONTRACT_VERSION', () => {
    const c = 'export const CONTRACT_VERSION = 1;';
    expect(
      checkContractDoc({ contractTs: c, apiMd: "The plugin's current\ncontract is `1`." }),
    ).toEqual([]);
    expect(
      ids(checkContractDoc({ contractTs: c, apiMd: "The plugin's current contract is `2`." })),
    ).toEqual(['contract/doc']);
    expect(ids(checkContractDoc({ contractTs: c, apiMd: 'nothing' }))).toEqual(['contract/doc']);
    expect(ids(checkContractDoc({ contractTs: '', apiMd: 'current contract is `1`' }))).toEqual([
      'contract/doc',
    ]);
  });
});

describe('released copy', () => {
  it('flags not-yet-published wording in README and the section', () => {
    expect(checkReadmeReleased({ readme: README('0.1.0'), changelogSection: '- a' })).toEqual([]);
    expect(
      ids(checkReadmeReleased({ readme: README('0.1.0', 'It is not yet\n> published to npm.') })),
    ).toEqual(['readme/released-copy']);
    expect(
      ids(checkReadmeReleased({ readme: 'Once published: install', changelogSection: '' })),
    ).toEqual(['readme/released-copy']);
    expect(
      checkReadmeReleased({
        readme: README('0.1.0'),
        changelogSection: 'Not yet published to npm.',
      })[0]?.file,
    ).toBe('CHANGELOG.md');
  });
});

describe('git state', () => {
  const clean = {
    porcelain: '',
    head: 'a',
    originMain: 'a',
    preTag: true,
    tagLocal: false,
    tagRemote: false,
  };
  it('combines clean, origin/main and tag checks', () => {
    expect(checkGitState(clean)).toEqual([]);
    expect(ids(checkGitState({ ...clean, porcelain: ' M x' }))).toEqual(['git/clean']);
    expect(ids(checkGitState({ ...clean, head: 'b' }))).toEqual(['git/at-origin-main']);
    expect(ids(checkGitState({ ...clean, tagLocal: true }))).toEqual(['git/tag-absent']);
    expect(ids(checkGitState({ ...clean, tagRemote: true }))).toEqual(['git/tag-absent']);
    expect(ids(checkGitState({ ...clean, porcelain: '?? y', head: 'b', tagLocal: true }))).toEqual([
      'git/clean',
      'git/at-origin-main',
      'git/tag-absent',
    ]);
    // Without --pre-tag, only cleanliness matters.
    expect(checkGitState({ ...clean, preTag: false, head: 'b', tagLocal: true })).toEqual([]);
  });

  it('checks the tag name and ancestry', () => {
    expect(checkTagMatch('v0.1.0', '0.1.0')).toEqual([]);
    expect(ids(checkTagMatch('v0.1.0', '0.2.0'))).toEqual(['tag/match']);
    expect(checkTagAncestry({ isAncestor: true })).toEqual([]);
    expect(ids(checkTagAncestry({ isAncestor: false }))).toEqual(['tag/on-main']);
  });
});

describe('registry', () => {
  const resp = (status: number, body: unknown) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

  it('builds URLs, encoding scoped names', () => {
    expect(registryUrl('signalk-vesseltwin')).toBe('https://registry.npmjs.org/signalk-vesseltwin');
    expect(registryUrl('@jclima/signalk-vesseltwin')).toBe(
      'https://registry.npmjs.org/@jclima%2Fsignalk-vesseltwin',
    );
    expect(() => registryUrl('../x')).toThrow(EnvError);
  });

  it('maps 404 to unpublished and everything odd to an environment error', async () => {
    expect(await fetchRegistry('p', { fetch: () => Promise.resolve(resp(404, {})) })).toEqual({
      status: 'unpublished',
    });
    const ok = await fetchRegistry('p', {
      fetch: () =>
        Promise.resolve(resp(200, { 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {} } })),
    });
    expect(ok).toMatchObject({ status: 'published', latest: '1.0.0' });
    await expect(
      fetchRegistry('p', { fetch: () => Promise.resolve(resp(500, {})) }),
    ).rejects.toThrow(EnvError);
    await expect(
      fetchRegistry('p', { fetch: () => Promise.reject(new Error('down')) }),
    ).rejects.toThrow(EnvError);
    await expect(
      fetchRegistry('p', { fetch: () => Promise.resolve(resp(200, '{not json')) }),
    ).rejects.toThrow(EnvError);
    await expect(
      fetchRegistry('p', { fetch: () => Promise.resolve(resp(200, 'null')) }),
    ).rejects.toThrow(EnvError);
  });

  it('checks not-published and bump', () => {
    const reg = { status: 'published' as const, latest: '0.2.0', versions: { '0.2.0': {} } };
    expect(checkRegistry('0.3.0', reg)).toEqual([]);
    expect(ids(checkRegistry('0.2.0', reg))).toEqual(['registry/not-published']);
    expect(ids(checkRegistry('0.1.0', reg))).toEqual(['registry/bump']);
    expect(checkRegistry('0.1.0', { status: 'unpublished' })).toEqual([]);
  });

  it('verifies a published version', () => {
    const reg = (attest: boolean, latest = '0.2.0') => ({
      status: 'published' as const,
      latest,
      versions: { '0.2.0': { dist: attest ? { attestations: { url: 'x' } } : {} } },
    });
    expect(checkVerify('0.2.0', reg(true))).toEqual([]);
    expect(checkVerify('0.2.0', reg(false)).map((f) => `${f.sev} ${f.id}`)).toEqual([
      'WARN verify/provenance',
    ]);
    expect(ids(checkVerify('0.2.0', reg(true, '0.1.0')))).toEqual(['verify/latest']);
    expect(ids(checkVerify('0.3.0', reg(true)))).toEqual(['verify/present']);
    expect(ids(checkVerify('0.2.0', { status: 'unpublished' }))).toEqual(['verify/present']);
  });
});

describe('formatFindings', () => {
  it('prints lines and a summary, never file text', () => {
    const f = checkUploadHonesty({
      mappingTs: `export const PATH_RULES = [{ pattern: '${FAKE_VTI}' }];`,
      pluginTs: `const s = '${FAKE_VTI}';`,
      readme: FAKE_VTI,
      srcFiles: [{ path: 'src/x.ts', text: `${FAKE_VTI} /v1/integrations/signalk/x` }],
    });
    const out = formatFindings(f);
    expect(out).not.toContain(FAKE_VTI);
    expect(out).toContain('ERROR upload/no-ingest-route  src/x.ts:1  ');
    expect(out.split('\n').at(-1)).toBe('release-check: 4 error(s), 0 warning(s)');
    expect(formatFindings([])).toBe('release-check: ok');
    expect(formatFindings([{ sev: 'WARN', id: 'a/b', file: '-', line: 0, message: 'm' }])).toBe(
      'WARN a/b  -  m\nrelease-check: 0 error(s), 1 warning(s)',
    );
  });
});

// ------------------------------------------------------------------ main() against temp repos

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'release-check-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const git = (...args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );

function write(rel: string, text: string) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
}

function mkRepo(
  version = '0.1.0',
  o: { readme?: string; changelog?: string; plugin?: string; commit?: boolean } = {},
) {
  write('package.json', JSON.stringify({ name: 'signalk-vesseltwin', version }));
  write('src/plugin.ts', o.plugin ?? PLUGIN(version));
  write('src/mapping.ts', MAPPING);
  write('src/contract.ts', 'export const CONTRACT_VERSION = 1;\n');
  write('README.md', o.readme ?? README(version));
  write('docs/api.md', "The plugin's current contract is `1`.\n");
  write('CHANGELOG.md', o.changelog ?? CHANGELOG_GOOD);
  if (o.commit !== false) {
    git('init', '-q', '-b', 'main');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  }
}

async function run(argv: string[], extra: MainDeps = {}) {
  const out: string[] = [];
  const errs: string[] = [];
  const code = await main(argv, {
    root: dir,
    now: () => NOW,
    fetch: () => Promise.reject(new Error('network is not allowed in tests')),
    stdout: (s) => out.push(s),
    stderr: (s) => errs.push(s),
    ...extra,
  });
  return { code, out: out.join('\n'), err: errs.join('\n') };
}

describe('main --ci', () => {
  it('passes, then fails after a PLUGIN_VERSION mismatch', async () => {
    mkRepo();
    expect((await run(['--ci'])).code).toBe(0);
    write('src/plugin.ts', PLUGIN('9.9.9'));
    const r = await run(['--ci']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR version-sync/plugin');
  });

  it('does not need git', async () => {
    mkRepo('0.1.0', { commit: false });
    const r = await run(['--ci'], {
      git: () => {
        throw new Error('no git');
      },
    });
    expect(r.code).toBe(0);
  });

  it('passes on the real repository', async () => {
    const out: string[] = [];
    const code = await main(['--ci'], { root: REAL_ROOT, stdout: (s) => out.push(s) });
    expect(out.join('\n')).toBe('release-check: ok');
    expect(code).toBe(0);
  });

  it('exits 3 when a file is missing', async () => {
    mkRepo();
    rmSync(join(dir, 'README.md'));
    expect((await run(['--ci'])).code).toBe(3);
  });
});

describe('main usage', () => {
  it('returns 2 for usage errors and 0 for --help', async () => {
    mkRepo();
    for (const argv of [
      [],
      ['--ci', '--plan'],
      ['--bogus'],
      ['--release'],
      ['--release', 'v0.1.0'],
      ['--release', '0.1'],
      ['--tag', '0.1.0'],
      ['--tag', 'v1'],
      ['--ci', '--pre-tag'],
      ['--ci', '--online'],
      ['--verify-published'],
      ['--print-notes', '--online'],
      ['--help', '--online'],
    ]) {
      expect((await run(argv)).code, argv.join(' ')).toBe(2);
    }
    const h = await run(['--help']);
    expect(h.code).toBe(0);
    expect(h.out).toContain('Exit codes');
  });
});

describe('main --tag and --release', () => {
  it('fails --tag when the tag does not match package.json', async () => {
    mkRepo('0.2.0', {
      changelog: '## [Unreleased]\n\n## [0.2.0] - 2026-06-01\n\n- a\n',
    });
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const r = await run(['--tag', 'v0.1.0']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR tag/match');
  });

  it('passes --tag when the tag already exists locally (the baseline excludes the target)', async () => {
    mkRepo();
    git('tag', '-a', 'v0.1.0', '-m', 'v0.1.0');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const r = await run(['--tag', 'v0.1.0']);
    expect(r.out).not.toContain('ERROR');
    expect(r.out).toContain('WARN release/bump');
    expect(r.code).toBe(0);
  });

  it('uses an earlier tag as the baseline and enforces the bump', async () => {
    mkRepo('0.3.0', { changelog: '## [Unreleased]\n\n## [0.3.0] - 2026-06-01\n\n- a\n' });
    git('tag', 'v0.1.0');
    git('tag', 'v0.3.0');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    const r = await run(['--tag', 'v0.3.0']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR release/bump');
  });

  it('returns 3 for --tag without an origin/main ref', async () => {
    mkRepo();
    git('tag', 'v0.1.0');
    const r = await run(['--tag', 'v0.1.0']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('origin/main');
  });

  it('flags a tag commit that is not on origin/main', async () => {
    mkRepo();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    write('extra.txt', 'x');
    git('add', '.');
    git('commit', '-q', '-m', 'ahead');
    const r = await run(['--tag', 'v0.1.0']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR tag/on-main');
  });

  it('--release --pre-tag checks origin/main and tag absence', async () => {
    mkRepo();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect((await run(['--release', '0.1.0', '--pre-tag'])).code).toBe(0);
    git('tag', 'v0.1.0');
    const r = await run(['--release', '0.1.0', '--pre-tag']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR git/tag-absent');
    // Without origin/main the pre-tag gate cannot run.
    git('update-ref', '-d', 'refs/remotes/origin/main');
    expect((await run(['--release', '0.1.0', '--pre-tag'])).code).toBe(3);
  });

  it('--release reports a dirty tree', async () => {
    mkRepo();
    write('stray.txt', 'x');
    const r = await run(['--release', '0.1.0']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR git/clean');
  });

  it('exits 3 when git is unavailable for a git gate', async () => {
    mkRepo();
    const r = await run(['--release', '0.1.0'], {
      git: () => {
        throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
      },
    });
    expect(r.code).toBe(3);
  });
});

describe('main --online and registry modes', () => {
  const reg = (status: number, body: unknown) => () =>
    Promise.resolve(
      new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }),
    );

  it('treats registry failures as environment errors, never a pass', async () => {
    mkRepo();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    expect((await run(['--release', '0.1.0', '--online'], { fetch: reg(500, {}) })).code).toBe(3);
    expect(
      (await run(['--release', '0.1.0', '--online'], { fetch: reg(200, '<html>') })).code,
    ).toBe(3);
    expect(
      (
        await run(['--release', '0.1.0', '--online'], {
          fetch: () => Promise.reject(new Error('x')),
        })
      ).code,
    ).toBe(3);
    expect((await run(['--verify-published', '0.1.0'], { fetch: reg(503, {}) })).code).toBe(3);
  });

  it('passes --release --online for an unpublished package and fails for a published version', async () => {
    mkRepo();
    expect((await run(['--release', '0.1.0', '--online'], { fetch: reg(404, {}) })).code).toBe(0);
    const published = reg(200, { 'dist-tags': { latest: '0.1.0' }, versions: { '0.1.0': {} } });
    const r = await run(['--release', '0.1.0', '--online'], { fetch: published });
    expect(r.code).toBe(1);
    expect(r.out).toContain('ERROR registry/not-published');
  });

  it('--verify-published reports present, latest and provenance', async () => {
    mkRepo();
    const body = {
      'dist-tags': { latest: '0.1.0' },
      versions: { '0.1.0': { dist: { attestations: { url: 'u' } } } },
    };
    const good = await run(['--verify-published', '0.1.0'], { fetch: reg(200, body) });
    expect(good.code).toBe(0);
    const noAttest = await run(['--verify-published', '0.1.0'], {
      fetch: reg(200, { ...body, versions: { '0.1.0': { dist: {} } } }),
    });
    expect(noAttest.code).toBe(0);
    expect(noAttest.out).toContain('WARN verify/provenance');
    expect((await run(['--verify-published', '0.1.0'], { fetch: reg(404, {}) })).code).toBe(1);
  });
});

describe('main --plan and --print-notes', () => {
  it('prints the plan with bullet counts per heading', async () => {
    mkRepo('0.0.0', {
      changelog:
        '## [Unreleased]\n\n### Added\n\n- a\n- b\n\n### Fixed\n\n- c\n\n## [0.1.0] - 2026-06-01\n\n- x\n',
    });
    git('tag', 'v0.1.0');
    const r = await run(['--plan']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('baseline: 0.1.0');
    expect(r.out).toContain('patch 0.1.1, minor 0.2.0, major 1.0.0');
    expect(r.out).toContain('Added: 2');
    expect(r.out).toContain('Fixed: 1');
  });

  it('prints only the section body for --print-notes', async () => {
    mkRepo();
    const r = await run(['--print-notes', '0.1.0']);
    expect(r.code).toBe(0);
    expect(r.out).toBe('### Added\n\n- Pairing.');
    expect((await run(['--print-notes', '0.9.0'])).code).toBe(1);
  });
});
