#!/usr/bin/env node
// Parses a score-submission comment (on the pinned "Submit your Service
// Record here" issue), validates and rate-limits it, and updates
// scores.json. Run by .github/workflows/process-submission.yml with the
// comment's body/author/login as env vars - never invoked with anything a
// client controls beyond the comment body text, and GitHub itself is what
// guarantees the author identity is real (you cannot post a comment as
// someone else). A comment rather than a new issue deliberately - opening
// an issue counts as a public contribution on the submitter's GitHub
// profile; commenting does not.
//
// Deliberately has no server, no secret beyond the repo's own automatic
// GITHUB_TOKEN (scoped to this repo only), and no datastore beyond
// scores.json itself.

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const SCORES_PATH = new URL('../scores.json', import.meta.url);

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  const line = `${name}<<EOF\n${value}\nEOF\n`;
  if (outputFile) {
    appendFileSync(outputFile, line, 'utf8');
  } else {
    console.log(`${name}=${value}`);
  }
}
// Just enough to stop literal spam-commenting, not to slow down a
// genuine re-check after making progress.
const RATE_LIMIT_MS = 2 * 60 * 1000;
const MAX_STRING_LENGTH = 200;
const MAX_METRIC_VALUE = 10_000_000;

const REQUIRED_METRIC_KEYS = ['texts', 'tags', 'disambiguated', 'places', 'entities'];

function extractJsonBlock(body) {
  const match = /```json\s*([\s\S]*?)```/.exec(body ?? '');
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_METRIC_VALUE;
}

function clampString(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().slice(0, MAX_STRING_LENGTH);
  return trimmed || fallback;
}

/** Returns a validated, clamped submission, or null if the payload doesn't
 * match the expected shape - malformed/hostile input is rejected outright
 * rather than partially trusted. */
function validateSubmission(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const metrics = raw.metrics;
  if (!metrics || typeof metrics !== 'object') return null;
  for (const key of REQUIRED_METRIC_KEYS) {
    if (!isFiniteNonNegative(metrics[key])) return null;
  }
  if (!isFiniteNonNegative(raw.unlockedCount) || !isFiniteNonNegative(raw.totalAchievements)) {
    return null;
  }
  return {
    commission: clampString(raw.commission, 'Unranked'),
    metrics: Object.fromEntries(REQUIRED_METRIC_KEYS.map((key) => [key, metrics[key]])),
    unlockedCount: raw.unlockedCount,
    totalAchievements: raw.totalAchievements,
  };
}

function main() {
  const commentBody = process.env.COMMENT_BODY ?? '';
  const authorId = process.env.COMMENT_AUTHOR_ID;
  const authorLogin = process.env.COMMENT_AUTHOR_LOGIN;

  if (!authorId || !authorLogin) {
    setOutput('result', 'error');
    setOutput('message', 'Missing comment author identity.');
    process.exitCode = 1;
    return;
  }

  const raw = extractJsonBlock(commentBody);
  const submission = validateSubmission(raw);
  if (!submission) {
    setOutput('result', 'rejected');
    setOutput('message', 'Could not parse a valid score payload from this issue. No changes made.');
    return;
  }

  const scores = JSON.parse(readFileSync(SCORES_PATH, 'utf8'));
  const existingIndex = scores.findIndex((entry) => entry.id === authorId);
  const now = new Date();

  if (existingIndex >= 0) {
    const existing = scores[existingIndex];
    const lastUpdated = existing.updatedAt ? new Date(existing.updatedAt).getTime() : 0;
    if (now.getTime() - lastUpdated < RATE_LIMIT_MS) {
      const waitMinutes = Math.ceil((RATE_LIMIT_MS - (now.getTime() - lastUpdated)) / 60000);
      setOutput('result', 'rate-limited');
      setOutput('message', `You already submitted recently - try again in about ${waitMinutes} minute(s).`);
      return;
    }
  }

  const candidate = {
    id: authorId,
    displayName: authorLogin,
    commission: submission.commission,
    metrics: submission.metrics,
    unlockedCount: submission.unlockedCount,
    totalAchievements: submission.totalAchievements,
    updatedAt: now.toISOString(),
  };

  // Local progress is a high-water mark (it only ever increases), so a
  // legitimate resubmission should never rank lower than a previous one -
  // keep whichever submission ranks higher wholesale (not a field-by-field
  // merge) so stats and commission stay internally consistent. Mirrors the
  // Worker's same logic (the primary submission path) - see worker/README.
  const existing = existingIndex >= 0 ? scores[existingIndex] : null;
  const isImprovement = !existing || candidate.unlockedCount >= existing.unlockedCount;
  const finalEntry = isImprovement ? candidate : existing;

  if (existingIndex >= 0) {
    scores[existingIndex] = finalEntry;
  } else {
    scores.push(finalEntry);
  }

  writeFileSync(SCORES_PATH, `${JSON.stringify(scores, null, 2)}\n`, 'utf8');
  setOutput('result', 'accepted');
  setOutput(
    'message',
    isImprovement
      ? `Added to the leaderboard as ${authorLogin}.`
      : `Your best score is already on the leaderboard as ${authorLogin} - this submission ranked lower, so it was not applied.`,
  );
}

main();
