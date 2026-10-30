import {
  $, $$, escapeHtml, canonicalKey, cleanMeta, posterFor, safeYear, recentHistory,
  continueWatching, mediaProgress, recommendationScore, findResumeFor, videoIdOf,
  episodeLabel, qualityOf, streamType, sourceLabel, sourceDescription, manifestResources,
  rankStreams, formatBytes, sourceProviderKey, toast, debounce, peopleList,
  ratedItems, failoverCandidates, sourceVerdict, usableSources
} from './lib.js';
import { AddonClient } from './addons-client.js';
import { CocoaPlayer } from './player.js';


const APP_NAME = 'CocoaStream';
const APP_ICON = '<span class="brand-mark"><img src="assets/cocoa-128.png" alt="Cocoa" /></span>';
const root = $('#app');
const state = {
  session: null,
  data: null,
  route: 'home',
  rows: [],
  hero: null,
  mediaIndex: new Map(),
  homeLoading: false,
  homeAttempted: false,
  details: null,
  settingsSection: 'addons',
  player: null,
  healthRunning: false,
  searchResults: [],
  searchQuery: '',
  searchBusy: false,
  // Local ratings, keyed `type:id`. Kept beside state.data rather than inside
  // it: they live in their own sealed profile slot (electron/store.mjs) and
  // must keep working when Trakt is disconnected.
  ratings: {}
};

let detailsReturnFocus = null;

const client = new AddonClient(() => state.data, persistData);

// The main window is the window that actually owns the OS keyboard during
// native playback: the floating controls overlay is deliberately
// non-focusable (showInactive, see electron/controls-overlay.mjs) and mpv's
// embedded child window never takes OS focus either. So report every key
// press to the overlay from here -- the always-loaded app shell -- rather
// than from CocoaPlayer.onKey, so "keyboard interaction shows the chrome"
// (the 1c show/hide contract) holds even before/without a player instance.
// No-op while no overlay is open.
document.addEventListener('keydown', event => {
  const dialog = !document.querySelector('.player-shell') && (document.querySelector('.modal-scrim .modal') || document.querySelector('.details-card'));
  if (dialog && event.key === 'Escape') {
    event.preventDefault();
    if (dialog.classList.contains('modal')) dialog.querySelector('[data-modal-close]')?.click();
    else closeDetails();
    return;
  }
  if (dialog && event.key === 'Tab') {
    const controls = [...dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault(); first?.focus();
    }
  }
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target?.tagName)) return;
  window.cocoa?.overlay?.activity?.(event.key);
});

boot().catch(error => {
  console.error(error);
  window.__cocoaReady?.();
  root.innerHTML = `<div class="empty-state"><div><strong>CocoaStream could not start</strong>${escapeHtml(error.message)}</div></div>`;
});

async function boot() {
  // Every launch starts at the top of Home (Sam, Oct 29): never let Chromium
  // put back the scroll position from the last session.
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);
  if (!window.cocoa?.auth?.session) {
    throw new Error('The CocoaStream desktop bridge did not load. Restart CocoaStream. If this persists, reapply the latest CocoaStream update files.');
  }
  state.session = await window.cocoa.auth.session();
  if (!state.session) {
    renderAuth(await window.cocoa.auth.hasAccounts() ? 'login' : 'register');
    return;
  }
  await enterApp();
}

async function enterApp() {
  state.data = await window.cocoa.data.get();
  await loadRatings();
  applyPreferences();
  try {
    const cached = JSON.parse(localStorage.getItem('cocoa.home.v1.' + state.session.username) || 'null');
    if (Array.isArray(cached?.rows)) { state.rows = cached.rows; state.hero = cached.hero || null; }
  } catch {}
  renderShell();
  navigate('home');
  if (state.rows.length) loadHome(true);
  checkConfiguredUpdates();
}

// Ratings are read through their own bridge call, never through state.data:
// they are stored in a separate sealed profile slot and must remain usable
// when Trakt is disconnected (which is the whole point of a local rating).
async function loadRatings() {
  try {
    state.ratings = (await window.cocoa.ratings.list()) || {};
  } catch {
    // A missing/unavailable rating store must never block the app from
    // starting; an empty set simply means "nothing rated yet".
    state.ratings = {};
  }
  return state.ratings;
}

function ratingFor(item) {
  return Number(state.ratings?.[canonicalKey(item)]?.rating) || 0;
}

// `rating` of 0 clears. The local rating is written first and is the source of
// truth; the Trakt mirror (when connected) happens main-side and its failure
// is reported without discarding the local rating.
async function setRating(item, rating) {
  const key = canonicalKey(item);
  const entry = rating
    ? {
        rating,
        ratedAt: new Date().toISOString(),
        title: item.name || '',
        poster: posterFor(item) || '',
        type: isSeriesLike(item) ? 'series' : 'movie',
        year: safeYear(item) || ''
      }
    : null;
  const result = await window.cocoa.ratings.set(key, entry);
  if (result?.ok === false) {
    toast(result.reason === 'unavailable' ? 'Ratings are unavailable right now' : 'Could not save that rating');
    return;
  }
  syncTrakt(() => rating ? window.cocoa.trakt.rate(item, rating) : window.cocoa.trakt.unrate(item));
  await loadRatings();
  if (state.details) renderDetails(state.details, false);
  if (state.route === 'list') renderMyList();
  toast(rating ? `Rated ${rating}/10` : 'Rating cleared');
}

function applyPreferences() {
  // The Appearance page is gone (Sam, Oct 29): one fixed look for everyone.
  document.documentElement.style.setProperty('--ui-scale', '1');
  document.body.classList.toggle('animations', true);
  document.body.classList.toggle('no-blur', false);
}

async function persistData() {
  if (!state.data) return;
  state.data = await window.cocoa.data.save(state.data);
  applyPreferences();
  return state.data;
}

function renderAuth(mode = 'login') {
  window.__cocoaReady?.();
  const isRegister = mode === 'register';
  root.innerHTML = `
    <div class="auth-shell">
      <section class="auth-panel">
        <div class="auth-brand">${APP_ICON}<span>${APP_NAME}</span></div>
        <div class="auth-eyebrow">YOUR OWN LITTLE CINEMA</div>
        <h1 class="auth-title">${isRegister ? 'Your next<br>favorite awaits.' : 'Welcome<br>back.'}</h1>
        <p class="auth-sub">${isRegister ? 'Create your private CocoaStream profile on this device.' : 'Sign in to your CocoaStream profile on this device.'}</p>
        <form class="auth-form" id="auth-form">
          <div class="field"><label for="auth-username">Username</label><input id="auth-username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Choose a username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" aria-describedby="username-hint" />${isRegister ? '<small id="username-hint" class="muted">3–24 letters, numbers, or underscores.</small>' : '<small id="username-hint" class="muted">Your profile is saved on this device.</small>'}</div>
          <div class="field"><label for="auth-password">Password</label><input id="auth-password" name="password" type="password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="At least 8 characters" required minlength="8" maxlength="256" /></div>
          <button class="auth-submit" type="submit">${isRegister ? 'Create account' : 'Log in'} <span aria-hidden="true">→</span></button>
          <div class="auth-switch"><span>${isRegister ? 'Already have a profile?' : `New to ${APP_NAME}?`}</span><button type="button" class="auth-toggle" id="auth-switch">${isRegister ? 'Log in' : 'Create account'}</button></div>
        </form>
      </section>
    </div>`;

  $('#auth-switch').onclick = () => renderAuth(isRegister ? 'login' : 'register');
  $('#auth-form').onsubmit = async event => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = isRegister ? 'Creating…' : 'Logging in…';
    try {
      state.session = isRegister
        ? await window.cocoa.auth.register(form.get('username'), form.get('password'))
        : await window.cocoa.auth.login(form.get('username'), form.get('password'));
      await enterApp();
    } catch (error) {
      toast(error.message, 'error');
      button.disabled = false;
      button.textContent = isRegister ? 'Create account' : 'Log in';
    }
  };
}


function profileDisplayName() {
  return String(state.data?.profile?.username || state.session?.username || 'Profile').trim() || 'Profile';
}

function profileAvatarHtml(size = '') {
  const dataUrl = state.data?.profile?.avatarDataUrl || '';
  const cls = size === 'large' ? 'avatar avatar-large' : 'avatar';
  if (dataUrl) return `<span class="${cls}"><img src="${escapeHtml(dataUrl)}" alt="" /></span>`;
  const initial = profileDisplayName().charAt(0).toUpperCase() || 'C';
  return `<span class="${cls}">${escapeHtml(initial)}</span>`;
}

async function imageFileToAvatarDataUrl(file) {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 12 * 1024 * 1024) throw new Error('Choose an image smaller than 12 MB.');
  const bitmap = await createImageBitmap(file);
  const size = 256;
  const scale = Math.max(size / bitmap.width, size / bitmap.height);
  const sw = size / scale, sh = size / scale;
  const sx = Math.max(0, (bitmap.width - sw) / 2), sy = Math.max(0, (bitmap.height - sh) / 2);
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, size, size);
  bitmap.close?.();
  return canvas.toDataURL('image/jpeg', 0.86);
}

function renderShell() {
  window.__cocoaReady?.();
  root.innerHTML = `
    <div class="app-shell">
      <header class="topbar" id="topbar">
        <button class="brand" id="brand-home" style="background:none;border:0;color:inherit;cursor:pointer;padding:0">${APP_ICON}<span>${APP_NAME}</span></button>
        <nav class="nav">
          <button data-route="home">Home</button>
          <button data-route="search">Search</button>
          <button data-route="list">My List</button>
          <button data-route="settings">Settings</button>
        </nav>
        <div class="spacer"></div>
        <button class="profile-button" id="profile-button">${profileAvatarHtml()}<span class="small">${escapeHtml(profileDisplayName())}</span><span class="dim">⌄</span></button>
      </header>
      <main id="page"></main>
    </div>`;

  if (document.body.classList.contains('tv')) $('.nav button')?.focus({ preventScroll: true });
  $('#brand-home').onclick = () => navigate('home');
  $$('.nav button').forEach(button => button.onclick = () => navigate(button.dataset.route));
  $('#profile-button').onclick = event => { event.stopPropagation(); toggleProfileMenu(); };
  document.addEventListener('click', closeProfileMenu);
  window.addEventListener('scroll', onScroll, { passive: true });
}

function onScroll() {
  $('#topbar')?.classList.toggle('scrolled', window.scrollY > 28);
}

function navigate(route) {
  closeDetails();
  closeProfileMenu();
  if (state.route === 'search' && route !== 'search') { searchGeneration++; state.searchBusy = false; }
  state.route = route;
  $$('.nav button').forEach(button => button.classList.toggle('active', button.dataset.route === route));
  window.scrollTo(0, 0);
  if (route === 'home') renderHome();
  if (route === 'search') renderSearch();
  if (route === 'list') renderMyList();
  if (route === 'settings') renderSettings();
}

function toggleProfileMenu() {
  const existing = $('.profile-menu');
  if (existing) return existing.remove();
  const menu = document.createElement('div');
  menu.className = 'profile-menu';
  menu.innerHTML = `
    <div class="menu-email"><strong>${escapeHtml(profileDisplayName())}</strong><br>${escapeHtml(state.session.username)}</div>
    <button data-profile-settings>Settings</button>
    <button data-profile-logout>Log out</button>`;
  document.body.appendChild(menu);
  menu.onclick = event => event.stopPropagation();
  $('[data-profile-settings]', menu).onclick = () => { menu.remove(); navigate('settings'); };
  $('[data-profile-logout]', menu).onclick = logout;
}

function closeProfileMenu() { $('.profile-menu')?.remove(); }

async function logout() {
  closeDetails();
  closeProfileMenu();
  state.player?.close?.();
  await window.cocoa.auth.logout();
  state.session = null;
  state.data = null;
  state.rows = [];
  state.hero = null;
  state.mediaIndex.clear();
  renderAuth('login');
}

/* HOME */
function renderHome() {
  const page = $('#page');
  if (!page) return;
  const wasAtTop = window.scrollY === 0;
  if (!state.rows.length) {
    page.innerHTML = `
      <div class="page">
        <div style="padding-top:18vh;text-align:center;color:var(--muted)"><span class="spinner"></span>Growing your library…</div>
      </div>`;
    if (!state.homeLoading && !state.homeAttempted) loadHome();
    else if (!state.homeLoading) {
      page.innerHTML = '<div class="empty-state"><div><strong>Your library is taking a little longer</strong><p>Check your connection, then try again.</p><button class="solid-btn" id="retry-home">Try again</button></div></div>';
      $('#retry-home').onclick = () => loadHome(true);
    }
    return;
  }

  state.mediaIndex.clear();
  const heroPool = [state.hero, ...state.rows.flatMap(row => row.items)].filter(item => item && !isSeriesLike(item));
  const hero = heroPool[0] || null;
  registerItems(state.rows.flatMap(row => row.items));
  if (hero) registerItems([hero]);

  const continueEntries = continueWatching(state.data.history);
  const recentEntries = latestPerMedia(state.data.history).slice(0, 18);
  const continueItems = continueEntries.map(entry => ({ ...entry.item, _historyEntry: entry }));
  const recentItems = recentEntries.map(entry => ({ ...entry.item, _historyEntry: entry }));
  registerItems([...continueItems, ...recentItems]);

  const catalogPool = state.rows.flatMap(row => row.items);
  const watchedKeys = new Set(recentEntries.map(entry => canonicalKey(entry.item)));
  const recommended = catalogPool
    .filter(item => !watchedKeys.has(canonicalKey(item)))
    .map(item => ({ item, score: recommendationScore(item, state.data.history) }))
    .sort((a, b) => b.score - a.score)
    .filter((x, i) => x.score > 0 || i < 16)
    .map(x => x.item)
    .filter(uniqueByKey)
    .slice(0, 18);
  registerItems(recommended);

  page.innerHTML = `
    <div class="page no-top-pad">
      ${hero ? heroHtml(hero) : ''}
      <div class="rows">
        ${continueItems.length ? rowHtml('Continue Watching', continueItems, 'On this device') : ''}
        ${recentItems.length ? rowHtml('Recently Played', recentItems, '') : ''}
        ${state.data.history.length && recommended.length ? rowHtml('Recommended For You', recommended, 'Based on your library') : ''}
        ${state.rows.map(row => rowHtml(row.name, row.items, row.addonName)).join('')}
      </div>
    </div>`;
  // Keep late Spotlight insertion from anchoring the viewport to the rows below.
  if (wasAtTop) window.scrollTo(0, 0);
  wireMediaClicks(page);
  wireImageFallbacks(page);
  $('[data-hero-details]', page)?.addEventListener('click', () => openDetails(hero));
  $('[data-hero-play]', page)?.addEventListener('click', () => playPrimary(hero));
}

async function loadHome(force = false) {
  if (state.homeLoading) return;
  if (state.rows.length && !force) return;
  state.homeLoading = true;
  state.homeAttempted = true;
  try {
    const rows = await client.homeRows(rows => {
      if (!state.rows.length) {
        state.rows = rows;
        state.hero = rows.flatMap(row => row.items).find(item => !isSeriesLike(item)) || null;
        if (state.route === 'home') renderHome();
      }
    });
    if (!rows.length && state.rows.length) return;
    state.rows = rows;
    state.hero = rows.flatMap(row => row.items).find(item => !isSeriesLike(item)) || rows[0]?.items?.[0] || null;
    try { localStorage.setItem('cocoa.home.v1.' + state.session.username, JSON.stringify({ rows, hero: state.hero })); } catch {}
  } catch (error) {
    toast(`Catalog problem: ${error.message}`, 'error');
  } finally {
    state.homeLoading = false;
    if (state.route === 'home') renderHome();
  }
}

function heroHtml(item) {
  const background = item.background || item.poster || '';
  const metaBits = [safeYear(item), item.imdbRating ? `★ ${item.imdbRating}` : '', item.runtime].filter(Boolean);
  return `
    <section class="hero">
      ${background ? `<img class="hero-bg" src="${escapeHtml(background)}" data-primary-src="${escapeHtml(background)}" data-fallback-src="${escapeHtml(item.poster || '')}" alt="" loading="eager" />` : ''}
      <div class="hero-shade" aria-hidden="true"></div>
      <div class="hero-content">
        <div class="hero-kicker">Spotlight</div>
        <h1>${escapeHtml(item.name)}</h1>
        <div class="hero-meta">${metaBits.map(x => `<span>${escapeHtml(x)}</span>`).join('<span class="dim">•</span>')}</div>
        ${item.description ? `<div class="hero-desc">${escapeHtml(item.description)}</div>` : ''}
        <div class="hero-actions">
          <button class="solid-btn" data-hero-play>▶ Play</button>
          <button class="ghost-btn" data-hero-details>More info</button>
        </div>
      </div>
    </section>`;
}

function rowHtml(title, items, source = '') {
  const visible = items.filter(Boolean).slice(0, 24);
  visible.forEach(item => state.mediaIndex.set(canonicalKey(item), item));
  return `
    <section class="media-row">
      <div class="row-head"><h2>${escapeHtml(title)}</h2>${source ? `<span class="source-label">${escapeHtml(source)}</span>` : ''}</div>
      <div class="card-strip">${visible.map(cardHtml).join('')}</div>
    </section>`;
}

function cardHtml(item) {
  const key = canonicalKey(item);
  const poster = posterFor(item);
  const progress = item._historyEntry?.duration
    ? Math.min(100, (item._historyEntry.position / item._historyEntry.duration) * 100)
    : mediaProgress(item, state.data.history);
  const posterFallback = item.background && item.background !== poster ? item.background : '';
  return `
    <article class="media-card" role="button" tabindex="0" data-media="${escapeHtml(key)}" title="${escapeHtml(item.name)}">
      ${poster ? `<img src="${escapeHtml(poster)}" data-primary-src="${escapeHtml(poster)}" data-fallback-src="${escapeHtml(posterFallback)}" data-media-key="${escapeHtml(key)}" loading="lazy" alt="" /><div class="card-fallback image-fallback hidden">${escapeHtml(item.name)}</div>` : `<div class="card-fallback image-fallback">${escapeHtml(item.name)}</div>`}
      <div class="card-shade"></div>
      <div class="card-title">${escapeHtml(item.name)}</div>
      ${item.type ? `<span class="card-badge">${escapeHtml(mediaTypeLabel(item))}</span>` : ''}
      ${Number(item._rating) ? `<span class="card-rating">${Number(item._rating)}/10</span>` : ''}
      ${progress > 1 && progress < 99 ? `<div class="progress-line"><span style="width:${progress.toFixed(1)}%"></span></div>` : ''}
    </article>`;
}

function wireImageFallbacks(container = document) {
  $$('img[data-primary-src]', container).forEach(img => {
    if (img.dataset.fallbackWired === '1') return;
    img.dataset.fallbackWired = '1';
    const handleError = async () => {
      const fallback = img.dataset.fallbackSrc || '';
      if (img.dataset.fallbackTried !== '1' && fallback && fallback !== img.dataset.primarySrc) {
        img.dataset.fallbackTried = '1';
        img.src = fallback;
        img.classList.add('poster-fallback');
        return;
      }
      const mediaKey = img.dataset.mediaKey;
      if (mediaKey && img.dataset.metaFallbackTried !== '1') {
        img.dataset.metaFallbackTried = '1';
        const indexed = state.mediaIndex.get(mediaKey);
        if (indexed) {
          try {
            const richer = await client.meta(indexed);
            state.mediaIndex.set(mediaKey, richer);
            const candidate = richer.poster || richer.background || '';
            if (candidate && candidate !== img.dataset.primarySrc && candidate !== fallback) {
              img.classList.remove('image-hidden');
              img.src = candidate;
              img.classList.add('poster-fallback');
              return;
            }
          } catch {}
        }
      }
      img.classList.add('image-hidden');
      const fallbackEl = img.nextElementSibling;
      if (fallbackEl?.classList.contains('image-fallback')) fallbackEl.classList.remove('hidden');
    };
    img.addEventListener('error', handleError);
    if (img.complete && img.naturalWidth === 0) queueMicrotask(handleError);
  });
}

function registerItems(items = []) {
  for (const item of items) if (item?.id) state.mediaIndex.set(canonicalKey(item), item);
}

function wireMediaClicks(container) {
  container.onkeydown = event => {
    if (event.target.matches('.media-card') && ['Enter', ' '].includes(event.key)) { event.preventDefault(); event.target.click(); }
  };
  container.onclick = event => {
    const card = event.target.closest('[data-media]');
    if (!card) return;
    const item = state.mediaIndex.get(card.dataset.media);
    if (item) { card.focus({ preventScroll: true }); openDetails(item); }
  };
}

function latestPerMedia(history = []) {
  const seen = new Set();
  const output = [];
  for (const entry of recentHistory(history)) {
    if (!entry.item) continue;
    const key = canonicalKey(entry.item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(entry);
  }
  return output;
}

function uniqueByKey(item, index, arr) {
  const key = canonicalKey(item);
  return arr.findIndex(x => canonicalKey(x) === key) === index;
}

/* SEARCH */
let searchGeneration = 0;
function paintSearchResults() {
  const target = $('#search-results');
  if (!target) return;
  registerItems(state.searchResults);
  target.innerHTML = `<div class="search-status" role="status">${state.searchBusy ? '<span class="spinner"></span> Finding your next watch…' : state.searchQuery ? `${state.searchResults.length} results` : 'Movies, series, anime. Find something you love.'}</div>
    ${state.searchResults.length ? `<div class="grid">${state.searchResults.map(cardHtml).join('')}</div>` : state.searchQuery && !state.searchBusy ? '<div class="empty-state"><div><strong>No matches yet</strong><p>Try a different title.</p></div></div>' : ''}`;
  wireMediaClicks(target);
  wireImageFallbacks(target);
}
function renderSearch() {
  const page = $('#page');
  state.mediaIndex.clear();
  page.innerHTML = `<div class="page"><h1 class="page-title">Search</h1>
    <div class="search-wrap"><span class="search-icon">⌕</span><input id="search-input" class="search-box" value="${escapeHtml(state.searchQuery)}" placeholder="Movies, shows, people…" aria-label="Search movies and shows" enterkeyhint="search" /></div>
    <div id="search-results"></div></div>`;
  paintSearchResults();
  const input = $('#search-input');
  const run = debounce(async (query, generation) => {
    if (generation !== searchGeneration) return;
    if (!query) { state.searchResults = []; state.searchBusy = false; paintSearchResults(); return; }
    state.searchBusy = true; paintSearchResults();
    const current = () => generation === searchGeneration && state.route === 'search';
    try {
      const results = await client.search(query, partial => {
        if (current()) { state.searchResults = partial; paintSearchResults(); }
      });
      if (!current()) return;
      state.searchResults = results;
      state.data.lastSearches = [query, ...(state.data.lastSearches || []).filter(x => x !== query)].slice(0, 10);
      persistData().catch(() => {});
    } catch (error) { if (current()) { toast(error.message, 'error'); state.searchResults = []; } }
    finally { if (current()) { state.searchBusy = false; paintSearchResults(); } }
  }, 250);
  input.addEventListener('input', event => {
    state.searchQuery = event.target.value.trim();
    const generation = ++searchGeneration;
    run(state.searchQuery, generation);
  });
}

/* MY LIST */
function renderMyList() {
  const page = $('#page');
  state.mediaIndex.clear();
  const saved = state.data.myList || [];
  registerItems(saved);
  const rated = ratedItems(state.ratings);
  const collectionSize = new Set([...saved, ...rated].map(canonicalKey)).size;
  // Rated titles are registered too so their cards open the same details page
  // as any other card (registerItems + wireMediaClicks are the only path).
  registerItems(rated);
  const section = (title, items, icon, heading, copy) => `
    <section class="library-section" aria-label="${title}">
      <header class="library-section-head"><h2>${title}</h2><span class="library-count" aria-label="${items.length} titles">${items.length}</span></header>
      ${items.length ? `<div class="grid">${items.map(cardHtml).join('')}</div>` : `
        <div class="library-empty"><span class="library-empty-icon" aria-hidden="true">${icon}</span><h3>${heading}</h3><p>${copy}</p><button class="ghost-btn" data-library-browse>Browse titles <span aria-hidden="true">→</span></button></div>`}
    </section>`;
  page.innerHTML = `
    <div class="page library-page">
      <div class="library-intro library-hero"><div><span class="library-eyebrow">YOUR COCOASTREAM</span><h1 class="page-title">My List</h1><p>Your saved titles and personal ratings, all in one place.</p></div><div class="library-total"><strong>${collectionSize}</strong><span>in your collection</span></div></div>
      ${section('Saved', saved, '+', 'Make room for your favorites', 'Save a movie or show from its details to find it here.')}
      ${section('Rated', rated, '☆', 'Your taste, all in one place', 'Rate a movie or show to start your personal collection.')}
    </div>`;
  $$('[data-library-browse]', page).forEach(button => button.onclick = () => navigate('home'));
  wireMediaClicks(page);
  wireImageFallbacks(page);
}


function isSeriesLike(item) {
  return ['series', 'anime'].includes(String(item?.type || '').toLowerCase());
}

function mediaTypeLabel(item) {
  const type = String(item?.type || '').toLowerCase();
  if (type === 'series') return 'SERIES';
  if (type === 'anime') return 'ANIME';
  if (type === 'sport') return 'SPORT';
  return 'MOVIE';
}

function mediaTypeTitle(item) {
  const label = mediaTypeLabel(item);
  return label.charAt(0) + label.slice(1).toLowerCase();
}

function brandSafeText(value = '') {
  return String(value || '').replace(/stremio/gi, 'CocoaStream');
}

/* DETAILS */
async function openDetails(input) {
  const item = cleanMeta(input);
  if (!state.details) detailsReturnFocus = document.activeElement;
  state.details = item;
  renderDetails(item, true);
  try {
    const detailed = await client.meta(item);
    if (!state.details || canonicalKey(state.details) !== canonicalKey(item)) return;
    state.details = detailed;
    renderDetails(detailed, false);
  } catch {}
}


// A 1..10 rating row, deliberately the same integer scale Trakt uses so a
// local rating and a Trakt rating are the same number. Clicking the current
// rating again clears it (the only way to express "unrated").
function ratingRowHtml(item) {
  const current = ratingFor(item);
  const stars = Array.from({ length: 10 }, (_, index) => {
    const value = index + 1;
    const on = value <= current;
    return `<button class="rating-star${on ? ' on' : ''}" data-rate="${value}"
      aria-label="Rate ${value} out of 10" aria-pressed="${on}" title="${value}/10">${value}</button>`;
  }).join('');
  return `
    <div class="rating-row" data-role="rating-row">
      <span class="rating-label">Your rating</span>
      <div class="rating-stars" role="group" aria-label="Your rating">${stars}</div>
      <span class="rating-value">${current ? `${current}/10` : 'Not rated'}</span>
      ${current ? '<button class="rating-clear" data-rate-clear>Clear</button>' : ''}
    </div>`;
}

function renderDetails(item, loading = false) {
  const previous = $('.details-overlay');
  const active = previous?.contains(document.activeElement) ? document.activeElement : null;
  const focusDialog = !previous || Boolean(active);
  const focusAttribute = ['data-detail-close', 'data-detail-play', 'data-list-toggle', 'data-rate', 'data-rate-clear'].find(name => active?.hasAttribute(name));
  const focusSelector = focusAttribute ? `[${focusAttribute}="${CSS.escape(active.getAttribute(focusAttribute))}"]` : '[data-detail-close]';
  previous?.remove();
  document.body.classList.add('details-open');
  if ($('#app')) $('#app').inert = true;
  const overlay = document.createElement('div');
  overlay.className = 'details-overlay';
  const isSaved = state.data.myList.some(x => canonicalKey(x) === canonicalKey(item));
  const videos = normalizedVideos(item);
  const seriesLike = isSeriesLike(item);
  // Specials (season 0) go last: a show should open on Season 1, not on extras.
  const seasons = [...new Set(videos.map(v => Number(v.season ?? v.seasonNumber ?? 1)))].sort((a, b) => (a === 0) - (b === 0) || a - b);
  const resume = findResumeFor(item, state.data.history);
  const metaBits = [safeYear(item), item.imdbRating ? `★ ${item.imdbRating}` : '', item.runtime].filter(Boolean);
  // Packet B: cast/crew from the meta the app ALREADY fetches (Cinemeta is the
  // bundled core add-on). Rendered only when genuinely present, so a title
  // with no credits shows nothing rather than empty "Cast:" scaffolding.
  const cast = peopleList(item.cast, 12);
  const directors = peopleList(item.director, 6);
  const writers = peopleList(item.writer, 6).filter(name => !directors.includes(name));
  const creditBlock = (label, names) => names.length
    ? `<div class="credit-row"><span class="credit-label">${label}</span><span class="credit-names">${names.map(n => `<span class="credit-name">${escapeHtml(n)}</span>`).join('')}</span></div>`
    : '';
  const credits = `${creditBlock('Cast', cast)}${creditBlock('Directed by', directors)}${creditBlock('Written by', writers)}`;
  const facts = [
    item.country ? `Country: ${item.country}` : '',
    item.awards || ''
  ].filter(Boolean);

  overlay.innerHTML = `
    <div class="details-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(item.name)}">
      <button class="icon-btn details-close" aria-label="Close title details" data-detail-close>×</button>
      <section class="details-hero">
        <div class="details-bg" style="${item.background || item.poster ? `background-image:url('${cssUrl(item.background || item.poster)}')` : ''}"></div>
        <div class="details-content">
          <div class="hero-kicker">${escapeHtml(mediaTypeTitle(item))}${loading ? ' • Loading details…' : ''}</div>
          <h1>${escapeHtml(item.name)}</h1>
          <div class="hero-meta">${metaBits.map(x => `<span>${escapeHtml(x)}</span>`).join('<span class="dim">•</span>')}</div>
          ${item.description ? `<div class="hero-desc">${escapeHtml(item.description)}</div>` : ''}
          <div class="genre-list">${(item.genres || []).slice(0, 8).map(g => `<span class="genre-chip">${escapeHtml(g)}</span>`).join('')}</div>
          <div class="hero-actions">
            <button class="solid-btn" data-detail-play>${resume?.position > 30 ? '▶ Resume' : '▶ Play'}</button>
            <button class="ghost-btn" data-list-toggle>${isSaved ? '✓ In My List' : '+ My List'}</button>
          </div>
          ${ratingRowHtml(item)}
        </div>
      </section>
      <div class="details-body">
        ${credits || facts.length ? `
          <section class="details-crew">
            ${credits}
            ${facts.length ? `<div class="details-facts">${facts.map(f => `<span>${escapeHtml(f)}</span>`).join('')}</div>` : ''}
          </section>` : ''}
        ${seriesLike && videos.length ? `
          <div class="episode-toolbar"><h2>Episodes</h2><select id="season-select">${seasons.map(s => `<option value="${s}">${s === 0 ? 'Specials' : `Season ${s}`}</option>`).join('')}</select></div>
          <div class="episodes" id="episodes"></div>` : ''}
        ${seriesLike && !videos.length && !loading ? `<div class="empty-state"><div><strong>No episode metadata</strong>Your metadata add-on did not return episodes for this title.</div></div>` : ''}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  wireImageFallbacks(overlay);

  $('[data-detail-close]', overlay).onclick = closeDetails;
  overlay.addEventListener('click', event => { if (event.target === overlay) closeDetails(); });
  if (focusDialog) ($(focusSelector, overlay) || $('[data-detail-close]', overlay)).focus({ preventScroll: true });
  $('[data-list-toggle]', overlay).onclick = () => toggleMyList(item);
  $('[data-detail-play]', overlay).onclick = () => playPrimary(item);

  // Rating controls. A click on the already-active rating clears it, so the
  // same button both sets and unsets without a separate modal.
  const ratingRow = $('[data-role="rating-row"]', overlay);
  ratingRow?.addEventListener('click', event => {
    const star = event.target.closest('[data-rate]');
    if (star) {
      const value = Number(star.dataset.rate);
      setRating(item, value === ratingFor(item) ? 0 : value);
      return;
    }
    if (event.target.closest('[data-rate-clear]')) setRating(item, 0);
  });

  if (seriesLike && videos.length) {
    const resumeVideo = resume?.videoId ? videos.find(v => videoIdOf(v, item) === resume.videoId) : null;
    const initialSeason = Number(resumeVideo?.season ?? resumeVideo?.seasonNumber ?? seasons[0]);
    $('#season-select', overlay).value = String(initialSeason);
    renderEpisodes(item, initialSeason, overlay);
    $('#season-select', overlay).onchange = event => renderEpisodes(item, Number(event.target.value), overlay);
  }
}

function renderEpisodes(item, season, overlay) {
  const holder = $('#episodes', overlay);
  const videos = normalizedVideos(item).filter(v => Number(v.season ?? v.seasonNumber ?? 1) === Number(season));
  holder.innerHTML = videos.map((video, idx) => {
    const resume = findResumeFor(item, state.data.history, videoIdOf(video, item));
    const progress = resume?.duration ? Math.min(100, (resume.position / resume.duration) * 100) : 0;
    const primaryImage = video.thumbnail || item.poster || item.background || '';
    const fallbackImage = video.thumbnail ? (item.poster || item.background || '') : (item.background && item.background !== item.poster ? item.background : '');
    const imageHtml = primaryImage
      ? `<img class="episode-thumb ${video.thumbnail ? '' : 'poster-fallback'}" src="${escapeHtml(primaryImage)}" data-primary-src="${escapeHtml(primaryImage)}" data-fallback-src="${escapeHtml(fallbackImage)}" alt="" /><div class="episode-thumb image-fallback hidden">${escapeHtml(item.name)}</div>`
      : `<div class="episode-thumb image-fallback">${escapeHtml(item.name)}</div>`;
    return `
      <article class="episode" data-episode-index="${idx}">
        <div class="episode-num">${escapeHtml(String(video.episode ?? video.episodeNumber ?? idx + 1))}</div>
        ${imageHtml}
        <div><div class="episode-title">${escapeHtml(video.name || video.title || episodeLabel(video))}</div>${video.overview || video.description ? `<div class="episode-desc">${escapeHtml(video.overview || video.description)}</div>` : ''}${progress > 1 && progress < 99 ? `<div class="progress-line" style="position:relative;left:0;right:auto;bottom:auto;width:170px;margin-top:8px"><span style="width:${progress}%"></span></div>` : ''}</div>
        <button class="pill-btn">${resume?.position > 30 && progress < 94 ? 'Resume' : 'Play'}</button>
      </article>`;
  }).join('');
  wireImageFallbacks(holder);
  $$('.episode', holder).forEach((el, idx) => el.onclick = () => chooseSource(item, videos[idx]));
}

function normalizedVideos(item) {
  return [...(item.videos || [])].sort((a, b) => {
    const sa = Number(a.season ?? a.seasonNumber ?? 1), sb = Number(b.season ?? b.seasonNumber ?? 1);
    if (sa !== sb) return sa - sb;
    return Number(a.episode ?? a.episodeNumber ?? 0) - Number(b.episode ?? b.episodeNumber ?? 0);
  });
}

function closeDetails() {
  const key = state.details && canonicalKey(state.details);
  state.details = null;
  $('.details-overlay')?.remove();
  document.body.classList.remove('details-open');
  if ($('#app')) $('#app').inert = false;
  const returnFocus = detailsReturnFocus?.isConnected ? detailsReturnFocus : key && $(`[data-media="${CSS.escape(key)}"]`);
  returnFocus?.focus({ preventScroll: true });
  detailsReturnFocus = null;
}

async function toggleMyList(item) {
  const key = canonicalKey(item);
  const index = state.data.myList.findIndex(x => canonicalKey(x) === key);
  if (index >= 0) {
    state.data.myList.splice(index, 1);
    toast('Removed from My List');
  } else {
    state.data.myList.unshift(cleanMeta(item));
    toast('Added to My List');
  }
  await persistData();
  syncTrakt(() => window.cocoa.trakt.watchlist(item, state.data.myList.some(x => canonicalKey(x) === canonicalKey(item))));
  if (state.details) renderDetails(state.details, false);
  if (state.route === 'list') renderMyList();
}

async function playPrimary(item) {
  if (!isSeriesLike(item)) return chooseSource(item, null);
  let videos = normalizedVideos(item);
  if (!videos.length) {
    // The details card renders instantly with whatever summary data the
    // catalog/search result carried, then re-renders once the full
    // metadata (including the episode list) arrives -- clicking Play in
    // that gap used to fall through to requesting streams for the bare
    // show id, which no stream add-on can resolve ("no sources"), even
    // though the real episode list was only a moment away. Wait for the
    // full fetch instead of giving up immediately.
    toast('Cocoa is fetching episodes…');
    try {
      const detailed = await client.meta(item);
      if (!state.details || canonicalKey(state.details) !== canonicalKey(item)) return;
      state.details = detailed;
      videos = normalizedVideos(detailed);
      item = detailed;
    } catch {}
    if (!state.details || canonicalKey(state.details) !== canonicalKey(item)) return;
  }
  if (!videos.length) return chooseSource(item, null);
  const resume = findResumeFor(item, state.data.history);
  const target = resume?.videoId ? videos.find(v => videoIdOf(v, item) === resume.videoId) : null;
  chooseSource(item, target || videos[0]);
}

/* SOURCES + PLAYBACK */
// Automatic failover for a chosen (possibly grouped) source: try this
// group's own other original candidates first -- e.g. a different add-on's
// copy of the identical infoHash, still its own real, unmodified Stream
// Object (see groupDuplicateStreams in lib.js) -- before moving on to a
// different ranked source entirely. Bounded, same as before.
function fallbacksFor(streams, index) {
  return failoverCandidates({ streams, index });
}

// Single shared entry point for source discovery + ranking. Both the details
// page modal (chooseSource) and the in-player Sources popover use this, so the
// two surfaces can never drift apart in ordering or filtering.
// Reuse only source lists the user explicitly requested during this session.
const RANKED_CACHE_MS = 10 * 60 * 1000;
const rankedCache = new Map();
function rankedCacheKey(item, video) {
  // Same key the player asks with: a movie resolves to the title id, an
  // episode to the episode id, so the details-page list and the Play click
  // always address the same cache slot.
  return `${canonicalKey(item)}::${videoIdOf(video, item)}`;
}
function pruneRankedCache(now = Date.now()) {
  for (const [key, entry] of [...rankedCache]) if (now - entry.at > RANKED_CACHE_MS) rankedCache.delete(key);
}

async function fetchRankedStreams(item, video, { fresh = false } = {}) {
  const videoId = videoIdOf(video, item);
  const key = rankedCacheKey(item, video);
  if (!fresh) {
    const hit = rankedCache.get(key);
    if (hit && Date.now() - hit.at <= RANKED_CACHE_MS) return { streams: hit.streams, ranked: hit.ranked, cached: true };
  }
  const returnedStreams = await client.streams(item, videoId);
  const ranked = rankStreams(returnedStreams, state.data.sourceStats || {}, {
    hideCamera: state.data.preferences.hideCamSources !== false
  });
  pruneRankedCache();
  rankedCache.set(key, { at: Date.now(), streams: ranked.streams, ranked });
  return { streams: ranked.streams, ranked };
}

// Ranked list for the currently-playing item, kept in sync with whatever
// chooseSource() last produced. The in-player popover reads this.
let activeSourceList = [];
let activeSourceIndex = -1;
let activeSourceKey = '';

// Compact rows for the overlay popover. Deliberately small: the overlay
// renders them in a 240-330px menu, and it must never re-implement ranking.
function overlaySourceSummaries(streams = activeSourceList) {
  return streams.map((stream, index) => {
    const info = stream._cocoa || {};
    return {
      id: index,
      label: brandSafeText(sourceLabel(stream)),
      quality: info.quality || '',
      size: info.sizeBytes ? formatBytes(info.sizeBytes) : '',
      best: index === 0
    };
  });
}

function activeSourceIndexOf(stream) {
  // Identity match, not deep equality -- the list holds the same objects we
  // just handed to the player.
  return stream ? activeSourceList.indexOf(stream) : -1;
}

// Switch the in-flight stream without leaving the player: save progress,
// relaunch with the chosen stream, and keep the remaining ranked sources as
// fallbacks. This is the in-player replacement for the old behaviour, where
// "Sources" tore the player down and navigated home (Sam's real-app report).
async function switchPlayerSource(item, video, stream, index = -1) {
  if (!stream) return;
  const current=state.player;
  await current?.saveProgress?.(true).catch?.(() => {});
  activeSourceIndex = index;
  if(current?.nativeMode) {
    current.options.onTryNextSource=fallbacksFor(activeSourceList,index<0?0:index).length
      ? () => tryNextRankedSource(item,video,fallbacksFor(activeSourceList,index<0?0:index),current.options.failureHistory||[])
      : null;
    try {
      await current.replaceNativeSource(stream);
      toast(`Switching source: ${brandSafeText(sourceLabel(stream))}`);
      const videoId=videoIdOf(video,item);
      subtitlesFor(item,videoId,stream).then(subtitles=>{
        if(state.player===current&&!current.destroyed)current.setSubtitles(subtitles);
      }).catch(()=>{if(state.player===current&&!current.destroyed)current.setSubtitles([]);});
    } catch(error) {
      toast(error?.message||'Could not switch sources.','error');
    }
    return;
  }
  toast(`Switching source: ${brandSafeText(sourceLabel(stream))}`);
  const player = await launchPlayer(item, video, stream, null, fallbacksFor(activeSourceList, index < 0 ? 0 : index));
  const videoId = videoIdOf(video, item);
  subtitlesFor(item, videoId, stream).then(subtitles => {
    if (state.player === player && !player.destroyed) player.setSubtitles(subtitles);
  }).catch(() => { if (state.player === player && !player.destroyed) player.setSubtitles([]); });
}

async function chooseSource(item, video, { showPicker = false } = {}) {
  $('.modal-scrim')?.remove();
  let discovered = null;
  if (!showPicker && state.data.preferences.showSourcePicker !== true) {
    // Something on screen the instant Play is pressed; the player's own
    // loading screen takes over as soon as a source is picked.
    const finding = document.createElement('div');
    finding.className = 'modal-scrim';
    finding.innerHTML = `<div class="modal" role="status"><div class="modal-body"><div class="loading-row"><span class="spinner"></span>Cocoa is sniffing out sources…</div></div></div>`;
    document.body.appendChild(finding);
    try {
      discovered = await fetchRankedStreams(item, video).finally(() => { finding.remove(); });
      activeSourceList = discovered.streams;
      activeSourceKey = rankedCacheKey(item,video);
      if (discovered.streams.length) {
        activeSourceIndex = 0;
        return preparePlayback(item, video, discovered.streams[0], null, fallbacksFor(discovered.streams, 0));
      }
    } catch (error) {
      toast(`Could not load sources: ${error.message}`, 'error');
      return;
    }
  }
  const modal = document.createElement('div');
  modal.className = 'modal-scrim';
  modal.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Choose a source">
      <div class="modal-head"><h2>${escapeHtml(video ? episodeLabel(video) : item.name)}</h2><div class="spacer"></div><button class="icon-btn" data-modal-close>×</button></div>
      <div class="modal-body"><div class="loading-row"><span class="spinner"></span>Cocoa is sniffing out sources…</div></div>
    </div>`;
  document.body.appendChild(modal);
  const closeSources = () => { modal.remove(); $('[data-detail-play]')?.focus({ preventScroll: true }); };
  $('[data-modal-close]', modal).onclick = closeSources;
  $('[data-modal-close]', modal).focus({ preventScroll: true });
  modal.addEventListener('click', event => { if (event.target === modal) closeSources(); });

  try {
    const { streams, ranked } = discovered || await fetchRankedStreams(item, video);
    // Remember the ranked list so the in-player Sources popover can show the
    // SAME list without re-implementing discovery (see overlaySourceSummaries).
    activeSourceList = streams;
    activeSourceKey = rankedCacheKey(item,video);
    if (!modal.isConnected) return;
    const body = $('.modal-body', modal);
    // The dead-stream check: a non-empty list is not the same as a playable
    // list. Measured Oct 28: addon.peerflix.mov returns hundreds of candidates
    // and has never played one, and torrentsdb 502s on every request -- so a
    // title can come back with 200 rows and zero sources worth pressing.
    const verdict = sourceVerdict(streams);
    if (!verdict.ok) {
      console.warn(`dead-stream check: ${verdict.total} candidates, 0 playable (${verdict.reason})`);
      const hiddenBits = [];
      if (ranked.hiddenCameraCount) hiddenBits.push(`${ranked.hiddenCameraCount} camera-recorded source${ranked.hiddenCameraCount === 1 ? '' : 's'} hidden.`);
      let hiddenMessage = hiddenBits.length
        ? hiddenBits.join(' ')
        : 'Add a compatible stream add-on in Settings, or check its health indicator.';
      if (verdict.total) hiddenMessage = `Every add-on answered, but none of the ${verdict.total} candidates can deliver data (${verdict.reason}). ${hiddenMessage}`;
      if (client.lastStreamErrors?.length) {
        const failures = client.lastStreamErrors.slice(0, 4).map(x => `${x.addonName}: ${x.message}`).join(' • ');
        hiddenMessage += ` Add-on errors: ${failures}`;
      }
      body.innerHTML = `
        <div class="empty-state" style="min-height:220px"><div><strong>No usable sources returned</strong>${escapeHtml(hiddenMessage)}</div></div>`;
      return;
    }
    const notes = [];
    if (ranked.hiddenCameraCount) notes.push(`${ranked.hiddenCameraCount} CAM / telesync source${ranked.hiddenCameraCount === 1 ? '' : 's'} hidden automatically.`);
    if (client.lastStreamErrors?.length) notes.push(`${client.lastStreamErrors.length} stream add-on${client.lastStreamErrors.length === 1 ? '' : 's'} failed to answer; CocoaStream kept the working results.`);
    const sourceNotes = notes.length ? `<div class="source-note">${escapeHtml(notes.join(' '))}</div>` : '';
    body.innerHTML = sourceNotes + streams.map((stream, index) => {
      const info = stream._cocoa || {};
      const reliability = info.reliability || {};
      const reliabilityText = reliability.attempts ? `${Math.round(reliability.rate * 100)}% provider reliability` : 'New provider';
      const badges = [
        index === 0 ? '<span class="source-badge best">BEST</span>' : '',
        info.quality ? `<span class="quality">${escapeHtml(info.quality)}</span>` : '',
        info.release ? `<span class="source-badge">${escapeHtml(info.release)}</span>` : '',
        info.seeders ? `<span class="source-badge">${escapeHtml(String(info.seeders))} seeds</span>` : '',
        info.sizeBytes ? `<span class="source-badge">${escapeHtml(formatBytes(info.sizeBytes))}</span>` : '',
        info.compatibility?.level === 'low' ? '<span class="source-badge warn">LIMITED CODEC</span>' : '',
        `<span class="source-type">${escapeHtml(info.kind || streamType(stream))}</span>`
      ].filter(Boolean).join('');
      return `
        <div class="source-item" data-source-index="${index}">
          <div>
            <div class="source-name"><strong>${escapeHtml(brandSafeText(sourceLabel(stream)))}</strong>${badges}</div>
            ${sourceDescription(stream) ? `<div class="source-desc">${escapeHtml(brandSafeText(sourceDescription(stream)))}</div>` : ''}
            <div class="source-score">${escapeHtml(reliabilityText)}${info.warnings?.length ? ` • ${escapeHtml(info.warnings.join(' • '))}` : ''}</div>
          </div>
          <div class="muted small">${escapeHtml(brandSafeText(stream.addonName || ''))}</div>
        </div>`;
    }).join('');
    $$('.source-item', body).forEach((el, index) => {
      el.onclick = () => { activeSourceIndex = index; preparePlayback(item, video, streams[index], modal, fallbacksFor(streams, index)); };
    });
  } catch (error) {
    if (!modal.isConnected) return;
    $('.modal-body', modal).innerHTML = `<div class="empty-state" style="min-height:220px"><div><strong>Could not load sources</strong>${escapeHtml(error.message)}</div></div>`;
  }
}


// Subtitles asked for once the file is playing, with the engine's hash of
// that exact file: add-ons then return lines timed for this release instead
// of whichever release happened to rank first (Sam, Oct 29: "out of time").
async function subtitlesFor(item, videoId, stream) {
  const hashOf = window.cocoa?.playback?.nativeOpensubHash;
  const match = hashOf ? await Promise.race([hashOf().catch(() => null), new Promise(resolve => setTimeout(() => resolve(null), 6000))]) : null;
  return client.subtitles(item, videoId, stream, match);
}

async function preparePlayback(item, video, stream, modal, fallbackStreams = []) {
  modal?.remove();
  const player = await launchPlayer(item, video, stream, null, fallbackStreams);
  const videoId = videoIdOf(video, item);
  subtitlesFor(item, videoId, stream).then(subtitles => {
    if (state.player === player && !player.destroyed) player.setSubtitles(subtitles);
  }).catch(() => { if (state.player === player && !player.destroyed) player.setSubtitles([]); });
}

async function launchPlayer(item, video, stream, subtitles, fallbackStreams = [], failureHistory = []) {
  const videoId = videoIdOf(video, item);
  const resume = findResumeFor(item, state.data.history, videoId);
  const allVideos = normalizedVideos(item);
  const currentIndex = video ? allVideos.findIndex(v => videoIdOf(v, item) === videoId) : -1;
  const nextVideo = currentIndex >= 0 ? allVideos[currentIndex + 1] : null;

  await state.player?.close?.();
  const player = new CocoaPlayer({
    item: cleanMeta(item),
    video,
    stream,
    subtitles,
    preferences: state.data.preferences,
    failureHistory,
    resumePosition: resume?.position || 0,
    resumeDuration: resume?.duration || 0,
    hasNext: Boolean(nextVideo),
    // For the player's episode menu -- switching still goes through
    // CocoaStream's existing chooseSource() pipeline (dedup/rank/prepare/
    // playback handoff) exactly like clicking an episode from the
    // details page does, never a second playback path.
    episodes: isSeriesLike(item) ? allVideos.map(v => ({
      id: videoIdOf(v, item),
      name: v.name || v.title || '',
      season: v.season ?? v.seasonNumber,
      episode: v.episode ?? v.episodeNumber,
      thumbnail: v.thumbnail || ''
    })) : [],
    episodeIndex: currentIndex,
    onProgress: payload => recordProgress(item, video, stream, payload),
    onPlaybackResult: (success, played) => recordSourceResult(played || stream, success),
    onSubtitleLanguage: lang => {
      state.data.preferences.subtitleLanguage = lang;
      persistData().catch(() => {});
    },
    onChangeSource: () => chooseSource(item, video, { showPicker: true }),
    // In-player Sources popover. `onRequestSources` hands the overlay the
    // already-ranked list; `onSelectSource` switches streams WITHOUT closing
    // the player (the old `source` action navigated home).
    onRequestSources: async () => {
      // Reuse the list from chooseSource() when it's still current; only go
      // back to the add-ons when we have none (e.g. playback was resumed).
      if (!activeSourceList.length || activeSourceKey!==rankedCacheKey(item,video)) {
        try {
          const { streams } = await fetchRankedStreams(item, video);
          activeSourceList = streams;
          activeSourceKey = rankedCacheKey(item,video);
        } catch (error) {
          return { sources: [], sourceIndex: -1, sourcesError: error?.message || 'Could not load sources.' };
        }
      }
      return { sources: overlaySourceSummaries(), sourceIndex: activeSourceIndexOf(stream) };
    },
    onSelectSource: index => {
      const target = activeSourceList[index];
      if (!target) return;
      switchPlayerSource(item, video, target, index);
    },
    onTryNextSource: fallbackStreams.length ? () => tryNextRankedSource(item, video, fallbackStreams, failureHistory) : null,
    onNext: () => nextVideo && chooseSource(item, nextVideo),
    onNearEnd: () => nextVideo && prewarmNextEpisode(item,nextVideo,player),
    onSelectEpisode: videoId => {
      const target = allVideos.find(v => videoIdOf(v, item) === videoId);
      if (target) chooseSource(item, target);
    },
    onClose: () => { if (state.player === player) state.player = null; }
  });
  state.player = player;
  await player.open();
  return player;
}

async function prewarmNextEpisode(item,video,player) {
  if(!video||!player||state.player!==player||player.destroyed)return;
  try {
    const {streams}=await fetchRankedStreams(item,video);
    if(state.player!==player||player.destroyed)return;
    const stream=streams[0];
    if(!stream?.infoHash)return;
    await window.cocoa.playback.nativePrewarm({
      stream,
      season:video.season??video.seasonNumber??null,
      episode:video.episode??video.episodeNumber??null
    });
  } catch(error) {
    console.warn('Next episode warm-up failed:',error?.message||error);
  }
}


async function tryNextRankedSource(item, video, streams, failureHistory = []) {
  const [next, ...rest] = streams || [];
  if (!next) {
    toast('All ranked sources have failed. Open Sources in the player to choose another option.', 'error');
    return;
  }
  toast(`Trying next best source: ${brandSafeText(sourceLabel(next))}`);
  const player = await launchPlayer(item, video, next, null, rest, failureHistory);
  const videoId = videoIdOf(video, item);
  subtitlesFor(item, videoId, next).then(subtitles => {
    if (state.player === player && !player.destroyed) player.setSubtitles(subtitles);
  }).catch(() => { if (state.player === player && !player.destroyed) player.setSubtitles([]); });
}

async function recordProgress(item, video, stream, { position, duration, ended }) {
  const videoId = videoIdOf(video, item);
  const key = `${canonicalKey(item)}::${videoId}`;
  const entry = {
    key,
    item: cleanMeta(item),
    videoId,
    video: video ? {
      id: videoId,
      name: video.name || video.title || '',
      season: video.season ?? video.seasonNumber,
      episode: video.episode ?? video.episodeNumber,
      thumbnail: video.thumbnail || ''
    } : null,
    streamLabel: sourceLabel(stream),
    position: Number(position || 0),
    duration: Number(duration || 0),
    ended: Boolean(ended),
    updatedAt: new Date().toISOString()
  };
  const index = state.data.history.findIndex(h => h.key === key);
  if (index >= 0) state.data.history[index] = entry; else state.data.history.unshift(entry);
  state.data.history = recentHistory(state.data.history).slice(0, 500);
  await persistData();
  syncTrakt(() => window.cocoa.trakt.scrobble({
    media: { ...item, season: video?.season ?? video?.seasonNumber, episode: video?.episode ?? video?.episodeNumber },
    progress: duration > 0 ? position / duration * 100 : 0, ended, watching: !ended
  }));
}

async function recordSourceResult(stream, success) {
  if (!state.data.sourceStats) state.data.sourceStats = {};
  const key = sourceProviderKey(stream);
  const current = state.data.sourceStats[key] || { successes: 0, failures: 0 };
  if (success) current.successes = Number(current.successes || 0) + 1;
  else current.failures = Number(current.failures || 0) + 1;
  current.lastResult = success ? 'success' : 'failure';
  current.updatedAt = new Date().toISOString();
  state.data.sourceStats[key] = current;
  await persistData();
}

/* SETTINGS */
function renderSettings() {
  const page = $('#page');
  const prefs = state.data.preferences;
  page.innerHTML = `
    <div class="page">
      <div class="settings-layout">
        <aside class="settings-nav">
          ${['addons','playback','trakt','account','about'].map(id => `<button data-settings-nav="${id}" class="${state.settingsSection === id ? 'active' : ''}">${capitalize(id)}</button>`).join('')}
        </aside>
        <div id="settings-content">${settingsContent(state.settingsSection, prefs)}</div>
      </div>
    </div>`;

  $$('[data-settings-nav]', page).forEach(button => button.onclick = () => {
    state.settingsSection = button.dataset.settingsNav;
    renderSettings();
  });
  bindSettingsActions();
  wireImageFallbacks(page);
  if (state.settingsSection === 'trakt') bindTrakt();

}

function settingsContent(section, prefs) {
  if (section === 'trakt') return `<section class="settings-section"><h2>Trakt</h2><p>Connect your Trakt account to sync ratings, My List and what you watch. Your local library works without it.</p>
    <div class="setting-card" style="padding:18px;display:grid;gap:14px">
      <label>Client ID<input class="setting-input" style="max-width:100%;width:100%" id="trakt-client" autocomplete="off" /></label>
      <label>Client secret<input class="setting-input" style="max-width:100%;width:100%" id="trakt-secret" type="password" autocomplete="off" /></label>
      <p id="trakt-status" role="status" aria-live="polite">Checking connection…</p>
      <button class="solid-btn" id="trakt-connect">Connect Trakt</button><button class="ghost-btn" id="trakt-disconnect">Disconnect</button>
      <button class="ghost-btn" id="trakt-register">Get a free Trakt client ID</button>
    </div></section>`;

  if (section === 'addons') return `
    <section class="settings-section">
      <h2>Add-ons</h2><p>Base providers are included on first setup. Catalog, stream, and subtitle requests are live; this refresh setting only updates each provider's manifest/capabilities.</p>
      <div class="source-note" style="margin-bottom:14px"><strong style="color:var(--cream)">Automatic playback:</strong> CocoaStream plays direct links and torrents through its embedded native player, keeps failover bounded to the next five ranked sources, and does not persist movie/episode payloads to disk.</div>
      <div class="setting-card" style="margin-bottom:14px">
        <div class="setting-row"><div class="setting-copy"><strong>Add-on manifest refresh</strong><span>Smart checks once per day. Live keeps provider resources current without repeatedly reinstalling anything.</span></div><select class="setting-input" style="width:180px" data-pref-select="addonUpdateMode"><option value="smart" ${prefs.addonUpdateMode==='smart'?'selected':''}>Smart</option><option value="launch" ${prefs.addonUpdateMode==='launch'?'selected':''}>Every launch</option><option value="manual" ${prefs.addonUpdateMode==='manual'?'selected':''}>Manual only</option></select></div>
        <div class="setting-row"><div class="setting-copy"><strong>Refresh now</strong><span>Re-fetch every installed manifest and capability list.</span></div><button class="ghost-btn" data-refresh-addons>Refresh</button></div>
      </div>
      <form class="addon-form" id="addon-form"><input class="setting-input" name="url" placeholder="https://example.com/manifest.json" required /><button class="solid-btn green">Add</button></form>
      <div class="addon-list">${(state.data.addons || []).map(addonCardHtml).join('')}</div>
    </section>`;

  if (section === 'playback') return `
    <section class="settings-section"><h2>Playback</h2><p>Simple defaults that stay attached to this local account.</p>
      <div class="setting-card">
        ${settingToggle('Autoplay next episode','Automatically open the next episode when one ends.','autoplayNext',prefs.autoplayNext)}
        ${settingToggle('Resume playback','Continue from your last position.','resumePlayback',prefs.resumePlayback)}
        ${settingToggle('Hide CAM / telesync sources','Filter camera-recorded releases out of the source list.','hideCamSources',prefs.hideCamSources)}
        ${settingToggle('Show all sources before playback','Choose from the ranked list instead of opening the best-ranked source automatically.','showSourcePicker',prefs.showSourcePicker)}
        ${settingToggle('Try next source automatically','If a source times out or cannot decode, immediately try the next ranked source.','autoTryNextSource',prefs.autoTryNextSource)}
        ${settingToggle('Remember subtitle language','Try your last subtitle language automatically.','rememberSubtitle',prefs.rememberSubtitle)}
        <div class="setting-row"><div class="setting-copy"><strong>Preferred subtitles</strong><span>Used when matching subtitle tracks.</span></div><select class="setting-input" style="width:180px" data-pref-select="subtitleLanguage"><option value="eng" ${prefs.subtitleLanguage==='eng'?'selected':''}>English</option><option value="spa" ${prefs.subtitleLanguage==='spa'?'selected':''}>Spanish</option><option value="fil" ${prefs.subtitleLanguage==='fil'?'selected':''}>Filipino</option><option value="jpn" ${prefs.subtitleLanguage==='jpn'?'selected':''}>Japanese</option><option value="kor" ${prefs.subtitleLanguage==='kor'?'selected':''}>Korean</option></select></div>
      </div>
    </section>`;

  if (section === 'account') return `
    <section class="settings-section"><h2>Account</h2><p>Your account and collection stay on this device.</p>
      <div class="setting-card">
        <div class="setting-row profile-editor-row"><div class="profile-editor-avatar">${profileAvatarHtml('large')}</div><div class="setting-copy"><strong>Profile picture</strong><span>Stored locally on this device.</span></div><input type="file" accept="image/*" data-profile-file hidden /><button class="ghost-btn" data-profile-upload>Choose image</button>${state.data.profile?.avatarDataUrl ? '<button class="danger-btn" data-profile-remove>Remove</button>' : ''}</div>
        <div class="setting-row"><div class="setting-copy"><strong>Display name</strong><span>The name shown in the app. Your sign-in username stays the same.</span></div><input class="setting-input" style="width:240px" maxlength="32" data-profile-username value="${escapeHtml(state.data.profile?.username || '')}" placeholder="${escapeHtml(state.session.username)}" /><button class="ghost-btn" data-profile-save>Save</button></div>
        <div class="setting-row"><div class="setting-copy"><strong>${escapeHtml(state.session.username)}</strong><span>Local CocoaStream login</span></div></div>
        <div class="setting-row"><div class="setting-copy"><strong>Watch history</strong><span>${state.data.history.length} playback record${state.data.history.length===1?'':'s'} stored locally.</span></div><button class="danger-btn" data-clear-history>Clear history</button></div>
        <div class="setting-row"><div class="setting-copy"><strong>Log out</strong><span>Your data stays saved on this device.</span></div><button class="ghost-btn" data-settings-logout>Log out</button></div>
      </div>
    </section>`;

  return `
    <section class="settings-section"><h2>About CocoaStream</h2><p>Your personal cinema. Built for Android and the add-ons you choose.</p>
      <div class="setting-card">
        <div class="setting-row"><div class="setting-copy"><strong>Version</strong><span id="version-label">Loading…</span></div></div>
        <div class="setting-row"><div class="setting-copy"><strong>Playback test</strong><span>Play a public sample video without needing a stream add-on.</span></div><button class="ghost-btn" data-playback-test>Test</button></div>
        <div class="setting-row"><div class="setting-copy"><strong>Playback engines</strong><span id="runtime-status-label">Check whether native video and torrent runtimes are ready.</span></div><button class="ghost-btn" data-runtime-status>Check</button></div>
        <div class="setting-row"><div class="setting-copy"><strong>VPN status</strong><span id="vpn-status-label">Check whether Android reports an active VPN connection.</span></div><button class="ghost-btn" data-vpn-status>Check</button></div>
        <div class="setting-row"><div class="setting-copy"><strong>Updates</strong><span id="update-label">The update engine is ready; a release feed is not configured yet.</span></div><button class="ghost-btn" data-check-updates>Check</button></div>
        <div class="setting-row"><div class="setting-copy"><strong>Add-on protocol</strong><span>HTTP manifest, catalog, meta, stream, and subtitles resources.</span></div></div>
        <div class="setting-row"><div class="setting-copy"><strong>System typeface</strong><span>Uses your device’s native font for clear, fast-loading text.</span></div></div>
      </div>
    </section>`;
}

function settingToggle(title, description, key, value) {
  return `<div class="setting-row"><div class="setting-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(description)}</span></div><button class="toggle ${value !== false ? 'on' : ''}" data-pref-toggle="${key}" aria-label="${escapeHtml(title)}"></button></div>`;
}



function addonConfigureUrl(addon) {
  if (addon?.configureUrl) return addon.configureUrl;
  if (!addon?.manifest?.behaviorHints?.configurable || !addon.url) return '';
  return String(addon.url).replace(/\/manifest\.json(?:\?.*)?$/i, '/configure');
}

function addonCardHtml(addon, index) {
  const manifest = addon.manifest || {};
  const health = addon.health;
  const resources = manifestResources(manifest);
  const name = brandSafeText(manifest.name || addon.name || (addon.setupOnly ? 'Setup required' : 'Loading add-on…'));
  const description = brandSafeText(manifest.description || addon.description || addon.url || 'Complete setup to activate this provider.');
  const configureUrl = addonConfigureUrl(addon);
  const statusClass = addon.setupOnly ? '' : health?.ok === true ? 'ok' : health?.ok === false ? 'bad' : '';
  return `
    <div class="addon-card">
      <div class="addon-logo">${manifest.logo ? `<img src="${escapeHtml(manifest.logo)}" data-primary-src="${escapeHtml(manifest.logo)}" data-fallback-src="" alt="" /><span class="image-fallback hidden">✦</span>` : '<span>✦</span>'}</div>
      <div>
        <div class="addon-title"><span class="health ${statusClass}"></span><strong>${escapeHtml(name)}</strong>${addon.core ? '<span class="resource-chip">CORE</span>' : addon.builtin ? '<span class="resource-chip">BASE</span>' : ''}<span class="dim tiny">${escapeHtml(manifest.version || '')}</span></div>
        <div class="addon-meta">${escapeHtml(description)}${addon.setupOnly ? '<br><span class="muted">Configuration is required before this provider can become active.</span>' : ''}${health?.error && !addon.setupOnly ? `<br><span style="color:#d18a85">${escapeHtml(brandSafeText(health.error))}</span>` : ''}</div>
        <div class="resource-chips">${addon.setupOnly ? '<span class="resource-chip">SETUP REQUIRED</span>' : resources.map(r => `<span class="resource-chip">${escapeHtml(r)}</span>`).join('')}</div>
      </div>
      <div style="display:grid;gap:6px;justify-items:end">
        ${configureUrl ? `<button class="pill-btn" data-configure-addon="${index}">Configure</button>` : ''}
        ${addon.setupOnly ? '' : `<button class="pill-btn" data-health-index="${index}">Check</button>`}
        ${addon.core ? '' : `<button class="danger-btn" data-remove-addon="${index}">Remove</button>`}
      </div>
    </div>`;
}

function bindSettingsActions() {
  const page = $('#page');
  $('#addon-form', page)?.addEventListener('submit', addAddon);
  $$('[data-remove-addon]', page).forEach(button => button.onclick = () => removeAddon(Number(button.dataset.removeAddon)));
  $$('[data-health-index]', page).forEach(button => button.onclick = () => checkOneAddon(Number(button.dataset.healthIndex), button));
  $$('[data-configure-addon]', page).forEach(button => button.onclick = () => configureAddon(Number(button.dataset.configureAddon)));
  $('[data-refresh-addons]', page)?.addEventListener('click', refreshAllAddons);
  $$('[data-pref-toggle]', page).forEach(button => button.onclick = async () => {
    const key = button.dataset.prefToggle;
    state.data.preferences[key] = !state.data.preferences[key];
    await persistData();
    renderSettings();
  });
  $$('[data-pref-select]', page).forEach(select => select.onchange = async event => {
    const key = select.dataset.prefSelect;
    const value = event.target.value;
    state.data.preferences[key] = value;
    await persistData();
    renderSettings();
  });
  $('[data-clear-history]', page)?.addEventListener('click', async () => {
    if (!confirm('Clear all CocoaStream watch history on this account?')) return;
    state.data.history = [];
    await persistData();
    toast('Watch history cleared.');
    renderSettings();
  });

$('[data-profile-save]', page)?.addEventListener('click', async () => {
  const input = $('[data-profile-username]', page);
  const username = String(input?.value || '').trim().slice(0, 32);
  if (!state.data.profile) state.data.profile = { username: '', avatarDataUrl: '' };
  state.data.profile.username = username;
  await persistData();
  renderShell();
  state.settingsSection = 'account';
  navigate('settings');
  toast('Profile updated.');
});
$('[data-profile-upload]', page)?.addEventListener('click', () => $('[data-profile-file]', page)?.click());
$('[data-profile-file]', page)?.addEventListener('change', async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const avatarDataUrl = await imageFileToAvatarDataUrl(file);
    if (!state.data.profile) state.data.profile = { username: '', avatarDataUrl: '' };
    state.data.profile.avatarDataUrl = avatarDataUrl;
    await persistData();
    renderShell();
    state.settingsSection = 'account';
    navigate('settings');
    toast('Profile picture updated.');
  } catch (error) { toast(error.message, 'error'); }
});
$('[data-profile-remove]', page)?.addEventListener('click', async () => {
  if (!state.data.profile) state.data.profile = { username: '', avatarDataUrl: '' };
  state.data.profile.avatarDataUrl = '';
  await persistData();
  renderShell();
  state.settingsSection = 'account';
  navigate('settings');
});

  $('[data-settings-logout]', page)?.addEventListener('click', logout);
  $('[data-check-updates]', page)?.addEventListener('click', runUpdateCheck);
  $('[data-playback-test]', page)?.addEventListener('click', runPlaybackTest);
  $('[data-runtime-status]', page)?.addEventListener('click', async () => {
    const label = $('#runtime-status-label');
    if (label) label.textContent = 'Checking…';
    try {
      const status = await window.cocoa.playback.runtimeStatus();
      const mpv = status?.mpv?.path ? `Native player ready (${status.mpv.source || 'available'})` : 'Native player downloads automatically when first needed';
      const engine = status?.['stream-engine']?.path ? `Torrent engine ready (${status['stream-engine'].source || 'available'})` : 'Torrent engine downloads automatically when first needed';
      if (label) label.textContent = `${mpv} • ${engine}`;
    } catch (error) { if (label) label.textContent = error.message; }
  });
  $('[data-vpn-status]', page)?.addEventListener('click', async () => {
    const label = $('#vpn-status-label');
    if (label) label.textContent = 'Checking route…';
    try {
      const status = await window.cocoa.playback.vpnStatus();
      if (label) label.textContent = status.safe ? `VPN status verified${status.interface ? `: ${status.interface}` : ''}` : `Not verified: ${status.reason || 'no protected route detected'}`;
    } catch (error) { if (label) label.textContent = error.message; }
  });
  if (state.settingsSection === 'about') {
    window.cocoa.app.version().then(v => { const el = $('#version-label'); if (el) el.textContent = v; });
  }
}


async function addAddon(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.elements.url;
  const button = form.querySelector('button');
  await installAddonFromUrl(input.value, button);
  input.value = '';
}

async function installAddonFromUrl(rawUrl, button = null) {
  if (button) {
    button.disabled = true;
    if (!button.dataset.originalText) button.dataset.originalText = button.textContent;
    button.textContent = 'Adding…';
  }
  try {
    const loaded = await window.cocoa.addons.manifest(rawUrl);
    if (loaded.manifest?.behaviorHints?.configurationRequired) throw new Error('This add-on requires setup or sign-in. Use a ready-to-use manifest instead.');
    const aioBase = state.data.addons.find(a => a.key === 'aiostreams');
    const isConfiguredAio = aioBase && /aiostreams/i.test(String(loaded.manifest.name || '')) && loaded.url !== aioBase.url;
    if (isConfiguredAio) {
      Object.assign(aioBase, { url: loaded.url, manifest: loaded.manifest, setupOnly: false, manifestFetchedAt: new Date().toISOString(), health: { ok: true, checkedAt: new Date().toISOString() } });
    } else {
      const duplicate = state.data.addons.find(a => !a.setupOnly && (a.url === loaded.url || a.manifest?.id === loaded.manifest.id));
      if (duplicate) throw new Error(`${brandSafeText(loaded.manifest.name)} is already installed.`);
      const setupPlaceholder = state.data.addons.find(a => a.setupOnly && /aiostreams/i.test(String(loaded.manifest.name || '')));
      if (setupPlaceholder) {
        Object.assign(setupPlaceholder, { url: loaded.url, manifest: loaded.manifest, setupOnly: false, manifestFetchedAt: new Date().toISOString(), health: { ok: true, checkedAt: new Date().toISOString() } });
      } else {
        state.data.addons.push({ url: loaded.url, manifest: loaded.manifest, addedAt: new Date().toISOString(), core: false, builtin: false, manifestFetchedAt: new Date().toISOString(), health: { ok: true, checkedAt: new Date().toISOString() } });
      }
    }
    await persistData();
    toast(`${brandSafeText(loaded.manifest.name)} added.`);
    state.rows = [];
    state.hero = null;
    renderSettings();
    loadHome(true);
  } catch (error) {
    toast(error.message, 'error');
    if (button) {
      button.disabled = false;
      button.textContent = button.dataset.originalText || 'Add';
    }
  }
}

async function removeAddon(index) {
  const addon = state.data.addons[index];
  if (!addon || addon.core) return;
  state.data.addons.splice(index, 1);
  await persistData();
  state.rows = [];
  state.hero = null;
  toast(`${brandSafeText(addon.manifest?.name || addon.name || 'Add-on')} removed.`);
  renderSettings();
  loadHome(true);
}


async function configureAddon(index) {
  const addon = state.data.addons[index];
  const url = addonConfigureUrl(addon);
  if (!url) return;
  await window.cocoa.app.openExternal(url);
  if (addon.setupOnly) toast('Finish setup in your browser, then paste the generated manifest URL into Add-ons.');
}

async function refreshAllAddons() {
  const button = $('[data-refresh-addons]');
  if (button) { button.disabled = true; button.textContent = 'Refreshing…'; }
  await client.refreshAllManifests().catch(error => toast(error.message, 'error'));
  await persistData();
  toast('Add-on manifests refreshed.');
  if (state.route === 'settings' && state.settingsSection === 'addons') renderSettings();
}

async function checkOneAddon(index, button = null) {
  const addon = state.data.addons[index];
  if (!addon) return;
  // Visible right away: the manifest fetch can take seconds, and a button that
  // shows nothing until then reads as dead.
  if (button) { button.disabled = true; button.textContent = 'Checking…'; }
  const health = await client.healthCheck(addon);
  await persistData();
  const name = brandSafeText(addon.manifest?.name || addon.name || 'Add-on');
  toast(health?.ok ? `${name} is working.` : `${name} is not responding: ${brandSafeText(health?.error || 'unknown error')}`, health?.ok ? 'info' : 'error');
  renderSettings();
}

async function refreshAddonHealth() {
  if (state.healthRunning) return;
  state.healthRunning = true;
  try {
    for (const addon of state.data.addons || []) {
      if (addon.setupOnly) continue;
      await client.healthCheck(addon).catch(() => {});
    }
    await persistData();
    if (state.route === 'settings' && state.settingsSection === 'addons') renderSettings();
  } finally {
    state.healthRunning = false;
  }
}


async function runPlaybackTest() {
  const item = cleanMeta({
    id: 'cocoastream-demo-bbb',
    type: 'movie',
    name: 'CocoaStream Playback Test',
    description: 'Short public-domain MDN sample used only to verify the local player.'
  });
  const stream = {
    name: 'CocoaStream Demo',
    title: 'Public H.264 sample • direct HTTP video',
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4'
  };
  await state.player?.close?.();
  const player = new CocoaPlayer({
    item,
    video: null,
    stream,
    subtitles: [],
    preferences: { ...state.data.preferences, resumePlayback: false },
    resumePosition: 0,
    hasNext: false,
    onProgress: async () => {},
    onChangeSource: () => toast('The test has only one source.'),
    onClose: () => { if (state.player === player) state.player = null; }
  });
  state.player = player;
  await player.open();
}

async function runUpdateCheck() {
  const label = $('#update-label');
  if (label) label.textContent = 'Checking…';
  const result = await window.cocoa.app.checkUpdates(state.data.preferences.updateManifestUrl || '');
  if (!result.configured) {
    if (label) label.textContent = 'Update engine ready. It will become active after CocoaStream has a release feed URL.';
    return;
  }
  if (result.error) {
    if (label) label.textContent = `Update check failed: ${result.error}`;
    return;
  }
  if (result.latestVersion && versionGreater(result.latestVersion, result.currentVersion)) {
    if (label) label.textContent = `Version ${result.latestVersion} is available.`;
    if (result.downloadUrl && confirm(`CocoaStream ${result.latestVersion} is available. Open the download page?`)) window.cocoa.app.openExternal(result.downloadUrl);
  } else if (label) label.textContent = `You are on the latest version (${result.currentVersion}).`;
}

async function checkConfiguredUpdates() {
  const url = state.data?.preferences?.updateManifestUrl;
  if (!url) return;
  const result = await window.cocoa.app.checkUpdates(url);
  if (result.latestVersion && versionGreater(result.latestVersion, result.currentVersion)) toast(`CocoaStream ${result.latestVersion} is available.`);
}

function versionGreater(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const av = pa[i] || 0, bv = pb[i] || 0;
    if (av !== bv) return av > bv;
  }
  return false;
}

function capitalize(value) { return value.charAt(0).toUpperCase() + value.slice(1); }
function cssUrl(url) { return String(url || '').replaceAll("'", '%27').replaceAll('\\', '%5C'); }

window.__csBack = () => {
  const modal = $('.modal-scrim');
  if (modal) { $('[data-modal-close]', modal)?.click(); return true; }
  if (state.details) { closeDetails(); return true; }
  if ($('.profile-menu')) { closeProfileMenu(); return true; }
  if (state.route !== 'home') { navigate('home'); return true; }
  return false;
};

async function bindTrakt() {
  const label = $('#trakt-status');
  const status = await window.cocoa.trakt.status().catch(() => ({}));
  if (!label?.isConnected) return;
  $('#trakt-client').value = status.clientId || '';
  label.textContent = status.connected ? 'Connected. Your activity syncs automatically.' : 'Not connected. Use the credentials from your Trakt API application.';
  $('#trakt-register').onclick = () => window.cocoa.app.openExternal('https://trakt.tv/oauth/applications');
  $('#trakt-disconnect').onclick = async () => { await window.cocoa.trakt.disconnect(); label.textContent = 'Disconnected. Your local library is unchanged.'; };
  $('#trakt-connect').onclick = async event => {
    const button = event.currentTarget; button.disabled = true;
    try {
      await window.cocoa.trakt.setCredentials({ clientId: $('#trakt-client').value.trim(), clientSecret: $('#trakt-secret').value.trim() });
      $('#trakt-secret').value = '';
      const code = await window.cocoa.trakt.startAuth();
      label.textContent = `Enter ${code.userCode} at ${code.verificationUrl}, then return here.`;
      await window.cocoa.app.openExternal(code.verificationUrl);
      await window.cocoa.trakt.awaitAuth({});
      if (label.isConnected) label.textContent = 'Connected. Your activity syncs automatically.';
    } catch (error) { if (label.isConnected) label.textContent = error.message; }
    finally { button.disabled = false; }
  };
}
async function syncTrakt(operation) {
  try { if ((await window.cocoa.trakt.status()).connected) await operation(); }
  catch (error) { console.warn('Trakt sync unavailable:', error.message); }
}
