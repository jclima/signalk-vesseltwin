import { mkdtemp, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CredentialStore, isTombstone } from '../src/credential-store';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vt-cred-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cred = {
  credential: 'vti_abcdefghijk',
  credentialId: 'id-1',
  vesselLabel: 'Sea Hag',
  pairedAt: 'now',
  apiOrigin: 'https://api.test',
};

describe('CredentialStore', () => {
  it('returns null when absent', async () => {
    expect(await new CredentialStore(dir).read()).toBeNull();
  });

  it('round-trips and writes mode 0600', async () => {
    const s = new CredentialStore(dir);
    await s.write(cred);
    expect(await s.read()).toEqual(cred);
    const st = await stat(path.join(dir, 'credential.json'));
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('leaves no temp files and replaces atomically', async () => {
    const s = new CredentialStore(dir);
    await s.write(cred);
    await s.write({ ...cred, credentialId: 'id-2' });
    expect(await s.read()).toMatchObject({ credentialId: 'id-2' });
    expect(await readdir(dir)).toEqual(['credential.json']);
  });

  it('treats a corrupt file as unpaired and clear() removes it', async () => {
    const s = new CredentialStore(dir);
    await s.write(cred);
    await import('node:fs/promises').then((f) =>
      f.writeFile(path.join(dir, 'credential.json'), '{bad'),
    );
    expect(await s.read()).toBeNull();
    await s.clear();
    expect(await readdir(dir)).toEqual([]);
  });

  it('reads a file with no recorded origin as unbound (null)', async () => {
    await import('node:fs/promises').then((f) =>
      f.writeFile(
        path.join(dir, 'credential.json'),
        JSON.stringify({ credential: 'vti_abcdefghijk', credentialId: 'id-1' }),
      ),
    );
    expect((await new CredentialStore(dir).read())?.apiOrigin).toBeNull();
  });

  it('replaces the credential with a secret-free 0600 tombstone and reads it back', async () => {
    const s = new CredentialStore(dir);
    await s.write(cred);
    await s.writeTombstone({
      reauthRequired: true,
      vesselLabel: 'Sea Hag',
      apiOrigin: 'https://api.test',
      pairedAt: 'now',
    });
    const file = path.join(dir, 'credential.json');
    const raw = await import('node:fs/promises').then((f) => f.readFile(file, 'utf8'));
    expect(Object.keys(JSON.parse(raw) as object).sort()).toEqual([
      'apiOrigin',
      'pairedAt',
      'reauthRequired',
      'vesselLabel',
    ]);
    expect(raw).not.toContain('vti_');
    expect(raw).not.toContain('id-1');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['credential.json']);
    const back = await s.read();
    expect(back && isTombstone(back)).toBe(true);
    expect(back).toEqual({
      reauthRequired: true,
      vesselLabel: 'Sea Hag',
      apiOrigin: 'https://api.test',
      pairedAt: 'now',
    });
  });

  it('never treats a tombstone as a usable credential, even with stray fields', async () => {
    await import('node:fs/promises').then((f) =>
      f.writeFile(
        path.join(dir, 'credential.json'),
        JSON.stringify({ reauthRequired: true, credential: 'vti_abcdefghijk', credentialId: 'x' }),
      ),
    );
    const back = await new CredentialStore(dir).read();
    expect(back).toEqual({ reauthRequired: true, vesselLabel: null, apiOrigin: null });
    expect(JSON.stringify(back)).not.toContain('vti_');
  });
});
