export interface Finding {
  path: string;
  line: number;
  rule: string;
}
export interface Rule {
  rule: string;
  re: RegExp;
  accept?: (m: RegExpMatchArray) => boolean;
}
export const FORBIDDEN_PATHS: readonly Rule[];
export const PACK_ALLOWED_FILES: ReadonlySet<string>;
export const PACK_ALLOWED_UI_FILES: ReadonlySet<string>;
export function isFiller(body: string): boolean;
export function parseDenyPatterns(text: string, source?: string): Rule[];
export function loadExtraPatterns(root: string, env?: Record<string, string | undefined>): Rule[];
export function scanText(path: string, text: string, extra?: Rule[]): Finding[];
export function checkPaths(paths: string[], extra?: Rule[]): Finding[];
export function scanEntries(
  entries: { path: string; read: () => Buffer | null }[],
  extra?: Rule[],
): Finding[];
export function scanCommitMessages(
  messages: { sha: string; body: string }[],
  extra?: Rule[],
): Finding[];
export function checkPackFiles(paths: string[]): Finding[];
export function runRepoChecks(opts: {
  root: string;
  mode?: 'tracked' | 'staged';
  commits?: string;
  env?: Record<string, string | undefined>;
}): Finding[];
export function runPackCheck(root: string): Finding[];
export function formatFindings(findings: Finding[]): string;
export function main(argv: string[], root?: string): number;
