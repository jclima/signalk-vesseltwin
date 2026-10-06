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

/**
 * Left in place of the credential after the server answered 401. It holds no secret and no
 * credential id: a restart reads it as `reauth_required` and makes no network call.
 */
export interface Tombstone {
  reauthRequired: true;
  vesselLabel: string | null;
  apiOrigin: string | null;
  pairedAt?: string;
}

export function isTombstone(v: StoredCredential | Tombstone): v is Tombstone {
  return 'reauthRequired' in v;
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

  async read(): Promise<StoredCredential | Tombstone | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error('credential file unreadable');
    }
    try {
      const v = JSON.parse(raw) as Partial<StoredCredential> & { reauthRequired?: unknown };
      if (v.reauthRequired === true) {
        // A tombstone wins even if a credential field is somehow present: never use it.
        return {
          reauthRequired: true,
          vesselLabel: typeof v.vesselLabel === 'string' ? v.vesselLabel : null,
          apiOrigin: typeof v.apiOrigin === 'string' ? v.apiOrigin : null,
          ...(typeof v.pairedAt === 'string' ? { pairedAt: v.pairedAt } : {}),
        };
      }
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

  async write(c: StoredCredential): Promise<void> {
    await this.writeAtomic(c);
  }

  /** Replaces the credential with a tombstone (same path, same 0600 mode, atomic). */
  async writeTombstone(t: Tombstone): Promise<void> {
    await this.writeAtomic({
      reauthRequired: true,
      vesselLabel: t.vesselLabel,
      apiOrigin: t.apiOrigin,
      ...(t.pairedAt ? { pairedAt: t.pairedAt } : {}),
    });
  }

  /** Atomic: write a 0600 temp file, fsync, rename over the target. */
  private async writeAtomic(c: StoredCredential | Tombstone): Promise<void> {
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
