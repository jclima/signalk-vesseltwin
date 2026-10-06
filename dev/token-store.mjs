// Saves the dev admin token with owner-only permissions. Shared by dev/setup-signalk.mjs and tested
// in test/dev-token-store.test.mts. Never logs the token.
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// chmod can be a no-op or unsupported on some platforms/filesystems (e.g. Windows, FAT, some mounts).
const TOLERATED = new Set(['ENOSYS', 'EPERM', 'ENOTSUP', 'EOPNOTSUPP']);

async function tighten(path, mode) {
  try {
    await chmod(path, mode);
  } catch (err) {
    const code = err && typeof err === 'object' ? err.code : undefined;
    if (typeof code === 'string' && TOLERATED.has(code)) {
      console.warn(`warning: could not set mode ${mode.toString(8)} on ${path} (${code})`);
      return;
    }
    throw err;
  }
}

/** Writes `<dir>/token` (0600) inside `dir` (0700). Tightens a pre-existing directory and file. */
export async function saveToken(dir, token) {
  // mkdir's mode only applies to a directory it creates, so chmod handles a pre-existing one.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await tighten(dir, 0o700);
  const file = join(dir, 'token');
  await writeFile(file, token, { mode: 0o600 }); // mode only applies to a new file
  await tighten(file, 0o600);
  return file;
}
