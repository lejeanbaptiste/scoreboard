# LJB Service Record Leaderboard

Static leaderboard for [Le Jean-Baptiste](https://github.com/lejeanbaptiste/lejeanbaptiste).
`index.html` reads `scores.json` and renders a ranked table — no build
step, served as-is via GitHub Pages at
[lejeanbaptiste.github.io/scoreboard](https://lejeanbaptiste.github.io/scoreboard/).

## How submission works (Phase 1, implemented)

There is no backend, no OAuth flow, and no credential this repo hands out
to anyone:

1. The desktop app's "Submit to Leaderboard" button opens
   [issue #1](https://github.com/lejeanbaptiste/scoreboard/issues/1) (a
   permanent, pinned thread) and the player posts a comment containing
   their stats as a fenced ` ```json ` block.
2. [`.github/workflows/process-submission.yml`](.github/workflows/process-submission.yml)
   runs on that comment, using
   [`scripts/process-submission.mjs`](scripts/process-submission.mjs) to
   validate the payload, rate-limit (15 min between submissions per
   identity), and update `scores.json` — committed with the repo's own
   automatic, repo-scoped `GITHUB_TOKEN`. Nothing a client holds can write
   to this repo directly.
3. Identity comes from *who posted the comment* — GitHub itself guarantees
   that (you cannot comment as someone else), so there's no separate login
   step to build or maintain.

This is a comment on an existing issue rather than a new issue per
submission deliberately: opening an issue is a public GitHub contribution
(shows up in the submitter's profile contribution graph); commenting is
not. Repeated submissions shouldn't leave a trail on anyone's real GitHub
activity stats.

## `scores.json` schema

```json
[
  {
    "id": "the submitter's numeric GitHub user id",
    "displayName": "their GitHub login",
    "commission": "Caporal, Order of the Angle Bracket",
    "metrics": {
      "texts": 1,
      "tags": 797,
      "disambiguated": 53,
      "places": 4,
      "entities": 50
    },
    "unlockedCount": 6,
    "totalAchievements": 50,
    "updatedAt": "2026-07-18T00:00:00.000Z"
  }
]
```

`id` is the de-duplication key — a resubmission from the same GitHub
account updates that entry rather than creating a new row.

## Phase 2

Not built. Phase 1's totals are still self-reported by the client, same as
the local `achievements.json` file the desktop app already tracks — a
secured submission channel stops people from tampering with *each other's*
rows, but not from lying about their own. See
[`docs/PHASE_2.md`](docs/PHASE_2.md) for the scope of what closing that gap
would actually require.
