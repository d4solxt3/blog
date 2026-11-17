/**
 * Comment storage. One schema for both top-level comments and
 * highlight-anchored quote threads (anchor = W3C-style text-quote selector).
 *
 * Pick a backend with the COMMENTS_STORE environment variable:
 *   json      (default) data/comments.json — zero config; fine for local dev and
 *             single-server Node hosts with a persistent disk
 *   turso     TURSO_DATABASE_URL + TURSO_AUTH_TOKEN (libSQL over HTTP)
 *   supabase  SUPABASE_URL + SUPABASE_SERVICE_KEY (table created from CUSTOMIZING.md)
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type Anchor = { id: string; exact: string; prefix: string; suffix: string; blockIndex: number };
export type CommentRecord = {
  id: string;
  post: string;
  name: string;
  body: string;
  createdAt: string;
  anchor: Anchor | null;
};

export interface CommentStore {
  list(post: string): Promise<CommentRecord[]>;
  counts(): Promise<Record<string, number>>;
  add(comment: CommentRecord): Promise<CommentRecord>;
}

const env = (key: string) => process.env[key]?.trim() || '';

/* ---------------------------------------------------------------- JSON --- */

function jsonStore(): CommentStore {
  const file = resolve(process.cwd(), env('COMMENTS_JSON_PATH') || 'data/comments.json');
  let queue: Promise<unknown> = Promise.resolve();

  async function readAll(): Promise<CommentRecord[]> {
    try {
      const data = JSON.parse(await readFile(file, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  return {
    async list(post) {
      return (await readAll()).filter((c) => c.post === post);
    },
    async counts() {
      const out: Record<string, number> = {};
      for (const c of await readAll()) out[c.post] = (out[c.post] ?? 0) + 1;
      return out;
    },
    add(comment) {
      // Serialise writes so concurrent posts never clobber each other.
      const run = queue.then(async () => {
        const all = await readAll();
        all.push(comment);
        await mkdir(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        await writeFile(tmp, JSON.stringify(all, null, 2), 'utf8');
        await rename(tmp, file);
        return comment;
      });
      queue = run.catch(() => {});
      return run;
    },
  };
}

/* ---------------------------------------------------------- SQL helpers --- */

type Row = Record<string, string | number | null>;

const fromRow = (r: Row): CommentRecord => ({
  id: String(r.id),
  post: String(r.post),
  name: String(r.name),
  body: String(r.body),
  createdAt: String(r.created_at),
  anchor: r.anchor_id
    ? {
        id: String(r.anchor_id),
        exact: String(r.exact ?? ''),
        prefix: String(r.prefix ?? ''),
        suffix: String(r.suffix ?? ''),
        blockIndex: Number(r.block_index ?? 0),
      }
    : null,
});

const toRow = (c: CommentRecord): Row => ({
  id: c.id,
  post: c.post,
  name: c.name,
  body: c.body,
  created_at: c.createdAt,
  anchor_id: c.anchor?.id ?? null,
  exact: c.anchor?.exact ?? null,
  prefix: c.anchor?.prefix ?? null,
  suffix: c.anchor?.suffix ?? null,
  block_index: c.anchor?.blockIndex ?? null,
});

export const SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  post TEXT NOT NULL,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  anchor_id TEXT,
  exact TEXT,
  prefix TEXT,
  suffix TEXT,
  block_index INTEGER
)`;

/* --------------------------------------------------------------- Turso --- */

function tursoStore(): CommentStore {
  const url = env('TURSO_DATABASE_URL').replace(/^libsql:\/\//, 'https://').replace(/\/$/, '');
  const token = env('TURSO_AUTH_TOKEN');
  if (!url) throw new Error('COMMENTS_STORE=turso needs TURSO_DATABASE_URL');
  let ready: Promise<unknown> | null = null;

  const arg = (v: unknown) =>
    v === null || v === undefined
      ? { type: 'null' }
      : typeof v === 'number'
        ? { type: 'integer', value: String(Math.trunc(v)) }
        : { type: 'text', value: String(v) };

  async function exec(sql: string, args: unknown[] = []): Promise<Row[]> {
    const res = await fetch(`${url}/v2/pipeline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ requests: [{ type: 'execute', stmt: { sql, args: args.map(arg) } }, { type: 'close' }] }),
    });
    if (!res.ok) throw new Error(`Turso HTTP ${res.status}`);
    const first = (await res.json()).results?.[0];
    if (first?.type !== 'ok') throw new Error(first?.error?.message ?? 'Turso query failed');
    const { cols, rows } = first.response.result as { cols: { name: string }[]; rows: { value: string | null }[][] };
    return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c.name, row[i]?.value ?? null])));
  }
  const init = () => (ready ??= exec(SCHEMA_SQL));

  return {
    async list(post) {
      await init();
      return (await exec('SELECT * FROM comments WHERE post = ? ORDER BY created_at', [post])).map(fromRow);
    },
    async counts() {
      await init();
      const rows = await exec('SELECT post, COUNT(*) AS n FROM comments GROUP BY post');
      return Object.fromEntries(rows.map((r) => [String(r.post), Number(r.n)]));
    },
    async add(comment) {
      await init();
      const r = toRow(comment);
      const keys = Object.keys(r);
      await exec(`INSERT INTO comments (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`, Object.values(r));
      return comment;
    },
  };
}

/* ------------------------------------------------------------ Supabase --- */

function supabaseStore(): CommentStore {
  const base = env('SUPABASE_URL').replace(/\/$/, '');
  const key = env('SUPABASE_SERVICE_KEY');
  if (!base || !key) throw new Error('COMMENTS_STORE=supabase needs SUPABASE_URL and SUPABASE_SERVICE_KEY');
  const headers = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

  async function req(path: string, init: RequestInit = {}) {
    const res = await fetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}`);
    return res.json();
  }

  return {
    async list(post) {
      const rows: Row[] = await req(`comments?post=eq.${encodeURIComponent(post)}&order=created_at.asc`);
      return rows.map(fromRow);
    },
    async counts() {
      const rows: { post: string }[] = await req('comments?select=post');
      const out: Record<string, number> = {};
      for (const r of rows) out[r.post] = (out[r.post] ?? 0) + 1;
      return out;
    },
    async add(comment) {
      await req('comments', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(toRow(comment)) });
      return comment;
    },
  };
}

/* ------------------------------------------------------------- factory --- */

let store: CommentStore | null = null;

export function getStore(): CommentStore {
  if (store) return store;
  const kind = env('COMMENTS_STORE').toLowerCase() || 'json';
  store = kind === 'turso' ? tursoStore() : kind === 'supabase' ? supabaseStore() : jsonStore();
  return store;
}
