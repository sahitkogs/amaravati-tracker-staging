// ══════════════════════════════════════════════════════════
//  MAP INIT
// ══════════════════════════════════════════════════════════
const map = L.map('map', {
  center: [16.505, 80.515],
  zoom: 13,
  zoomControl: true,
  attributionControl: true
});

const tileLayers = {
  night: L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 20, subdomains: 'abcd'
  }),
  day: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
    maxZoom: 20, subdomains: 'abcd'
  }),
  satellite: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '&copy; Esri', maxZoom: 19
  })
};

tileLayers.night.addTo(map);
let currentTileLayer = 'night';
let isDay = false;

function switchTileLayer(layer) {
  if (layer === currentTileLayer) return;
  map.removeLayer(tileLayers[currentTileLayer]);
  tileLayers[layer].addTo(map);
  currentTileLayer = layer;
}

// Day/Night toggle
const themeToggle = document.getElementById('themeToggle');
themeToggle.addEventListener('click', () => {
  isDay = !isDay;
  themeToggle.classList.toggle('day', isDay);
  document.body.classList.toggle('day-mode', isDay);
  // If currently on satellite, don't switch — just remember preference
  if (currentTileLayer !== 'satellite') {
    switchTileLayer(isDay ? 'day' : 'night');
  }
  // Deactivate satellite button when switching theme
  document.querySelector('[data-layer="satellite"]').classList.remove('active');
});

// Satellite toggle
document.querySelector('[data-layer="satellite"]').addEventListener('click', function () {
  if (currentTileLayer === 'satellite') {
    // Toggle off satellite — go back to day/night
    switchTileLayer(isDay ? 'day' : 'night');
    this.classList.remove('active');
  } else {
    switchTileLayer('satellite');
    this.classList.add('active');
  }
});

// ══════════════════════════════════════════════════════════
//  MARKERS & LAYER GROUPS
// ══════════════════════════════════════════════════════════
const layerGroups = {};

Object.keys(CATEGORY_COLORS).forEach(cat => {
  layerGroups[cat] = L.layerGroup().addTo(map);
});

LOCATIONS.forEach(loc => {
  const color = CATEGORY_COLORS[loc.category];
  const size = 12;
  const icon = L.divIcon({
    className: '',
    html: `<div class="marker-icon" style="width:${size}px;height:${size}px;background:${color};" data-id="${loc.id}"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
  const marker = L.marker([loc.lat, loc.lng], { icon }).addTo(layerGroups[loc.category]);

  const catLabel = CATEGORY_LABELS[loc.category];
  const catColor = CATEGORY_COLORS[loc.category];
  const statusCfg = STATUS_CONFIG[loc.status];
  const popupContent = `
    <div class="map-popup">
      <div class="map-popup-name">${loc.name}</div>
      ${loc.nameLocal ? `<div class="map-popup-local">${loc.nameLocal}</div>` : ''}
      <div class="map-popup-meta">
        <span class="map-popup-cat" style="color:${catColor};">${catLabel}</span>
        <span class="map-popup-sep">&middot;</span>
        <span class="map-popup-status" style="color:${statusCfg.color};">${statusCfg.label}</span>
      </div>
      <div class="map-popup-desc">${loc.description}</div>
    </div>
  `;

  marker.bindPopup(popupContent, {
    className: 'custom-popup',
    maxWidth: 260,
    closeButton: false
  });

  marker.on('click', () => {
    selectedLocation = loc;
    lastVisibleIds = ''; // force re-render
    renderSidebar(true);
    map.setView([loc.lat, loc.lng], Math.max(map.getZoom(), 14), { animate: true });
  });
  loc._marker = marker;
});

// Clear selection when popup closes
map.on('popupclose', () => {
  if (selectedLocation) {
    selectedLocation = null;
    lastVisibleIds = '';
    renderSidebar(true);
  }
});

// ══════════════════════════════════════════════════════════
//  NEWS FETCHING — Google News RSS via CORS proxy
// ══════════════════════════════════════════════════════════
const newsCache = new Map();
const CACHE_TTL = 10 * 60 * 1000;
const PROXY_BASE = 'https://corsproxy.io/?';

function buildProxiedRssUrl(keywords) {
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(keywords)}&hl=en-IN&gl=IN&ceid=IN:en`;
  return PROXY_BASE + encodeURIComponent(rssUrl);
}

function parseRssXml(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, 'text/xml');
  const items = doc.querySelectorAll('item');
  const articles = [];

  items.forEach((item, i) => {
    if (i >= 5) return;

    const title = item.querySelector('title')?.textContent || '';
    const link = item.querySelector('link')?.textContent || '';
    const pubDate = item.querySelector('pubDate')?.textContent || '';
    const source = item.querySelector('source')?.textContent || '';

    const descHtml = item.querySelector('description')?.textContent || '';
    let thumb = '';
    const imgMatch = descHtml.match(/<img[^>]+src="([^"]+)"/);
    if (imgMatch) thumb = imgMatch[1];

    const cleanTitle = source && title.endsWith(' - ' + source)
      ? title.slice(0, -((' - ' + source).length))
      : title;

    articles.push({ title: cleanTitle, link, pubDate, source, thumb });
  });

  return articles;
}

async function fetchNews(keywords) {
  const cached = newsCache.get(keywords);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.articles;
  }

  const url = buildProxiedRssUrl(keywords);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const xmlText = await resp.text();
  const articles = parseRssXml(xmlText);

  newsCache.set(keywords, { articles, fetchedAt: Date.now() });
  return articles;
}

// ══════════════════════════════════════════════════════════
//  YOUTUBE FETCHING — via Invidious API
// ══════════════════════════════════════════════════════════
const videoCache = new Map();
const videosByLoc = new Map();
const INVIDIOUS_INSTANCES = [
  'https://vid.puffyan.us',
  'https://invidious.fdn.fr',
  'https://y.com.sb',
  'https://invidious.perennialte.ch'
];

function parseVideoResults(data) {
  return data
    .filter(item => item.type === 'video')
    .slice(0, 6)
    .map(v => ({
      title: v.title,
      videoId: v.videoId,
      link: `https://www.youtube.com/watch?v=${v.videoId}`,
      channel: v.author || '',
      thumb: v.videoThumbnails?.find(t => t.quality === 'medium')?.url
        || v.videoThumbnails?.[0]?.url || '',
      published: v.published ? new Date(v.published * 1000).toISOString() : '',
      duration: v.lengthSeconds || 0,
      views: v.viewCount || 0
    }));
}

async function fetchVideos(keywords) {
  const cached = videoCache.get(keywords);
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
    return cached.videos;
  }

  // Try direct Invidious first, then proxied
  for (const instance of INVIDIOUS_INSTANCES) {
    const apiPath = `/api/v1/search?q=${encodeURIComponent(keywords)}&type=video&sort_by=upload_date&region=IN`;
    const urls = [
      instance + apiPath,
      PROXY_BASE + encodeURIComponent(instance + apiPath)
    ];

    for (const url of urls) {
      try {
        const resp = await fetch(url);
        if (!resp.ok) continue;
        const data = await resp.json();
        const videos = parseVideoResults(data);
        if (videos.length > 0) {
          videoCache.set(keywords, { videos, fetchedAt: Date.now() });
          return videos;
        }
      } catch (e) {
        continue;
      }
    }
  }

  videoCache.set(keywords, { videos: [], fetchedAt: Date.now() });
  return [];
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatViews(n) {
  if (!n) return '';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M views';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K views';
  return n + ' views';
}

// ══════════════════════════════════════════════════════════
//  TIME HELPERS
// ══════════════════════════════════════════════════════════
function timeAgo(dateStr) {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getTimeGroup(dateStr) {
  const now = new Date();
  const then = new Date(dateStr);
  const diffMs = now - then;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  // Check if same calendar day
  if (now.toDateString() === then.toDateString()) return 'Today';
  if (diffDays <= 1) return 'Yesterday';
  if (diffDays <= 7) return 'This Week';
  if (diffDays <= 14) return 'Last Week';
  if (diffDays <= 30) return 'This Month';
  return 'Older';
}

const TIME_GROUP_ORDER = ['Today', 'Yesterday', 'This Week', 'Last Week', 'This Month', 'Older'];

// ══════════════════════════════════════════════════════════
//  SIDEBAR — tabbed feed (Articles / YouTube)
// ══════════════════════════════════════════════════════════
const sidebarBody = document.getElementById('sidebarBody');
const visibleCountEl = document.getElementById('visibleCount');
let activeFilter = 'all';
let activeTab = 'articles';
let renderGeneration = 0;
let lastVisibleIds = '';
let selectedLocation = null;
const articlesByLoc = new Map();

function getVisibleLocations() {
  // If a point is selected, return only that location
  if (selectedLocation) return [selectedLocation];

  const bounds = map.getBounds();
  return LOCATIONS.filter(loc => {
    if (activeFilter !== 'all' && loc.category !== activeFilter) return false;
    return bounds.contains([loc.lat, loc.lng]);
  });
}

// ── Article rendering ──
function renderArticleHtml(article) {
  const catColor = CATEGORY_COLORS[article._loc.category];
  const thumbHtml = article.thumb
    ? `<img class="news-article-thumb" src="${article.thumb}" alt="" loading="lazy" onerror="this.remove()">`
    : '';

  return `
    <a class="news-article" href="${article.link}" target="_blank" rel="noopener">
      <div class="news-article-body">
        <div class="news-article-source">
          <span class="news-article-source-name">${article.source}</span>
          <span class="news-article-time">${timeAgo(article.pubDate)}</span>
        </div>
        <div class="news-article-title">${article.title}</div>
        <span class="news-article-tag" style="background:${catColor}18;color:${catColor};">
          <span class="news-article-tag-dot" style="background:${catColor};"></span>
          ${article._loc.name}
        </span>
      </div>
      ${thumbHtml}
    </a>
  `;
}

function buildArticlesFeedHtml(visibleIds) {
  const allArticles = [];
  visibleIds.forEach(id => {
    const arts = articlesByLoc.get(id);
    if (arts) allArticles.push(...arts);
  });

  const seen = new Set();
  const unique = allArticles.filter(a => {
    if (seen.has(a.link)) return false;
    seen.add(a.link);
    return true;
  });

  unique.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

  const groups = {};
  unique.forEach(article => {
    const group = getTimeGroup(article.pubDate);
    if (!groups[group]) groups[group] = [];
    groups[group].push(article);
  });

  let html = '';
  TIME_GROUP_ORDER.forEach(groupName => {
    const articles = groups[groupName];
    if (!articles || articles.length === 0) return;
    html += `<div class="time-group-header">${groupName}</div>`;
    html += articles.map(renderArticleHtml).join('');
  });

  return html;
}

// ── Video rendering ──
function renderVideoHtml(video) {
  const catColor = CATEGORY_COLORS[video._loc.category];
  const dur = formatDuration(video.duration);
  const views = formatViews(video.views);

  return `
    <a class="video-card" href="${video.link}" target="_blank" rel="noopener">
      <div class="video-card-thumb">
        <img src="${video.thumb}" alt="" loading="lazy" onerror="this.parentElement.style.display='none'">
        ${dur ? `<span class="video-card-duration">${dur}</span>` : ''}
      </div>
      <div class="video-card-title">${video.title}</div>
      <div class="video-card-meta">
        <span class="video-card-channel">${video.channel}</span>
        ${views ? `<span class="sep"></span><span>${views}</span>` : ''}
        ${video.published ? `<span class="sep"></span><span>${timeAgo(video.published)}</span>` : ''}
      </div>
      <span class="news-article-tag" style="background:${catColor}18;color:${catColor};">
        <span class="news-article-tag-dot" style="background:${catColor};"></span>
        ${video._loc.name}
      </span>
    </a>
  `;
}

function buildVideosFeedHtml(visibleIds) {
  const allVideos = [];
  visibleIds.forEach(id => {
    const vids = videosByLoc.get(id);
    if (vids) allVideos.push(...vids);
  });

  // Deduplicate by videoId
  const seen = new Set();
  const unique = allVideos.filter(v => {
    if (seen.has(v.videoId)) return false;
    seen.add(v.videoId);
    return true;
  });

  // Sort newest first
  unique.sort((a, b) => new Date(b.published || 0) - new Date(a.published || 0));

  if (unique.length === 0) return '';

  // Group by time period
  const groups = {};
  unique.forEach(video => {
    const group = getTimeGroup(video.published || '2000-01-01');
    if (!groups[group]) groups[group] = [];
    groups[group].push(video);
  });

  let html = '';
  TIME_GROUP_ORDER.forEach(groupName => {
    const videos = groups[groupName];
    if (!videos || videos.length === 0) return;
    html += `<div class="time-group-header">${groupName}</div>`;
    html += `<div class="video-grid">${videos.map(renderVideoHtml).join('')}</div>`;
  });

  return html;
}

// ── Unified render ──
function renderSidebar(forceRefresh) {
  renderGeneration++;
  const gen = renderGeneration;

  const visible = getVisibleLocations();
  visibleCountEl.textContent = visible.length;

  if (visible.length === 0) {
    lastVisibleIds = '';
    sidebarBody.innerHTML = `<div class="sidebar-empty">No locations in the current view.<br>Zoom out or pan the map to see locations.</div>`;
    return;
  }

  const visibleIds = new Set(visible.map(l => l.id));
  const visibleKey = [...visibleIds].sort().join(',');

  if (!forceRefresh && visibleKey === lastVisibleIds) return;
  lastVisibleIds = visibleKey;

  if (activeTab === 'articles') {
    renderArticlesTab(visible, visibleIds, gen);
  } else {
    renderVideosTab(visible, visibleIds, gen);
  }
}

function renderArticlesTab(visible, visibleIds, gen) {
  const toFetch = visible.filter(loc => {
    const cached = newsCache.get(loc.searchKeywords);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
      if (!articlesByLoc.has(loc.id)) {
        articlesByLoc.set(loc.id, cached.articles.map(a => ({ ...a, _loc: loc })));
      }
      return false;
    }
    return true;
  });

  if (toFetch.length === 0) {
    const html = buildArticlesFeedHtml(visibleIds);
    sidebarBody.innerHTML = html || `<div class="sidebar-empty">No news found for visible locations.</div>`;
    return;
  }

  const existingHtml = buildArticlesFeedHtml(visibleIds);
  sidebarBody.innerHTML = existingHtml || `
    <div class="news-loading" style="justify-content:center;padding:30px 16px;">
      <div class="news-loading-spinner"></div>
      Loading articles...
    </div>
  `;

  let completed = 0;
  toFetch.forEach(loc => {
    fetchNews(loc.searchKeywords)
      .then(articles => {
        articlesByLoc.set(loc.id, articles.map(a => ({ ...a, _loc: loc })));
      })
      .catch(() => { articlesByLoc.set(loc.id, []); })
      .finally(() => {
        completed++;
        if (gen !== renderGeneration) return;
        if (completed === toFetch.length) {
          const html = buildArticlesFeedHtml(visibleIds);
          sidebarBody.innerHTML = html || `<div class="sidebar-empty">No news found.</div>`;
        }
      });
  });
}

function renderVideosTab(visible, visibleIds, gen) {
  const toFetch = visible.filter(loc => {
    const cached = videoCache.get(loc.searchKeywords);
    if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL) {
      if (!videosByLoc.has(loc.id)) {
        videosByLoc.set(loc.id, cached.videos.map(v => ({ ...v, _loc: loc })));
      }
      return false;
    }
    return true;
  });

  if (toFetch.length === 0) {
    const html = buildVideosFeedHtml(visibleIds);
    sidebarBody.innerHTML = html || `<div class="sidebar-empty">No videos found for visible locations.</div>`;
    return;
  }

  const existingHtml = buildVideosFeedHtml(visibleIds);
  sidebarBody.innerHTML = existingHtml || `
    <div class="news-loading" style="justify-content:center;padding:30px 16px;">
      <div class="news-loading-spinner"></div>
      Loading videos...
    </div>
  `;

  let completed = 0;
  toFetch.forEach(loc => {
    fetchVideos(loc.searchKeywords)
      .then(videos => {
        videosByLoc.set(loc.id, videos.map(v => ({ ...v, _loc: loc })));
      })
      .catch(() => { videosByLoc.set(loc.id, []); })
      .finally(() => {
        completed++;
        if (gen !== renderGeneration) return;
        if (completed === toFetch.length) {
          const html = buildVideosFeedHtml(visibleIds);
          sidebarBody.innerHTML = html || `<div class="sidebar-empty">No videos found.</div>`;
        }
      });
  });
}

// ── Tab switching ──
document.querySelectorAll('.sidebar-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    if (tab.dataset.tab === activeTab) return;
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    lastVisibleIds = ''; // force re-render
    renderSidebar(true);
  });
});

// Debounce sidebar updates on map move
let renderTimeout = null;
function debouncedRender() {
  clearTimeout(renderTimeout);
  renderTimeout = setTimeout(() => renderSidebar(false), 300);
}

map.on('moveend', debouncedRender);
map.on('zoomend', debouncedRender);

renderSidebar(true);

// ══════════════════════════════════════════════════════════
//  HOME BUTTON
// ══════════════════════════════════════════════════════════
const DEFAULT_CENTER = [16.505, 80.515];
const DEFAULT_ZOOM = 13;

document.getElementById('homeBtn').addEventListener('click', () => {
  map.setView(DEFAULT_CENTER, DEFAULT_ZOOM, { animate: true });
});

// ══════════════════════════════════════════════════════════
//  CATEGORY FILTERS (desktop pills)
// ══════════════════════════════════════════════════════════
function applyFilter(filter) {
  activeFilter = filter;

  // Sync desktop pills
  document.querySelectorAll('.filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });

  // Sync mobile dropdown
  document.querySelectorAll('.filter-dropdown-item').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === filter);
  });
  document.getElementById('filterLabel').textContent =
    filter === 'all' ? 'All' : (CATEGORY_LABELS[filter] || filter);

  // Toggle layers
  Object.entries(layerGroups).forEach(([cat, group]) => {
    if (filter === 'all' || filter === cat) {
      map.addLayer(group);
    } else {
      map.removeLayer(group);
    }
  });

  renderSidebar(true);
}

document.getElementById('filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  applyFilter(btn.dataset.filter);
});

// ══════════════════════════════════════════════════════════
//  FILTER DROPDOWN (mobile)
// ══════════════════════════════════════════════════════════
const filterToggle = document.getElementById('filterToggle');
const filterMenu = document.getElementById('filterMenu');

filterToggle.addEventListener('click', () => {
  filterMenu.classList.toggle('open');
});

filterMenu.addEventListener('click', (e) => {
  const item = e.target.closest('.filter-dropdown-item');
  if (!item) return;
  applyFilter(item.dataset.filter);
  filterMenu.classList.remove('open');
});

// Close dropdown when tapping outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.filter-dropdown')) {
    filterMenu.classList.remove('open');
  }
});

// ══════════════════════════════════════════════════════════
//  SIDEBAR DRAG TO RESIZE (mobile)
// ══════════════════════════════════════════════════════════
const sidebar = document.getElementById('sidebar');
const sidebarHandle = document.getElementById('sidebarHandle');
const SIDEBAR_SNAP_MIN = 15;  // vh
const SIDEBAR_SNAP_MID = 40;  // vh
const SIDEBAR_SNAP_MAX = 75;  // vh

let dragStartY = 0;
let dragStartHeight = 0;
let isDragging = false;

function onDragStart(clientY) {
  isDragging = true;
  dragStartY = clientY;
  dragStartHeight = sidebar.offsetHeight;
  sidebar.style.transition = 'none';
}

function onDragMove(clientY) {
  if (!isDragging) return;
  const delta = dragStartY - clientY;
  const newHeight = Math.max(50, Math.min(window.innerHeight * 0.85, dragStartHeight + delta));
  sidebar.style.height = newHeight + 'px';
}

function onDragEnd() {
  if (!isDragging) return;
  isDragging = false;
  sidebar.style.transition = '';

  // Snap to nearest position
  const currentVh = (sidebar.offsetHeight / window.innerHeight) * 100;
  const snaps = [SIDEBAR_SNAP_MIN, SIDEBAR_SNAP_MID, SIDEBAR_SNAP_MAX];
  const closest = snaps.reduce((a, b) =>
    Math.abs(b - currentVh) < Math.abs(a - currentVh) ? b : a
  );
  sidebar.style.height = closest + 'vh';

  // Invalidate map size after resize
  setTimeout(() => map.invalidateSize(), 350);
}

// Touch events
sidebarHandle.addEventListener('touchstart', (e) => {
  onDragStart(e.touches[0].clientY);
}, { passive: true });

document.addEventListener('touchmove', (e) => {
  if (isDragging) onDragMove(e.touches[0].clientY);
}, { passive: true });

document.addEventListener('touchend', onDragEnd);

// Mouse events (for testing on desktop)
sidebarHandle.addEventListener('mousedown', (e) => {
  onDragStart(e.clientY);
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (isDragging) onDragMove(e.clientY);
});

document.addEventListener('mouseup', onDragEnd);

// ══════════════════════════════════════════════════════════
//  SIDEBAR HORIZONTAL RESIZE (desktop)
// ══════════════════════════════════════════════════════════
const resizeHandle = document.getElementById('sidebarResizeHandle');
let hDragging = false;
let hDragStartX = 0;
let hDragStartWidth = 0;

resizeHandle.addEventListener('mousedown', (e) => {
  hDragging = true;
  hDragStartX = e.clientX;
  hDragStartWidth = sidebar.offsetWidth;
  resizeHandle.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
});

document.addEventListener('mousemove', (e) => {
  if (!hDragging) return;
  const delta = hDragStartX - e.clientX;
  const newWidth = Math.max(320, Math.min(window.innerWidth * 0.7, hDragStartWidth + delta));
  sidebar.style.width = newWidth + 'px';
});

document.addEventListener('mouseup', () => {
  if (!hDragging) return;
  hDragging = false;
  resizeHandle.classList.remove('dragging');
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
  setTimeout(() => map.invalidateSize(), 50);
});
