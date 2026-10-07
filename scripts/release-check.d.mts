export interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[] | null;
  raw: string;
}
export interface Finding {
  sev: 'ERROR' | 'WARN';
  id: string;
  file: string;
  line: number;
  message: string;
}
export interface ChangelogRelease {
  version: string;
  date: string | null;
  line: number;
  body: string;
}
export interface ParsedChangelog {
  unreleased: { line: number; body: string } | null;
  releases: ChangelogRelease[];
}
export type RegistryInfo =
  | { status: 'unpublished' }
  | {
      status: 'published';
      latest: string | null;
      versions: Record<string, { dist?: { attestations?: unknown } } | undefined>;
    };
export interface MainDeps {
  root?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  git?: (args: string[]) => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export class EnvError extends Error {}
export function parseSemver(s: unknown): Semver | null;
export function compareSemver(a: string | Semver, b: string | Semver): -1 | 0 | 1;
export function nextVersions(base: string | Semver): {
  patch: string;
  minor: string;
  major: string;
};
export function formatFindings(findings: Finding[]): string;
export function normaliseReadme(text: string): string;
export function parseChangelog(text: string): ParsedChangelog;
export function checkChangelogDated(parsed: ParsedChangelog, pkgVersion: string): Finding[];
export function checkChangelog(
  parsed: ParsedChangelog,
  target: string,
  opts: { now: Date },
): Finding[];
export function pickBaseline(opts: {
  tags?: string[];
  changelogVersions?: string[];
  registryLatest?: string | null;
  target?: string | null;
}): string | null;
export function checkBump(target: string, baseline: string | null): Finding[];
export function checkVersionSync(opts: {
  pkgVersion: string;
  pluginTs: string;
  readme: string;
}): Finding[];
export function checkUploadHonesty(opts: {
  mappingTs: string;
  pluginTs: string;
  readme: string;
  srcFiles: { path: string; text: string }[];
}): Finding[];
export function checkContractDoc(opts: { contractTs: string; apiMd: string }): Finding[];
export function checkReadmeReleased(opts: {
  readme: string;
  changelogSection?: string | undefined;
}): Finding[];
export function checkVersionArg(target: string, pkgVersion: string): Finding[];
export function checkGitState(opts: {
  porcelain: string;
  head: string;
  originMain: string;
  preTag: boolean;
  tagLocal: boolean;
  tagRemote: boolean | null;
}): Finding[];
export function checkTagMatch(tag: string, pkgVersion: string): Finding[];
export function checkTagAncestry(opts: { isAncestor: boolean }): Finding[];
export function registryUrl(name: string): string;
export function fetchRegistry(
  name: string,
  opts: { fetch: typeof fetch; timeoutMs?: number },
): Promise<RegistryInfo>;
export function checkRegistry(target: string, reg: RegistryInfo): Finding[];
export function checkVerify(version: string, reg: RegistryInfo): Finding[];
export function main(argv: string[], deps?: MainDeps): Promise<number>;
