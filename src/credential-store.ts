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
/** fchmod errors that mean "this filesystem has no POSIX modes" (vfat, exFAT, some CIFS/Docker mounts). */
const CHMOD_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
const TMP_RE = /^\.credential\.json\.[0-9a-f]+\.tmp$/;

/** Group or other bits set means the file is not private. Windows has no such modes: never warn. */
function isRestricted(mode: number): boolean {
  return process.platform === 'win32' || (mode & 0o077) === 0;
}

/**
 * Holds the paired credential in a 0600 file inside the plugin data dir.
 * The credential is never part of plugin settings (those are readable via the
 * admin API) and is never logged.
 */
export class CredentialStore {
  private readonly file: string;
  private restricted = true;

  constructor(private readonly dir: string) {
    this.file = path.join(dir, FILE);
  }

  /**
   * False when the credential file is readable by group or others and could not be restricted (no
   * POSIX modes on this drive). Updated by read(), write() and clear(); always true on Windows.
   */
  get permissionsRestricted(): boolean {
    return this.restricted;
  }

  async read(): Promise<StoredCredential | Tombstone | null> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.restricted = true;
        return null;
      }
      throw new Error('credential file unreadable');
    }
    try {
      this.restricted = isRestricted((await fs.stat(this.file)).mode);
    } catch {
      this.restricted = true; // cannot tell: do not warn
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

  /**
   * Atomic: write a 0600 temp file, fsync, rename over the target, fsync the directory. The temp
   * file may hold the secret, so it is removed on any failure.
   */
  private async writeAtomic(c: StoredCredential | Tombstone): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    let restricted = true;
    const tmp = path.join(this.dir, `.${FILE}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      const fh = await fs.open(tmp, 'wx', 0o600);
      try {
        // Best effort: the file was created 0600 above; some filesystems (vfat, exFAT, certain
        // CIFS or Docker mounts) reject fchmod, which must not strand an approved credential.
        await fh.chmod(0o600).catch((err: unknown) => {
          const code = (err as NodeJS.ErrnoException | undefined)?.code;
          if (code === undefined || !CHMOD_UNSUPPORTED.has(code)) throw err;
        });
        await fh.writeFile(JSON.stringify(c));
        await fh.sync();
        restricted = isRestricted((await fh.stat()).mode);
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, this.file);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
    this.restricted = restricted;
    await this.syncDir();
  }

  /** Makes the rename durable. Best effort: some platforms cannot open or fsync a directory. */
  private async syncDir(): Promise<void> {
    try {
      const dh = await fs.open(this.dir, 'r');
      try {
        await dh.sync();
      } finally {
        await dh.close();
      }
    } catch {
      // not supported here (e.g. Windows); the rename itself already happened
    }
  }

  /** Removes the credential file and any stray temp files a crash may have left behind. */
  async clear(): Promise<void> {
    await fs.rm(this.file, { force: true });
    this.restricted = true;
    let names: string[] = [];
    try {
      names = await fs.readdir(this.dir);
    } catch {
      return; // no directory, nothing to clean
    }
    for (const n of names) {
      if (TMP_RE.test(n)) await fs.rm(path.join(this.dir, n), { force: true });
    }
    await this.syncDir();
  }
}
