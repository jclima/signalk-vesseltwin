import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkPackFiles,
  checkPaths,
  formatFindings,
  loadExtraPatterns,
  parseDenyPatterns,
  runRepoChecks,
  scanText,
} from '../scripts/check-public.mjs';

// Bad inputs are assembled at runtime so this file never contains them literally.
const HOME = ['', 'Users', 'someone', 'proj', 'x.ts'].join('/');
const LINUX_HOME = ['', 'home', 'someone', 'x'].join('/');
const AKIA = 'AK' + 'IA' + 'ABCDEFGHIJKLMNOP';
const REAL_LOOKING_VTI = 'vti_' + 'Q7x9ZkLm3Pw2RtYv8NaB5cDe1FgH4JsU6';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'check-public-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scanText', () => {
  it('flags personal paths, AWS key ids and credential-like tokens', () => {
    expect(scanText('a.md', `see ${HOME}`).map((f) => f.rule)).toContain(
      'personal-path: macOS home',
    );
    expect(scanText('a.md', LINUX_HOME).map((f) => f.rule)).toContain('personal-path: Linux home');
    expect(scanText('a.md', `key ${AKIA}`).map((f) => f.rule)).toContain('aws-access-key-id');
    expect(scanText('a.md', `x ${REAL_LOOKING_VTI}`).map((f) => f.rule)).toContain(
      'vti-credential-like',
    );
    expect(scanText('a.md', `Authorization: Bearer ${REAL_LOOKING_VTI}`).length).toBeGreaterThan(0);
  });

  it('reports line numbers and never the matched value', () => {
    const f = scanText('a.md', `ok\nok\n${AKIA}\n`);
    expect(f).toEqual([{ path: 'a.md', line: 3, rule: 'aws-access-key-id' }]);
    expect(formatFindings(f)).not.toContain(AKIA);
  });

  it('allows the container path and obvious fakes', () => {
    expect(scanText('a.yml', '/home/node/.signalk').length).toBe(0);
    for (const fake of [
      'vti_abcdefghijk',
      'vti_xxxxxxxxxx',
      'vti_secretsecret1',
      'vti_AbCdEf123456',
      'vti_ZZZZZZZZZZ',
      'vti_' + 'x'.repeat(43),
      'vti_fake_credential_value_for_tests',
      'vti_<43 url-safe chars>',
      'vti_[redacted]',
    ]) {
      expect(scanText('t.ts', `'${fake}'`), fake).toEqual([]);
    }
  });

  it('applies local deny patterns', () => {
    const extra = parseDenyPatterns('# comment\n\n(?i)secretproject\n\\bM[0-9]\\b\n');
    expect(scanText('a.md', 'about SecretProject', extra).length).toBe(1);
    expect(scanText('a.md', 'milestone ' + 'M' + '2', extra).length).toBe(1);
    expect(scanText('a.md', 'signalk-vesseltwin m2m', extra).length).toBe(0);
  });
});

describe('checkPaths', () => {
  it('fails on forbidden filenames and directories', () => {
    for (const p of [
      'CLAUDE.local.md',
      'AGENTS.override.md',
      '.claude/settings.json',
      'sub/.cursor/rules',
      '.kiro/x',
      '.codex/x',
      '.windsurf/x',
      '.vscode/settings.json',
      '.idea/x',
      '.mcp.json',
      '.env',
      '.env.production',
      'notes.local.md',
      'a.pem',
      'b.key',
      '.npmrc',
      '.signalk-dev/settings.json',
      '.public-guard.local',
    ]) {
      expect(checkPaths([p]).length, p).toBeGreaterThan(0);
    }
  });

  it('passes normal repo files', () => {
    expect(
      checkPaths([
        'README.md',
        'src/plugin.ts',
        'AGENTS.md',
        'CLAUDE.md',
        '.github/workflows/ci.yml',
      ]),
    ).toEqual([]);
  });

  it('applies local deny patterns to paths', () => {
    expect(checkPaths(['docs/secretproject.md'], parseDenyPatterns('secretproject')).length).toBe(
      1,
    );
  });
});

describe('checkPackFiles', () => {
  it('accepts the allowed set', () => {
    expect(
      checkPackFiles([
        'plugin/index.js',
        'plugin/a/b.d.ts',
        'public/index.html',
        'README.md',
        'LICENSE',
        'SECURITY.md',
        'package.json',
      ]),
    ).toEqual([]);
  });
  it('accepts exactly the five pairing page files', () => {
    expect(
      checkPackFiles([
        'plugin/index.js',
        'public/index.html',
        'public/style.css',
        'public/app.js',
        'public/view.js',
        'public/controller.js',
      ]),
    ).toEqual([]);
  });
  it('rejects other files under public/', () => {
    const bad = [
      'public/x.js',
      'public/app.js.map',
      'public/app.d.ts',
      'public/sub/app.js',
      'public/',
      'web/app.ts',
    ];
    expect(
      checkPackFiles(['plugin/index.js', 'public/index.html', ...bad]).map((f) => f.path),
    ).toEqual(bad);
  });
  it('rejects extras and an empty plugin dir', () => {
    expect(
      checkPackFiles(['plugin/index.js', 'public/index.html', 'docs/api.md']).map((f) => f.path),
    ).toEqual(['docs/api.md']);
    expect(checkPackFiles(['README.md', 'public/index.html']).length).toBe(1);
  });
  it('requires public/index.html', () => {
    const f = checkPackFiles(['plugin/index.js', 'public/style.css']);
    expect(f).toEqual([
      {
        path: 'public/index.html',
        line: 0,
        rule: 'pack: tarball has no public/index.html (run pnpm build first)',
      },
    ]);
  });
});

describe('loadExtraPatterns', () => {
  it('reads .public-guard.local and PUBLIC_GUARD_EXTRA_FILE', () => {
    writeFileSync(join(dir, '.public-guard.local'), 'alpha\n');
    const extraFile = join(dir, 'extra.txt');
    writeFileSync(extraFile, 'beta\n');
    expect(loadExtraPatterns(dir, {}).length).toBe(1);
    expect(loadExtraPatterns(dir, { PUBLIC_GUARD_EXTRA_FILE: extraFile }).length).toBe(2);
  });
});

describe('runRepoChecks (temporary git repo)', () => {
  function git(...args: string[]) {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  }
  function init() {
    git('init', '-q');
    git('config', 'user.email', 't@example.invalid');
    git('config', 'user.name', 't');
  }

  it('passes on clean input', () => {
    init();
    writeFileSync(join(dir, 'README.md'), '# Hello\nSee /home/node/.signalk\n');
    git('add', '.');
    expect(runRepoChecks({ root: dir, env: {} })).toEqual([]);
  });

  it('fails on a tracked forbidden file, a home path, and a local pattern', () => {
    init();
    writeFileSync(join(dir, 'CLAUDE.local.md'), 'notes\n');
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'a.md'), `path ${HOME}\nthe Secretproject plan\n`);
    writeFileSync(join(dir, '.public-guard.local'), '(?i)secretproject\n');
    git('add', '-f', '.');
    const rules = runRepoChecks({ root: dir, env: {} }).map((f) => f.rule);
    expect(rules).toContain('forbidden-file: local agent notes');
    expect(rules).toContain('personal-path: macOS home');
    expect(rules.some((r) => r.startsWith('local-deny'))).toBe(true);
  });

  it('scans staged blobs, not the working tree', () => {
    init();
    writeFileSync(join(dir, 'a.md'), `${AKIA}\n`);
    git('add', 'a.md');
    writeFileSync(join(dir, 'a.md'), 'clean now\n');
    expect(runRepoChecks({ root: dir, mode: 'staged', env: {} }).map((f) => f.rule)).toEqual([
      'aws-access-key-id',
    ]);
  });

  it('scans commit messages in a range', () => {
    init();
    writeFileSync(join(dir, 'a.md'), 'x\n');
    git('add', '.');
    git('commit', '-qm', `leak ${HOME}`);
    const rules = runRepoChecks({ root: dir, commits: 'HEAD', env: {} }).map((f) => f.rule);
    expect(rules).toContain('personal-path: macOS home');
  });
});
