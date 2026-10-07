import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const html = readFileSync(join(root, 'public', 'index.html'), 'utf8');
const css = readFileSync(join(root, 'public', 'style.css'), 'utf8');
const webSources = readdirSync(join(root, 'web'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ f, text: readFileSync(join(root, 'web', f), 'utf8') }));

/** Drop comments so a note that names a banned API does not fail the scan. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('public/index.html', () => {
  it('carries a strict CSP meta with no unsafe-inline or unsafe-eval', () => {
    const m = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html);
    expect(m).not.toBeNull();
    const csp = m?.[1] ?? '';
    expect(csp).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'",
    );
    expect(csp).not.toMatch(/unsafe-/);
    expect(csp).not.toMatch(/\*|https?:|data:/);
  });
  it('sends no referrer', () => {
    expect(html).toMatch(/<meta\s+name="referrer"\s+content="no-referrer"/);
  });
  it('has no inline script, inline style or event handler attributes', () => {
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      expect(m[1]).toMatch(/\bsrc="[^"]+"/);
      expect(m[2]?.trim()).toBe('');
    }
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/javascript:/i);
  });
  it('loads only relative assets', () => {
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]*)"/g)].map((m) => m[1] ?? '');
    expect(refs.sort()).toEqual(['app.js', 'style.css']);
    for (const r of refs) expect(r).not.toMatch(/^([a-z]+:)?\/|\.\./i);
  });
  it('keeps the honesty line, a noscript fallback and the loading hint in static text', () => {
    expect(html).toContain('Data upload is not available in this version.');
    expect(html).toMatch(/<noscript>/);
    expect(html).toMatch(/trailing slash/);
  });
  it('is accessible markup: language, one h1, main, one live region', () => {
    expect(html).toMatch(/<html lang="en">/);
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<main>/);
    expect(html.match(/aria-live=/g)).toHaveLength(1);
  });
});

describe('public/style.css', () => {
  it('supports dark mode, visible focus and has no remote references', () => {
    expect(css).toMatch(/prefers-color-scheme:\s*dark/);
    expect(css).toMatch(/:focus-visible/);
    expect(css).not.toMatch(/url\(|@import|https?:/i);
  });
});

describe('web sources', () => {
  it('exist', () => {
    expect(existsSync(join(root, 'web', 'app.ts'))).toBe(true);
  });
  const banned = [
    /\binnerHTML\b/,
    /\bouterHTML\b/,
    /\binsertAdjacentHTML\b/,
    /\bdocument\.write(ln)?\b/,
    /\beval\s*\(/,
    /\bnew\s+Function\b/,
    /\bconsole\./,
    /\blocalStorage\b/,
    /\bsessionStorage\b/,
    /\bdocument\.cookie\b/,
    /\bXMLHttpRequest\b/,
    /\bWebSocket\b/,
    /\bsendBeacon\b/,
  ];
  for (const { f, text } of webSources) {
    it(`${f} uses none of the banned APIs`, () => {
      const code = stripComments(text);
      for (const re of banned) expect(code, String(re)).not.toMatch(re);
    });
  }
  it('never imports from the plugin sources', () => {
    for (const { text } of webSources) expect(text).not.toMatch(/from\s+['"]\.\.\//);
  });
  it('only fetches the plugin routes (absolute path, same origin)', () => {
    for (const { f, text } of webSources.filter((w) => w.f !== 'view.ts')) {
      expect(stripComments(text), f).not.toMatch(/https?:\/\//);
    }
  });
});
