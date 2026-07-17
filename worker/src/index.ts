export interface Env {
  LEADERBOARD_KV: KVNamespace;
  /** Fine-grained PAT, repo-scoped to lejeanbaptiste/scoreboard,
   * Contents: read+write only. Set via `wrangler secret put`, never
   * present in source or shipped to any client. */
  GITHUB_WRITE_TOKEN: string;
}

const REPO_OWNER = 'lejeanbaptiste';
const REPO_NAME = 'scoreboard';
const SCORES_PATH = 'scores.json';

const RATE_LIMIT_MS = 15 * 60 * 1000;
const MAX_STRING_LENGTH = 200;
const MAX_METRIC_VALUE = 10_000_000;
const REQUIRED_METRIC_KEYS = ['texts', 'tags', 'disambiguated', 'places', 'entities'] as const;

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  });
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_METRIC_VALUE;
}

function clampString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, MAX_STRING_LENGTH);
  return trimmed || fallback;
}

interface ValidatedSubmission {
  commission: string;
  metrics: Record<(typeof REQUIRED_METRIC_KEYS)[number], number>;
  unlockedCount: number;
  totalAchievements: number;
}

/** Same validation contract as scripts/process-submission.mjs (the
 * Phase-1 GitHub-Issues path) - malformed/hostile input is rejected
 * outright, not partially trusted. */
function validateSubmission(raw: unknown): ValidatedSubmission | null {
  if (!raw || typeof raw !== 'object') return null;
  const body = raw as Record<string, unknown>;
  const metrics = body.metrics;
  if (!metrics || typeof metrics !== 'object') return null;
  const metricsRecord = metrics as Record<string, unknown>;
  for (const key of REQUIRED_METRIC_KEYS) {
    if (!isFiniteNonNegative(metricsRecord[key])) return null;
  }
  if (!isFiniteNonNegative(body.unlockedCount) || !isFiniteNonNegative(body.totalAchievements)) {
    return null;
  }
  return {
    commission: clampString(body.commission, 'Unranked'),
    metrics: Object.fromEntries(
      REQUIRED_METRIC_KEYS.map((key) => [key, metricsRecord[key] as number]),
    ) as ValidatedSubmission['metrics'],
    unlockedCount: body.unlockedCount as number,
    totalAchievements: body.totalAchievements as number,
  };
}

interface GitHubUser {
  id: number;
  login: string;
}

/** The only identity check here: ask GitHub who this token belongs to.
 * A client can claim anything in its request body except this - the
 * token itself has to actually be valid and GitHub has to vouch for the
 * account behind it. */
async function verifyGitHubUser(token: string): Promise<GitHubUser | null> {
  const response = await fetch('https://api.github.com/user', {
    headers: {
      authorization: `Bearer ${token}`,
      'user-agent': 'ljb-leaderboard-worker',
      accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as { id?: number; login?: string };
  if (typeof data.id !== 'number' || typeof data.login !== 'string') return null;
  return { id: data.id, login: data.login };
}

interface ScoreEntry {
  id: string;
  displayName: string;
  commission: string;
  metrics: ValidatedSubmission['metrics'];
  unlockedCount: number;
  totalAchievements: number;
  updatedAt: string;
}

async function loadAllEntries(kv: KVNamespace): Promise<ScoreEntry[]> {
  const entries: ScoreEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix: 'score:', cursor });
    for (const key of page.keys) {
      const raw = await kv.get(key.name);
      if (raw) entries.push(JSON.parse(raw) as ScoreEntry);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return entries;
}

/** Publishes the full scores array to the public repo via GitHub's
 * Contents API - the only thing with write access to that repo is this
 * Worker's own secret, never a client. */
async function publishScoresJson(env: Env, entries: ScoreEntry[]): Promise<void> {
  const apiUrl = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/contents/${SCORES_PATH}`;
  const headers = {
    authorization: `Bearer ${env.GITHUB_WRITE_TOKEN}`,
    'user-agent': 'ljb-leaderboard-worker',
    accept: 'application/vnd.github+json',
  };

  const existing = await fetch(apiUrl, { headers });
  const sha = existing.ok ? ((await existing.json()) as { sha?: string }).sha : undefined;

  const content = `${JSON.stringify(entries, null, 2)}\n`;
  const base64Content = btoa(unescape(encodeURIComponent(content)));

  const putResponse = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: `Update leaderboard (${entries.length} entries)`,
      content: base64Content,
      sha,
    }),
  });
  if (!putResponse.ok) {
    throw new Error(`GitHub contents PUT failed: ${putResponse.status} ${await putResponse.text()}`);
  }
}

async function handleSubmit(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Request body must be JSON.' }, 400);
  }

  const token = typeof (body as Record<string, unknown>)?.token === 'string'
    ? (body as Record<string, string>).token
    : null;
  if (!token) return json({ error: 'Missing token.' }, 400);

  const submission = validateSubmission(body);
  if (!submission) return json({ error: 'Malformed submission payload.' }, 400);

  const user = await verifyGitHubUser(token);
  if (!user) return json({ error: 'Could not verify GitHub identity for this token.' }, 401);

  const id = String(user.id);
  const rateLimitKey = `ratelimit:${id}`;
  const lastSubmitted = await env.LEADERBOARD_KV.get(rateLimitKey);
  if (lastSubmitted) {
    const elapsed = Date.now() - Number(lastSubmitted);
    if (elapsed < RATE_LIMIT_MS) {
      const waitMinutes = Math.ceil((RATE_LIMIT_MS - elapsed) / 60000);
      return json({ error: `Submitted too recently - try again in about ${waitMinutes} minute(s).` }, 429);
    }
  }

  const now = new Date();
  const entry: ScoreEntry = {
    id,
    displayName: user.login,
    commission: submission.commission,
    metrics: submission.metrics,
    unlockedCount: submission.unlockedCount,
    totalAchievements: submission.totalAchievements,
    updatedAt: now.toISOString(),
  };

  await env.LEADERBOARD_KV.put(`score:${id}`, JSON.stringify(entry));
  await env.LEADERBOARD_KV.put(rateLimitKey, String(now.getTime()));

  const allEntries = await loadAllEntries(env.LEADERBOARD_KV);
  await publishScoresJson(env, allEntries);

  return json({ ok: true, message: `Added to the leaderboard as ${user.login}.` });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/submit') {
      try {
        return await handleSubmit(request, env);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : 'Internal error.' }, 500);
      }
    }
    return json({ error: 'Not found.' }, 404);
  },
};
