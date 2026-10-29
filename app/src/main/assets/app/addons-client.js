import {
  cleanMeta, dedupeItems, supportsResource, catalogSupportsSearch,
  manifestResources
} from './lib.js';

const DAY = 24 * 60 * 60 * 1000;
// A source list the user is staring at must never wait on a dead add-on.
// fetchJson's 15s timeout (plus one retry) is right for a manifest, far too
// long here: one black-holed add-on used to delay every other add-on's sources
// behind it.
const STREAM_REQUEST_TIMEOUT_MS = 8000;
// Dead-add-on handling: three consecutive failures and it sits out a cooldown,
// so it stops contributing errors to the picker. Advisory only -- if it is the
// only add-on left it is still tried rather than leaving the user with nothing.
const STREAM_FAILURE_LIMIT = 3;
const STREAM_COOLDOWN_MS = 10 * 60 * 1000;
// "Too many requests" is an add-on asking us to slow down, not a dead add-on.
// Measured Oct 29: one add-on's HTTP 429 used to stop the whole Home no-source
// check for ten minutes, so titles with nothing playable stayed on screen. The
// back-off is per add-on now: only the add-on that said slow down is left
// alone (across restarts too), and no add-on is ever asked twice in quick
// succession, which is what provokes a 429 in the first place.
const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;
const ADDON_REQUEST_GAP_MS = 1200;
// Manifest refresh cooldowns: ten minutes for an add-on that loaded, two for
// one that failed (it is retried on every source lookup otherwise).
const MANIFEST_RETRY_MS = 10 * 60 * 1000;
const MANIFEST_RETRY_FAILED_MS = 2 * 60 * 1000;

const STREAMS_GRACE_MS = 2500;
const STREAMS_MAX_WAIT_MS = 10000;

// Electron wraps IPC failures as "Error invoking remote method 'x': Error: ...";
// the user only needs the real reason.
function ipcReason(error) {
  return String(error?.message || error || '').replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

export class AddonClient {
  constructor(getData, saveData) {
    this.getData = getData;
    this.saveData = saveData;
    this.lastStreamErrors = [];
    this.sessionManifestRefreshDone = false;
    this.ensurePromise = null;
  }

  async ensureManifests(options = {}) {
    const force = Boolean(options.force);
    if (this.ensurePromise && !force) return this.ensurePromise;
    const task = this._ensureManifests({ force });
    if (force) return task;
    this.ensurePromise = task.finally(() => { this.ensurePromise = null; });
    return this.ensurePromise;
  }


async _ensureManifests({ force = false } = {}) {
  const data = this.getData();
  const mode = data?.preferences?.addonUpdateMode || 'smart';
  let changed = false;

  const jobs = (data.addons || []).map(async addon => {
    if (addon.setupOnly || !addon.url) return;
    const fetchedAt = Date.parse(addon.manifestFetchedAt || 0) || 0;
    const shouldRefresh = force || !addon.manifest?.id ||
      (mode === 'launch' && !this.sessionManifestRefreshDone) ||
      (mode === 'smart' && (!fetchedAt || Date.now() - fetchedAt > DAY));
    if (!shouldRefresh) return;

    const lastAttempt = Date.parse(addon.lastManifestAttemptAt || 0) || 0;
    // A failing add-on used to be retried on EVERY source lookup, because this
    // cooldown only applied once a manifest had loaded: with one add-on down
    // (torrentsdb answering 502, measured Oct 29) every Play paid its 15s
    // timeout plus a retry before any source list appeared -- 45s of the
    // 87s before the first picture. Failures get their own shorter cooldown,
    // so a recovering add-on comes back without taxing every Play.
    const cooldown = addon.manifest?.id ? MANIFEST_RETRY_MS : MANIFEST_RETRY_FAILED_MS;
    if (!force && lastAttempt && Date.now() - lastAttempt < cooldown) return;
    addon.lastManifestAttemptAt = new Date().toISOString();
    try {
      const loaded = await window.cocoa.addons.manifest(addon.url);
      addon.url = loaded.url;
      addon.manifest = loaded.manifest;
      if (loaded.manifest?.behaviorHints?.configurationRequired) addon.setupOnly = true;
      addon.manifestFetchedAt = new Date().toISOString();
      addon.healthError = '';
      addon.health = { ok: true, checkedAt: new Date().toISOString() };
    } catch (error) {
      addon.healthError = error.message;
      addon.health = { ok: false, checkedAt: new Date().toISOString(), error: ipcReason(error) };
    }
    changed = true;
  });

  await Promise.allSettled(jobs);
  if (mode === 'launch') this.sessionManifestRefreshDone = true;
  if (changed) await this.saveData();
  return data.addons || [];
}

async refreshAllManifests() {
    this.sessionManifestRefreshDone = false;
    this.ensurePromise = null;
    return this.ensureManifests({ force: true });
  }

  async healthCheck(addon) {
    if (addon?.setupOnly) {
      addon.health = { ok: false, setup: true, checkedAt: new Date().toISOString(), error: 'Setup required' };
      return addon.health;
    }
    try {
      const loaded = await window.cocoa.addons.manifest(addon.url);
      addon.url = loaded.url;
      addon.manifest = loaded.manifest;
      if (loaded.manifest?.behaviorHints?.configurationRequired) addon.setupOnly = true;
      addon.manifestFetchedAt = new Date().toISOString();
      addon.health = { ok: true, checkedAt: new Date().toISOString() };
    } catch (error) {
      addon.health = { ok: false, checkedAt: new Date().toISOString(), error: ipcReason(error) };
    }
    return addon.health;
  }

  findAddon(addons, key, idIncludes = '') {
    return addons.find(addon =>
      !addon.setupOnly && addon.manifest &&
      (addon.key === key || (idIncludes && String(addon.manifest.id || '').includes(idIncludes)))
    );
  }

  async catalog(addon, type, id, extra = {}) {
    if (!addon?.manifest || !addon.url) return [];
    const response = await window.cocoa.addons.request({
      manifestUrl: addon.url,
      resource: 'catalog',
      type,
      id,
      extra
    });
    return (response?.metas || []).map(meta => ({
      ...cleanMeta(meta),
      _addonUrl: addon.url,
      _addonName: addon.manifest?.name || 'Add-on'
    }));
  }


  async ensureDiscoveryManifests() {
    const data = this.getData();
    const wanted = new Set(['cinemeta']);
    const entries = (data.addons || []).filter(addon => wanted.has(addon.key));
    let changed = false;
    await Promise.allSettled(entries.map(async addon => {
      if (addon.manifest?.id || !addon.url) return;
      try {
        const loaded = await window.cocoa.addons.manifest(addon.url);
        addon.url = loaded.url;
        addon.manifest = loaded.manifest;
        addon.manifestFetchedAt = new Date().toISOString();
        addon.health = { ok: true, checkedAt: new Date().toISOString() };
      } catch (error) {
        addon.health = { ok: false, checkedAt: new Date().toISOString(), error: ipcReason(error) };
      }
      changed = true;
    }));
    if (changed) await this.saveData();
    return data.addons || [];
  }

  async homeRows(onRows = () => {}) {
    const addons = await this.ensureDiscoveryManifests();
    const cinema = this.findAddon(addons, 'cinemeta', 'cinemeta');
    const anime = this.findAddon(addons, 'anime-kitsu', 'anime.kitsu');
    const specs = [
      ['Popular Movies', cinema, 'movie', 'top', {}],
      ['Popular TV', cinema, 'series', 'top', {}],
      ['New Movies', cinema, 'movie', 'year', { genre: String(new Date().getFullYear()) }],
      ['Popular Anime', anime, 'anime', 'kitsu-anime-trending', {}],
      ...['Horror', 'Comedy', 'Action', 'Sci-Fi', 'Documentaries'].map(genre =>
        [genre, cinema, 'movie', 'top', { genre }])
    ];
    const rows = new Array(specs.length);
    await Promise.allSettled(specs.map(async ([name, addon, type, id, extra], index) => {
      const items = await this.catalog(addon, type, id, extra);
      if (!items.length) return;
      rows[index] = { name, items: dedupeItems(items).slice(0, 24) };
      onRows(rows.filter(Boolean));
    }));
    this.ensureManifests().catch(() => {});
    return rows.filter(Boolean);
  }

  async search(query, onResults = () => {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const addons = await this.ensureDiscoveryManifests();
    const jobs = [];
    for (const addon of addons) {
      if (!addon.manifest || addon.setupOnly) continue;
      for (const catalog of addon.manifest.catalogs || []) {
        if (!['movie', 'series', 'anime'].includes(catalog.type) || !catalogSupportsSearch(catalog)) continue;
        jobs.push({ addon, catalog });
      }
    }

    const available = [];
    const settled = await Promise.allSettled(jobs.map(async ({ addon, catalog }) => {
      const response = await window.cocoa.addons.request({
        manifestUrl: addon.url,
        resource: 'catalog',
        type: catalog.type,
        id: catalog.id,
        extra: { search: q }
      });
      const items = (response?.metas || []).map(meta => ({
        ...cleanMeta(meta),
        _addonUrl: addon.url,
        _addonName: addon.manifest?.name || 'Add-on'
      }));
      available.push(...items);
      onResults(dedupeItems(available).slice(0,120));
      return items;
    }));
    return dedupeItems(settled.flatMap(x => x.status === 'fulfilled' ? x.value : [])).slice(0, 120);
  }

  async meta(item) {
    const addons = await this.ensureDiscoveryManifests();
    const preferred = item?._addonUrl ? addons.find(a => a.url === item._addonUrl) : null;
    const ordered = preferred ? [preferred, ...addons.filter(a => a !== preferred)] : addons;
    let merged = cleanMeta(item);
    let found = false;

    for (const addon of ordered) {
      if (!addon.manifest || addon.setupOnly || !supportsResource(addon.manifest, 'meta', item.type, item.id)) continue;
      try {
        const response = await window.cocoa.addons.request({
          manifestUrl: addon.url,
          resource: 'meta',
          type: item.type,
          id: item.id,
          extra: {}
        });
        const raw = Array.isArray(response?.meta) ? response.meta[0] : response?.meta;
        if (!raw?.id && !raw?.name) continue;
        const candidate = cleanMeta({ ...item, ...raw });
        if (!found) {
          merged = { ...candidate, _addonUrl: addon.url, _addonName: addon.manifest.name };
          found = true;
        } else {
          merged = {
            ...merged,
            poster: merged.poster || candidate.poster,
            background: merged.background || candidate.background,
            description: merged.description || candidate.description,
            genres: merged.genres?.length ? merged.genres : candidate.genres,
            releaseInfo: merged.releaseInfo || candidate.releaseInfo,
            runtime: merged.runtime || candidate.runtime,
            imdbRating: merged.imdbRating || candidate.imdbRating,
            // Packet B: same gap-fill rule as imdbRating, so a second metadata
            // add-on can supply cast/crew when the first one lacks it.
            cast: merged.cast?.length ? merged.cast : candidate.cast,
            director: merged.director?.length ? merged.director : candidate.director,
            writer: merged.writer?.length ? merged.writer : candidate.writer,
            awards: merged.awards || candidate.awards,
            country: merged.country || candidate.country,
            videos: merged.videos?.length ? merged.videos : candidate.videos
          };
        }

        const hasArtwork = Boolean(merged.poster && merged.background);
        const seriesLike = ['series', 'anime'].includes(item.type);
        const hasEpisodes = !seriesLike || Boolean(merged.videos?.length);
        if (hasArtwork && hasEpisodes && merged.description) break;
      } catch {}
    }
    return merged;
  }

  // Dead add-ons never reach the picker: once one has failed
  // STREAM_FAILURE_LIMIT times in a row it is skipped until the cooldown
  // expires, and it can never be the reason a healthy list is slow (each
  // request below has a hard deadline). Advisory, not fatal: an add-on in
  // cooldown is still used when nothing else is available.
  inStreamCooldown(addon, now = Date.now()) {
    const failures = Number(addon?.streamFailures || 0);
    if (failures < STREAM_FAILURE_LIMIT) return false;
    const last = Date.parse(addon?.streamFailureAt || 0) || 0;
    return now - last < STREAM_COOLDOWN_MS;
  }

  // An add-on that answered HTTP 429 sits this out. Kept on the add-on record
  // so a restart does not walk straight back into the same rate limit.
  inRateLimitCooldown(addon, now = Date.now()) {
    return Number(addon?.rateLimitedUntil || 0) > now;
  }

  everyAddonRateLimited(now = Date.now()) {
    const list = (this.getData()?.addons || []).filter(addon => addon?.manifest && !addon.setupOnly);
    return list.length > 0 && list.every(addon => this.inRateLimitCooldown(addon, now));
  }

  // One request at a time per add-on, spaced out: a burst of parallel asks is
  // what earns a 429 from the ones with a per-IP limit.
  waitForAddonTurn(addon) {
    const now = Date.now();
    const at = Math.max(now, Number(addon.nextRequestAt || 0));
    addon.nextRequestAt = at + ADDON_REQUEST_GAP_MS;
    return at > now ? new Promise(resolve => setTimeout(resolve, at - now)) : Promise.resolve();
  }

  recordStreamOutcome(addon, error = null) {
    if (!addon) return;
    if (error) {
      // "Too many requests" is the add-on asking us to slow down, not a dead
      // add-on: it must never push a healthy Torrentio into the skip list.
      if (/\bHTTP 429\b/.test(String(error?.message || error))) {
        this.rateLimitedAt = Date.now();
        addon.rateLimitedUntil = this.rateLimitedAt + RATE_LIMIT_COOLDOWN_MS;
        void Promise.resolve(this.saveData?.()).catch(() => {});
        return;
      }
      addon.streamFailures = Number(addon.streamFailures || 0) + 1;
      addon.streamFailureAt = new Date().toISOString();
      addon.health = { ok: false, checkedAt: addon.streamFailureAt, error: ipcReason(error) || 'Request failed' };
      // Persist only at the threshold: one write per add-on per cooldown, not
      // one write per source list.
      if (addon.streamFailures === STREAM_FAILURE_LIMIT) void Promise.resolve(this.saveData?.()).catch(() => {});
      return;
    }
    if (!addon.streamFailures && addon.health?.ok === true) return;
    addon.streamFailures = 0;
    addon.streamFailureAt = '';
    addon.health = { ok: true, checkedAt: new Date().toISOString() };
    void Promise.resolve(this.saveData?.()).catch(() => {});
  }

  async streamsFromAddon(addon, item, id) {
    await this.waitForAddonTurn(addon);
    const request = window.cocoa.addons.request({
      manifestUrl: addon.url,
      resource: 'stream',
      type: item.type,
      id,
      extra: {}
    });
    let timer = null;
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The add-on did not answer in time.')), STREAM_REQUEST_TIMEOUT_MS);
    });
    try {
      const response = await Promise.race([request, deadline]);
      this.recordStreamOutcome(addon, null);
      return (response?.streams || []).map(stream => ({
        ...stream,
        addonName: addon.manifest.name,
        addonUrl: addon.url
      }));
    } catch (error) {
      this.recordStreamOutcome(addon, error);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async streams(item, videoId) {
    const addons = await this.ensureManifests();
    const id = videoId || item.id;
    const eligible = addons.filter(addon =>
      addon.manifest && !addon.setupOnly && !addon.nonPlayback && supportsResource(addon.manifest, 'stream', item.type, id)
    );
    const now = Date.now();
    const live = eligible.filter(addon => !this.inStreamCooldown(addon, now) && !this.inRateLimitCooldown(addon, now));
    const candidates = live.length ? live : eligible;
    const skipped = eligible.filter(addon => !candidates.includes(addon));
    // Don't hold Play for the slowest add-on (Sam, Oct 29: "takes a while
    // before it jumps to the loading screen"): once any add-on has returned
    // sources, the rest get STREAMS_GRACE_MS more, and nothing waits past
    // STREAMS_MAX_WAIT_MS. A late add-on still finishes in the background.
    const results = candidates.map(() => null);
    await new Promise(resolve => {
      let pending = candidates.length;
      let grace = null;
      const hard = setTimeout(finish, STREAMS_MAX_WAIT_MS);
      function finish() { clearTimeout(hard); clearTimeout(grace); resolve(); }
      if (!pending) return finish();
      candidates.forEach((addon, index) => {
        this.streamsFromAddon(addon, item, id).then(
          value => {
            results[index] = { status: 'fulfilled', value };
            if (value.length && !grace) grace = setTimeout(finish, STREAMS_GRACE_MS);
          },
          reason => { results[index] = { status: 'rejected', reason }; }
        ).finally(() => { if (--pending === 0) finish(); });
      });
    });
    const settled = results.map(result => result || { status: 'rejected', reason: new Error('Still answering; skipped so Play is not held up.') });
    this.lastStreamErrors = [
      ...skipped.map(addon => ({
        addonName: addon.manifest?.name || 'Add-on',
        message: 'Skipped after repeated failures; it will be tried again later.',
        skipped: true
      })),
      ...settled.flatMap((result, index) => result.status === 'rejected'
        ? [{ addonName: candidates[index]?.manifest?.name || 'Add-on', message: result.reason?.message || 'Request failed' }]
        : [])
    ];
    // Grouping (display-only, never a transport merge -- see
    // groupDuplicateStreams in renderer/lib.js) happens once, downstream in
    // rankStreams. Every raw Stream Object returned here reaches that step
    // completely unmodified; do not filter/dedupe here, or a duplicate
    // add-on's independent copy of the same infoHash (its own real
    // sources/fileIdx/behaviorHints) is lost before ranking ever sees it.
    return settled.flatMap(x => x.status === 'fulfilled' ? x.value : []);
  }

  async subtitles(item, videoId, stream, match = null) {
    const addons = await this.ensureManifests();
    const inline = Array.isArray(stream?.subtitles) ? stream.subtitles : [];
    const videoHash = match?.hash || stream?.behaviorHints?.videoHash;
    const videoSize = match?.size || stream?.behaviorHints?.videoSize;
    const filename = stream?.behaviorHints?.filename;
    const id = videoId || item.id;
    const extra = { videoHash, videoSize, filename };

    const jobs = addons
      .filter(addon => addon.manifest && !addon.setupOnly &&
        manifestResources(addon.manifest).includes('subtitles') &&
        supportsResource(addon.manifest, 'subtitles', item.type, id))
      .map(async addon => {
        const response = await window.cocoa.addons.request({
          manifestUrl: addon.url,
          resource: 'subtitles',
          type: item.type,
          id,
          extra
        });
        return (response?.subtitles || []).map(sub => ({ ...sub, addonName: addon.manifest.name }));
      });

    const settled = await Promise.allSettled(jobs);
    const all = [...inline, ...settled.flatMap(x => x.status === 'fulfilled' ? x.value : [])];
    const seen = new Set();
    return all.filter(sub => {
      if (!sub?.url || seen.has(sub.url)) return false;
      seen.add(sub.url);
      return true;
    }).slice(0, 120);
  }
}
