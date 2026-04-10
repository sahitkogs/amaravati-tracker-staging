/**
 * Client-side cache tests
 * Verifies that localStorage caching prevents redundant Worker calls.
 *
 * Run: node tests/client-cache-test.js [url]
 * Requires: playwright (npx playwright install chromium)
 */

const { chromium } = require('playwright');

const BASE_URL = process.argv[2] || 'http://localhost:8766/index.html';
let pass = 0, fail = 0;

function assert(condition, msg) {
  if (condition) { console.log(`  PASS: ${msg}`); pass++; }
  else { console.log(`  FAIL: ${msg}`); fail++; }
}

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  console.log(`=== Client Cache Tests ===`);
  console.log(`URL: ${BASE_URL}\n`);

  // ── Test 1: localStorage gets populated after first load ──
  console.log('--- Test 1: localStorage populated on first load ---');
  await page.goto(BASE_URL);

  // Wait for articles to finish loading first (they load on default tab)
  await page.waitForTimeout(15000);

  // Click YouTube tab and wait for videos to load
  await page.click('.sidebar-tab:nth-child(2)');

  // Wait for video cards to appear, with generous timeout
  let videosLoaded = false;
  try {
    await page.waitForSelector('.video-card', { timeout: 30000 });
    await page.waitForTimeout(10000);
    videosLoaded = true;
  } catch {
    console.log('  INFO: No video cards appeared within 30s (YouTube API quota may be exhausted)');
  }

  const videoCache = await page.evaluate(() => {
    const raw = localStorage.getItem('videoCache');
    if (!raw) return null;
    const entries = JSON.parse(raw);
    return { entryCount: entries.length, firstKey: entries[0]?.[0] || null };
  });

  if (videosLoaded) {
    assert(videoCache !== null, 'videoCache exists in localStorage');
    assert(videoCache && videoCache.entryCount > 0, `videoCache has ${videoCache?.entryCount || 0} entries`);
  } else {
    console.log('  SKIP: videoCache test skipped (no videos loaded — likely quota exceeded)');
  }

  const newsCache = await page.evaluate(() => {
    const raw = localStorage.getItem('newsCache');
    if (!raw) return null;
    const entries = JSON.parse(raw);
    return { entryCount: entries.length, firstKey: entries[0]?.[0] || null };
  });

  assert(newsCache !== null, 'newsCache exists in localStorage');
  assert(newsCache && newsCache.entryCount > 0, `newsCache has ${newsCache?.entryCount || 0} entries`);

  console.log('');

  // ── Test 2: Second load uses cache — no Worker requests for cached terms ──
  console.log('--- Test 2: Cached load makes no Worker requests ---');

  const workerRequests = [];
  await page.route('**/cors-proxy-staging.sahit-koganti.workers.dev/**', (route) => {
    workerRequests.push(route.request().url());
    route.continue();
  });
  // Also catch production Worker
  await page.route('**/cors-proxy.sahit-koganti.workers.dev/**', (route) => {
    workerRequests.push(route.request().url());
    route.continue();
  });

  // Reload the page — localStorage cache should serve everything
  await page.goto(BASE_URL);
  await page.waitForTimeout(8000);

  // Click YouTube tab
  await page.click('.sidebar-tab:nth-child(2)');
  await page.waitForTimeout(8000);

  const videoCards = await page.$$eval('.video-card', els => els.length);

  // Check how many Worker requests were made
  const ytRequests = workerRequests.filter(u => u.includes('/youtube/search'));
  const newsRequests = workerRequests.filter(u => u.includes('/news/search'));

  assert(newsRequests.length === 0, `News Worker requests on reload: ${newsRequests.length} (expected 0)`);

  if (videosLoaded) {
    assert(videoCards > 0, `${videoCards} video cards rendered on cached load`);
    assert(ytRequests.length === 0, `YouTube Worker requests on reload: ${ytRequests.length} (expected 0)`);
  } else {
    console.log(`  SKIP: YouTube cache test skipped (quota exhausted, ${ytRequests.length} requests made)`);
  }

  if (workerRequests.length > 0) {
    console.log(`  INFO: Worker requests made: ${workerRequests.length}`);
    workerRequests.slice(0, 3).forEach(u => console.log(`    ${u.slice(0, 100)}`));
  }

  console.log('');

  // ── Test 3: Cache entries have fetchedAt timestamps ──
  console.log('--- Test 3: Cache entries have valid timestamps ---');

  const timestamps = await page.evaluate(() => {
    const results = {};
    ['videoCache', 'newsCache'].forEach(key => {
      const raw = localStorage.getItem(key);
      if (!raw) { results[key] = null; return; }
      const entries = JSON.parse(raw);
      results[key] = entries.map(([k, v]) => ({
        key: k.slice(0, 40),
        fetchedAt: v.fetchedAt,
        ageMinutes: Math.round((Date.now() - v.fetchedAt) / 60000),
        itemCount: (v.videos || v.articles || []).length
      }));
    });
    return results;
  });

  if (timestamps.videoCache) {
    const allValid = timestamps.videoCache.every(e => e.fetchedAt > 0 && e.ageMinutes < 130);
    assert(allValid, `All ${timestamps.videoCache.length} video cache entries have valid timestamps (< 2hr old)`);
  }
  if (timestamps.newsCache) {
    const allValid = timestamps.newsCache.every(e => e.fetchedAt > 0 && e.ageMinutes < 130);
    assert(allValid, `All ${timestamps.newsCache.length} news cache entries have valid timestamps (< 2hr old)`);
  }

  console.log('');

  // ── Summary ──
  console.log('=== Results ===');
  console.log(`  ${pass} passed, ${fail} failed`);

  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})();
