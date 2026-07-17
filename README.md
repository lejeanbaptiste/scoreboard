# LJB Service Record Leaderboard

Static leaderboard for [Le Jean-Baptiste](https://github.com/lejeanbaptiste/lejeanbaptiste).
`index.html` reads `scores.json` and renders a ranked table — no build
step, served as-is via GitHub Pages.

## Current status: Phase 1 (closed group)

This repo is currently just the static display half. There is no
submission pipeline yet — `scores.json` is a placeholder (`[]`) until the
backend piece is built. Planned shape:

- Players authenticate with GitHub OAuth (real accounts, not free-text
  names) and submit their current stats through a small backend API.
- The backend rate-limits submissions per account and writes the
  authoritative data to a datastore it controls.
- A periodic job publishes `scores.json` here from that datastore. This
  repo never accepts a direct write from a client.

## `scores.json` schema

```json
[
  {
    "id": "github account id or a stable per-install uuid",
    "displayName": "Daniel",
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

`id` is the de-duplication key — a resubmission from the same identity
updates that entry rather than creating a new row.

## Phase 2 (not built, noted for later)

Phase 1's totals are still self-reported by the client, same as the local
`achievements.json` file the desktop app already tracks — a submission
channel secured with OAuth stops people from tampering with *each other's*
rows, but not from lying about their own. Closing that gap means moving
the source of truth for progress server-side (the app reports individual
save events rather than a final tally, and the server computes totals from
that log) rather than anything fixable in this repo. Only worth building
if cheating actually becomes a real problem for a small community.
