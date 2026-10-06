import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface StoredCredential {
  credential: string;
  credentialId: string;
  vesselLabel: string | null;
  pairedAt: string;
  /** Origin of the API that issued the credential; it is only ever sent there. Null = unbound (old file). */
  apiOrigin: string | null;
}

const FILE = 'credential.json';

/**
 * Holds the paired credential in a 0600 file inside the plugin data dir.
 * The credential is never part of plugin settings (those are readable via the
 * admin API) and is never logged.
 */
export class CredentialStore {
  private readonly file: string;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, FILE);
  }

  async read(): Promise<StoredCredential | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('credential file unreadable');
    }
    try {
      const v = JSON.parse(raw) as Partial<StoredCredential>;
      if (typeof v.credential !== 'string' || typeof v.credentialId !== 'string') return null;
      return {
        credential: v.credential,
        credentialId: v.credentialId,
        vesselLabel: v.vesselLabel ?? null,
        pairedAt: v.pairedAt ?? '',
        apiOrigin: typeof v.apiOrigin === 'string' ? v.apiOrigin : null,
      };
    } catch {
      return null;
    }
  }

  /** Atomic: write a 0600 temp file, fsync, rename over the target. */
  async write(c: StoredCredential): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dir, `.${FILE}.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await fs.open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(JSON.stringify(c));
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
    await fs.chmod(this.file, 0o600);
  }

  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
  }
}
