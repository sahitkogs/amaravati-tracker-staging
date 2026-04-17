# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

Vanilla HTML/CSS/JS static site (no build step, no framework). An interactive Leaflet map of Amaravati construction sites with a sidebar that fetches live news (Google News RSS) and YouTube videos for the locations currently in view. Long-term goal is to make this a general template — users will be able to mark their own points and see feeds for them — so avoid hardcoding Amaravati-specific assumptions outside `data.js`.

## Common commands

```bash
# Run locally — needed because file:// blocks cross-file loading
python -m http.server 8766
# then open http://localhost:8766/index.html

# Deploy site to STAGING (default workflow)
git push staging main

# Deploy site to PRODUCTION (only when explicitly requested)
git push prod main

# Deploy Worker to staging
cd cors-proxy && wrangler deploy --env staging

# Deploy Worker to production
cd cors-proxy && wrangler deploy

# Edge cache tests (validates Worker X-Cache HIT/MISS behavior)
bash tests/cache-tests.sh staging       # or "prod"

# Client-side cache tests (validates localStorage behavior, requires playwright)
node tests/client-cache-test.js http://localhost:8766/index.html
```

**Default git remote is `staging`.** Never push to `prod` unless the user explicitly says so. Each environment has its own GitHub repo (GitHub Pages allows only one Pages site per repo) and its own Cloudflare Worker.

## Architecture

### Three-tier data flow

```
Browser (localStorage 2hr TTL)
   ↓ miss
Cloudflare Worker (edge cache 6hr TTL, all users share)
   ↓ miss
Upstream: Google News RSS / YouTube Data API v3
```

The client never talks to Google or YouTube directly. Both `/news/search` and `/youtube/search` endpoints on the Worker do upstream fetch + parse + edge cache. The API key for YouTube is stored as a Worker secret (`wrangler secret put YOUTUBE_API_KEY`), never in client code.

**Why this matters:** YouTube Data API v3 has a 10,000 unit/day quota and search costs 100 units. Without the edge cache, ~5 fresh page loads/day exhausts it. With the cache, 20 search terms × 4 refreshes/day = ~8,100 units regardless of user count. **Don't bypass the Worker, and don't shorten cache TTLs casually.** The cache is doing real load-bearing work.

### Environment routing

`app.js` auto-detects environment by hostname/path and routes to the matching Worker:

| Site | Hostname/path | Worker |
|---|---|---|
| Production | `sahitkogs.github.io/amaravati-tracker/` | `cors-proxy.sahit-koganti.workers.dev` |
| Staging | anything else (incl. localhost) | `cors-proxy-staging.sahit-koganti.workers.dev` |

Local dev hits the staging Worker — safe to break, separate edge cache, separate metrics.

### Sidebar rendering

The sidebar reacts to map viewport changes. `LOCATIONS` from `data.js` are filtered by current map bounds, then articles/videos for those locations are pulled from `articlesByLoc` / `videosByLoc` Maps, deduplicated by URL/videoId, sorted newest-first, and grouped by time bucket (Today / This Week / This Month / Older). Two tabs (Articles, YouTube) share this pipeline.

### Files that matter for understanding

- `data.js` — `LOCATIONS` array. The `searchKeywords` field on each location is what gets sent to both News and YouTube searches. Adding/changing locations only requires editing this file.
- `app.js` — Single-file client. Sections are separated by big banner comments (`MAP INIT`, `MARKERS`, `NEWS FETCHING`, `YOUTUBE FETCHING`, etc.). Read the relevant section, not the whole file.
- `cors-proxy/worker.js` — The Cloudflare Worker. `handleYouTubeSearch` and `handleNewsSearch` both follow the same pattern: check `caches.default`, return with `X-Cache: HIT` if found, else fetch upstream and `cache.put` before returning with `X-Cache: MISS`.
- `cors-proxy/wrangler.toml` — Defines top-level (production) deployment and `[env.staging]` override. Each env has independent secrets.

## Testing notes

The cache tests validate two distinct things:

1. **Edge cache** (`tests/cache-tests.sh`) — uses curl, checks `X-Cache` response header. A unique query (timestamp-suffixed) is used to guarantee MISS on first hit and HIT on second hit. News tests gracefully skip when Google returns 502 (it sometimes blocks Cloudflare datacenter IPs — the cache mitigates this since one successful fetch stays cached for 6hr).

2. **Client cache** (`tests/client-cache-test.js`) — uses Playwright, intercepts network requests on a second page load, asserts zero Worker calls for entries already in localStorage. The YouTube portion auto-skips when the daily API quota is exhausted (test detects "no video cards rendered after 30s" and skips rather than fails).

## Things that look like bugs but aren't

- **Console may show 404s for `archives/`** — `.gitignore`'d intentionally, the app doesn't reference these.
- **`.video-feed::after`** — pseudo-element with `flex: 1` and a gradient. This is the fix for the YouTube tab's bottom gap when content is shorter than the viewport. Don't remove unless replacing with something equivalent. See `plans/sidebar-bottom-gap.md` for the full backstory.
- **Worker forwards upstream errors verbatim** — a 403 from the Worker is usually the YouTube API quota being exhausted, not a Worker bug. Hit `https://www.googleapis.com/youtube/v3/search?...&key=...` directly to confirm.
