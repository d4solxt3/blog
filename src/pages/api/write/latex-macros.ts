/**
 * Owner-only endpoint for global LaTeX macros and default citation style.
 * GET → { macros, citationStyle, source: 'override' | 'config' }
 * PUT { macros, citationStyle } → persists to site.config.json (dev) or <DATA_DIR>/latex-macros.json (prod).
 */
import type { APIRoute } from 'astro';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DATA_DIR, DEV, isOwner, json, ownerOnly } from '../../../lib/auth';
import { SITE, type CitationStyle } from '../../../site.config';

export const prerender = false;

const CONFIG_PATH = resolve(process.cwd(), 'site.config.json');
const OVERRIDE_PATH = join(DATA_DIR, 'latex-macros.json');
const MAX_MACROS = 200;
const MAX_VALUE_LEN = 500;

export type GlobalLatexConfig = {
  macros: Record<string, string>;
  citationStyle: CitationStyle;
  source: 'override' | 'config';
};

function isValidMacroKey(key: string): boolean {
  return /^\\[A-Za-z@]+$/.test(key) || /^\\[^A-Za-z\s]$/.test(key);
}

function sanitizeMacros(raw: unknown): Record<string, string> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isValidMacroKey(k) && typeof v === 'string' && v.length <= MAX_VALUE_LEN) {
      out[k] = v;
      if (Object.keys(out).length >= MAX_MACROS) break;
    }
  }
  return out;
}

function asCitationStyle(v: unknown): CitationStyle {
  return v === 'author-year' ? 'author-year' : 'numeric';
}

function writeAtomic(file: string, content: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/**
 * Reads the active global LaTeX config:
 * 1. <DATA_DIR>/latex-macros.json runtime override (if present and valid),
 * 2. site.config.json read fresh from disk (so dev edits take effect immediately),
 * 3. SITE.latex / starter defaults fallback.
 */
export function readGlobalLatexConfig(): GlobalLatexConfig {
  if (existsSync(OVERRIDE_PATH)) {
    try {
      const parsed = JSON.parse(readFileSync(OVERRIDE_PATH, 'utf8')) as Record<string, unknown>;
      const macros = sanitizeMacros(parsed?.macros);
      if (macros) {
        return {
          macros,
          citationStyle: asCitationStyle(parsed.citationStyle),
          source: 'override',
        };
      }
    } catch {}
  }

  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, any>;
    const latex = cfg?.latex;
    const macros = sanitizeMacros(latex?.macros);
    if (macros) {
      return {
        macros,
        citationStyle: asCitationStyle(latex?.citationStyle),
        source: 'config',
      };
    }
  } catch {}

  return {
    macros: { ...SITE.latex.macros },
    citationStyle: SITE.latex.citationStyle,
    source: 'config',
  };
}

export const GET: APIRoute = ({ request }) => {
  if (!isOwner(request)) return ownerOnly();
  return json(readGlobalLatexConfig());
};

export const PUT: APIRoute = async ({ request }) => {
  if (!isOwner(request)) return ownerOnly();
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return json({ error: 'Invalid JSON body.' }, 400);

  const citationStyle = body.citationStyle;
  if (citationStyle !== 'numeric' && citationStyle !== 'author-year') {
    return json({ error: 'citationStyle must be "numeric" or "author-year".' }, 400);
  }

  const rawMacros = body.macros;
  if (!rawMacros || typeof rawMacros !== 'object' || Array.isArray(rawMacros)) {
    return json({ error: 'macros must be an object mapping \\name to definition.' }, 400);
  }

  const entries = Object.entries(rawMacros as Record<string, unknown>);
  if (entries.length > MAX_MACROS) {
    return json({ error: `At most ${MAX_MACROS} global macros are allowed.` }, 400);
  }

  const macros: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (!isValidMacroKey(k)) {
      return json({ error: `Invalid macro name "${k}". Keys must start with \\ followed by letters (e.g. \\R) or a single symbol.` }, 400);
    }
    if (typeof v !== 'string' || v.length > MAX_VALUE_LEN) {
      return json({ error: `Macro "${k}" must map to a string of at most ${MAX_VALUE_LEN} characters.` }, 400);
    }
    macros[k] = v;
  }

  try {
    if (DEV) {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
      cfg.latex = { citationStyle, macros };
      writeAtomic(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
      rmSync(OVERRIDE_PATH, { force: true });
      return json({ ok: true, macros, citationStyle, source: 'config' as const });
    }

    mkdirSync(DATA_DIR, { recursive: true });
    writeAtomic(OVERRIDE_PATH, JSON.stringify({ citationStyle, macros }, null, 2) + '\n');
    return json({ ok: true, macros, citationStyle, source: 'override' as const });
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Could not save LaTeX settings.' }, 500);
  }
};
