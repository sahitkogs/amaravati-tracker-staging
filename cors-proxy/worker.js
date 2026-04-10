const ALLOWED_ORIGINS = [
  'https://sahitkogs.github.io',
  'http://localhost',
  'http://127.0.0.1',
];

const ALLOWED_HOSTS = [
  'news.google.com',
];

const YT_API_BASE = 'https://www.googleapis.com/youtube/v3';
const YT_CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds
const NEWS_CACHE_TTL = 6 * 60 * 60; // 6 hours in seconds

function isOriginAllowed(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.some(o => origin === o || origin.startsWith(o + ':'));
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(data, origin, status = 200, cacheTtl = 0) {
  const headers = new Headers(corsHeaders(origin));
  headers.set('Content-Type', 'application/json');
  if (cacheTtl > 0) {
    headers.set('Cache-Control', `public, max-age=${cacheTtl}`);
  }
  return new Response(JSON.stringify(data), { status, headers });
}

function parseIsoDuration(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

async function handleYouTubeSearch(url, origin, env) {
  const q = url.searchParams.get('q');
  if (!q) return jsonResponse({ error: 'Missing ?q= parameter' }, origin, 400);

  const maxResults = url.searchParams.get('maxResults') || '10';

  // Check Cloudflare edge cache
  const cacheKey = new Request(`https://yt-cache/${q}/${maxResults}`, { method: 'GET' });
  const cache = caches.default;
  let cached = await cache.match(cacheKey);
  if (cached) {
    const resp = new Response(cached.body, cached);
    resp.headers.set('X-Cache', 'HIT');
    return resp;
  }

  // Search YouTube
  const searchUrl = `${YT_API_BASE}/search?part=snippet&q=${encodeURIComponent(q)}&type=video&order=date&regionCode=IN&maxResults=${maxResults}&key=${env.YOUTUBE_API_KEY}`;
  const searchResp = await fetch(searchUrl);
  if (!searchResp.ok) {
    const err = await searchResp.text();
    return jsonResponse({ error: 'YouTube search failed', detail: err }, origin, searchResp.status);
  }
  const searchData = await searchResp.json();
  const items = searchData.items || [];

  // Fetch video details (duration, views) in one batch call
  const videoIds = items.map(item => item.id.videoId).filter(Boolean);
  let details = {};
  if (videoIds.length > 0) {
    const detailsUrl = `${YT_API_BASE}/videos?part=contentDetails,statistics&id=${videoIds.join(',')}&key=${env.YOUTUBE_API_KEY}`;
    const detailsResp = await fetch(detailsUrl);
    if (detailsResp.ok) {
      const detailsData = await detailsResp.json();
      (detailsData.items || []).forEach(item => {
        details[item.id] = {
          duration: parseIsoDuration(item.contentDetails?.duration || ''),
          views: parseInt(item.statistics?.viewCount || '0', 10),
        };
      });
    }
  }

  // Combine into final response
  const videos = items.map(item => {
    const id = item.id.videoId;
    const s = item.snippet;
    const d = details[id] || {};
    return {
      title: s.title,
      videoId: id,
      link: `https://www.youtube.com/watch?v=${id}`,
      channel: s.channelTitle || '',
      thumb: s.thumbnails?.medium?.url || s.thumbnails?.default?.url || '',
      published: s.publishedAt || '',
      duration: d.duration || 0,
      views: d.views || 0,
    };
  });

  const response = jsonResponse(videos, origin, 200, YT_CACHE_TTL);
  response.headers.set('X-Cache', 'MISS');

  // Store in edge cache (without X-Cache header so cached copy is clean)
  const cacheResp = response.clone();
  cacheResp.headers.delete('X-Cache');
  await cache.put(cacheKey, cacheResp);

  return response;
}

async function handleNewsSearch(url, origin) {
  const q = url.searchParams.get('q');
  if (!q) return jsonResponse({ error: 'Missing ?q= parameter' }, origin, 400);

  const maxResults = parseInt(url.searchParams.get('maxResults') || '8', 10);

  // Check Cloudflare edge cache
  const cacheKey = new Request(`https://news-cache/${q}/${maxResults}`, { method: 'GET' });
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const resp = new Response(cached.body, cached);
    resp.headers.set('X-Cache', 'HIT');
    return resp;
  }

  // Fetch Google News RSS
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const rssResp = await fetch(rssUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsAggregator/1.0)' },
  });

  if (!rssResp.ok) {
    return jsonResponse({ error: 'Google News fetch failed', status: rssResp.status }, origin, 502);
  }

  const xmlText = await rssResp.text();

  // Parse RSS XML server-side
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xmlText)) !== null && articles.length < maxResults) {
    const item = match[1];
    const title = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] || '';
    const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1] || '';
    const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] || '';
    const source = item.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] || '';
    const descHtml = item.match(/<description>([\s\S]*?)<\/description>/)?.[1] || '';
    const thumb = descHtml.match(/src="([^"]+)"/)?.[1] || '';

    const cleanTitle = source && title.endsWith(' - ' + source)
      ? title.slice(0, -((' - ' + source).length))
      : title;

    articles.push({ title: cleanTitle, link, pubDate, source, thumb });
  }

  const response = jsonResponse(articles, origin, 200, NEWS_CACHE_TTL);
  response.headers.set('X-Cache', 'MISS');

  const cacheResp = response.clone();
  cacheResp.headers.delete('X-Cache');
  await cache.put(cacheKey, cacheResp);

  return response;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigin = isOriginAllowed(origin) ? origin : ALLOWED_ORIGINS[0];

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(allowedOrigin) });
    }
    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405 });
    }

    const url = new URL(request.url);

    if (url.pathname === '/youtube/search') {
      return handleYouTubeSearch(url, allowedOrigin, env);
    }
    if (url.pathname === '/news/search') {
      return handleNewsSearch(url, allowedOrigin);
    }

    return jsonResponse({ error: 'Not found', endpoints: ['/youtube/search?q=...', '/news/search?q=...'] }, allowedOrigin, 404);
  },
};
