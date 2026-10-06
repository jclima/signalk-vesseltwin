import { mkdtemp, chmod, mkdir, rm, stat, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveToken } from '../dev/token-store.mjs';

const posix = process.platform !== 'win32';
const dirs: string[] = [];
async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'vt-token-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe.skipIf(!posix)('dev token store', () => {
  it('creates a new directory 0700 and the file 0600', async () => {
    const dir = join(await tmp(), '.signalk-dev');
    const file = await saveToken(dir, 'fake-token');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toBe('fake-token');
  });

  it('tightens a pre-existing 0755 directory and 0644 file', async () => {
    const dir = join(await tmp(), '.signalk-dev');
    await mkdir(dir, { mode: 0o755 });
    await chmod(dir, 0o755);
    await writeFile(join(dir, 'token'), 'old', { mode: 0o644 });
    await chmod(join(dir, 'token'), 0o644);
    const file = await saveToken(dir, 'fake-token');
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, 'utf8')).toBe('fake-token');
  });
});
