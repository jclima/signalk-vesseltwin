import { mkdtemp, readdir, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('clear() also removes stray temp files left by a crash, and nothing else', async () => {
    const s = new CredentialStore(dir);
    await s.write(cred);
    const { writeFile } = fsp;
    await writeFile(path.join(dir, '.credential.json.abc123.tmp'), 'vti_secret');
    await writeFile(path.join(dir, '.credential.json.0f0f.tmp'), 'x');
    await writeFile(path.join(dir, 'other.txt'), 'keep');
    await s.clear();
    expect(await readdir(dir)).toEqual(['other.txt']);
  });

  it('clear() on a missing directory is a no-op', async () => {
    await expect(new CredentialStore(path.join(dir, 'nope')).clear()).resolves.toBeUndefined();
  });

  describe('failed writes leave no temp file', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('rename fails after the secret was written', async () => {
      vi.spyOn(fsp, 'rename').mockRejectedValueOnce(new Error('EXDEV'));
      await expect(new CredentialStore(dir).write(cred)).rejects.toThrow('EXDEV');
      expect(await readdir(dir)).toEqual([]);
    });

    it('the temp file is 0600 before the rename and a chmod failure cannot fail the write', async () => {
      const realRename = fsp.rename.bind(fsp);
      let modeAtRename = 0;
      vi.spyOn(fsp, 'rename').mockImplementationOnce(async (from, to) => {
        modeAtRename = (await stat(String(from))).mode & 0o777;
        return realRename(from, to);
      });
      vi.spyOn(fsp, 'chmod').mockRejectedValue(new Error('EPERM'));
      await expect(new CredentialStore(dir).write(cred)).resolves.toBeUndefined();
      if (process.platform !== 'win32') expect(modeAtRename).toBe(0o600);
      expect(await new CredentialStore(dir).read()).toMatchObject({ credential: cred.credential });
    });

    it('writing or syncing the temp file fails', async () => {
      const realOpen = fsp.open.bind(fsp);
      vi.spyOn(fsp, 'open').mockImplementationOnce(async (...a: Parameters<typeof fsp.open>) => {
        const fh = await realOpen(...a);
        vi.spyOn(fh, 'sync').mockRejectedValueOnce(new Error('EIO'));
        return fh;
      });
      await expect(new CredentialStore(dir).write(cred)).rejects.toThrow('EIO');
      expect(await readdir(dir)).toEqual([]);
    });

    it('a directory fsync failure does not fail the write', async () => {
      const realOpen = fsp.open.bind(fsp);
      vi.spyOn(fsp, 'open').mockImplementation(async (...a: Parameters<typeof fsp.open>) => {
        if (a[1] === 'r') throw new Error('EISDIR');
        return realOpen(...a);
      });
      const s = new CredentialStore(dir);
      await s.write(cred);
      expect(await s.read()).toEqual(cred);
    });

    it('fsyncs the directory after the rename', async () => {
      const realOpen = fsp.open.bind(fsp);
      const opened: unknown[] = [];
      vi.spyOn(fsp, 'open').mockImplementation(async (...a: Parameters<typeof fsp.open>) => {
        opened.push(a[0]);
        return realOpen(...a);
      });
      await new CredentialStore(dir).write(cred);
      expect(opened.at(-1)).toBe(dir);
    });
  });
});
