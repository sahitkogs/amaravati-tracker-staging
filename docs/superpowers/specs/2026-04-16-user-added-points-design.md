# User-Added Map Points — Design Spec

## Summary

Transform the app from a hardcoded Amaravati construction tracker into a general-purpose personal news map. Users search for any place in the world, add it to their map, and get news articles + YouTube videos for that location. The 20 hardcoded Amaravati locations are removed entirely — the map starts empty.

## Decisions

| Decision | Choice |
|---|---|
| Persistence | localStorage (browser-local, survives refresh) |
| Geographic scope | Global (any place in the world) |
| Point limit | Soft cap of 10 user-added points |
| Starting state | 0 points — clean slate |
| Geocoding | Leaflet Control Geocoder plugin (wraps Nominatim, free, no API key) |
| Search keywords | Auto-fill from place name, user can edit before confirming |
| Add-point UX | Sidebar confirmation panel |
| Point management | Remove via marker popup; no inline edit (remove + re-add instead) |
| Branding | "News Map" (replacing "Amaravati Tracker") |

## Data Model

User points stored in `localStorage['userLocations']` as a JSON array:

```js
{
  id: "user_1713200000000",      // "user_" + Date.now()
  name: "Tokyo Tower",           // from geocoder result
  lat: 35.6586,
  lng: 139.7454,
  searchKeywords: "Tokyo Tower news",  // user-editable at add time
  addedAt: 1713200000000
}
```

No `category`, `status`, `nameLocal`, or `description` fields — these were Amaravati-specific and are removed.

## User Flows

### Search & Add Point

1. User types a place name in the geocoder search bar (top-left of map).
2. Leaflet Control Geocoder shows autocomplete results from Nominatim.
3. User selects a result — map pans to the location, temporary marker appears.
4. Sidebar switches to a **confirmation panel** showing:
   - Place name and coordinates
   - Editable text input for search keywords (pre-filled with place name)
   - "X / 10 points" counter
   - "Add Point" button + "Cancel" button
5. **On Add**: point saved to localStorage, permanent marker placed, sidebar returns to news/video feed and begins fetching for the new point.
6. **On Cancel**: temporary marker removed, sidebar returns to normal view.

### At Point Limit

When user has 10 points and tries to add another, the confirmation panel still appears but:
- Shows message: "You've reached the 10-point limit. Remove a point to add a new one."
- "Add Point" button is disabled.

### Remove Point

Clicking a user point's marker opens a Leaflet popup with:
- Point name
- "Remove" button

Removing deletes from localStorage, removes the marker from the map, and updates the sidebar.

### Empty State

When map has 0 points, sidebar shows:
- Pin icon
- "No points yet" heading
- "Search for a place and add it to your map to start tracking news and videos."
- "0 / 10 points" counter

## Architecture

### Data Flow (unchanged for news/video fetching)

```
Browser (localStorage 2hr TTL)
   ↓ miss
Cloudflare Worker (edge cache 6hr TTL)
   ↓ miss
Upstream: Google News RSS / YouTube Data API v3
```

The only change is that `searchKeywords` now comes from user input instead of hardcoded `data.js`. The Worker accepts any `q` parameter — no changes needed.

### What Gets Added

- **Leaflet Control Geocoder** — CSS + JS from CDN in `index.html`
- **`loadUserLocations()` / `saveUserLocations()`** — localStorage read/write in `app.js`
- **Sidebar confirmation panel** — new render function in `app.js`
- **Empty state rendering** — new render function in `app.js`

### What Gets Removed

- **`data.js`** — `LOCATIONS` array removed entirely. `CATEGORY_COLORS`, `CATEGORY_LABELS`, `STATUS_CONFIG` also removed (no categories/statuses for user points).
- **Category filter UI** — the 6 desktop pills and mobile dropdown in `index.html` and filter logic in `app.js`.
- **"Amaravati Tracker" branding** — replaced with "News Map" / "Track news & videos for any place".

### What Stays the Same

- **`cors-proxy/worker.js`** — no changes. Already accepts any `q` parameter.
- **News/video fetching pipeline** — `fetchNews()`, `fetchVideos()`, localStorage caching with 2hr TTL all work as-is.
- **Sidebar tabs** — Articles and YouTube tabs remain, same time-bucket grouping.
- **Map controls** — theme toggle, satellite toggle, zoom, home button.
- **`tests/cache-tests.sh`** — tests the Worker, unaffected.

## File Changes

| File | Change |
|---|---|
| `index.html` | Add geocoder CDN links. Remove category filters. Update branding to "News Map". |
| `app.js` | Add user location CRUD (load/save/add/remove). Initialize geocoder. Add sidebar confirmation panel + empty state. Remove category filter logic. Replace `LOCATIONS` usage with user locations array. Update marker popups with remove button. |
| `data.js` | Delete the file. Remove the `<script src="data.js">` tag from `index.html`. |
| `tests/client-cache-test.js` | Update to work with user-added points instead of hardcoded locations. |

## Quota Impact

No change to the quota math. User points go through the same Worker edge cache (6hr TTL). With 10-point limit per user, worst case per user is 10 fresh keyword searches × 2 (news + video) = 20 Worker hits, most of which will be edge-cache HITs from other users searching similar terms. The 10-point cap keeps individual user impact bounded.
