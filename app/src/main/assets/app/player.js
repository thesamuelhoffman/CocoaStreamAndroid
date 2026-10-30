import { $, $$, escapeHtml, episodeLabel, sourceLabel, qualityOf, streamType, toast, optionsMenuModel, magnetUriFor, streamCopyUrl } from './lib.js';

// Fun, Cocoa-the-cat-themed loading copy. This is the ONLY thing shown
// while CocoaStream is finding or buffering a source -- no technical
// detail text (peer counts, engine stage names, etc.) is ever shown here,
// on purpose: it's meant to be cute, not a status console.
const HUNTING_LINES = [
  'Cocoa is on the hunt…',
  'Cocoa is sniffing out your movie…',
  'Cocoa is on the prowl…',
  'Cocoa is stalking your show…',
  'Cocoa is chasing the signal…',
  'Cocoa is digging through the couch cushions…',
  'Cocoa is checking under the bed…',
  'Cocoa is pouncing into action…'
];
const BUFFERING_LINES = [
  'Cocoa is filling the food bowl…',
  'Cocoa is stocking up on treats…',
  'Cocoa is kneading the buffer…',
  'Cocoa is curling up with more data…',
  'Cocoa is topping off the bowl…',
  'Cocoa is purring through the buffer…',
  'Cocoa is loading up on snacks…'
];
const RETRY_LINES = [
  "That one got away -- Cocoa's trying again…",
  "Cocoa knocked that one off the shelf, trying another…",
  "Missed pounce! Cocoa's trying again…",
  "Cocoa's already after the next one…",
  "Not impressed -- Cocoa's fetching another…"
];

function randomOf(list) { return list[Math.floor(Math.random() * list.length)]; }

// Native-player load budget. The renderer also caps the complete nativeStart
// request below, including torrent /create time, so one bad source cannot
// strand automatic failover for the engine's much longer HTTP ceiling.
//
// Why a budget at all: the engine's own raw ceiling is ~125s (95s /create
// HTTP timeout + polling), and the renderer previously awaited that with no
// feedback and no auto-retry -- the "try next source" logic only reacts to
// a rejection, never to "still pending". A bound turns "never finishes"
// into a normal rejection the retry path already handles.
//
// One total budget per chosen source; the next series episode is warmed only
// by the near-end hook and does not extend a failed source's startup budget.
const PER_SOURCE_LOAD_TIMEOUT_MS = 30000;

export class CocoaPlayer {
  constructor(options) {
    this.options = options;
    this.ownerId = crypto.randomUUID();
    this.nativeRequested = false;
    this.root = null;
    this.video = null;
    this.hls = null;
    this.subtitleBlob = null;
    this.trackEl = null;
    this.directBufferId = null;
    this.hlsProxyId = null;
    this.statsTimer = null;
    this.bufferTimer = null;
    this.progressTimer = null;
    this.lastSaved = 0;
    this.boundKey = e => this.onKey(e);
    this.destroyed = false;
    this.playbackResultReported = false;
    this.nativeMode = false;
    this.overlayOpen = false;
    this.castUrl = '';
    this.nativeStats = { position: 0, duration: 0, cacheDuration: 0, cacheSpeed: 0, paused: false };
    this.offNativeClosed = null;
    this.offNativeEnded = null;
    this.offNativeStats = null;
    this.offNativeError = null;
    this.offSafetyStop = null;
    this.offEngineStatus = null;
    // The subtitle the user picked, held as a STABLE KEY (`mpv:<id>` /
    // `addon:<n>`), never an array position -- mpv's track list can change
    // between render and click, which would make a positional pick select the
    // wrong track. Empty string means "off".
    this.selectedSubtitleKey = '';
    this.castDeviceId = '';
    this.offOverlayAction = null;
  }

  async open() {
    const { item, stream } = this.options;

    this.root = document.createElement('div');
    this.root.className = 'player-shell controls-visible';
    this.root.innerHTML = `
      <video class="player-video" playsinline preload="auto"></video>
      <div class="player-loading" data-role="loading">
        <span class="spinner"></span>
        <div class="loading-headline" data-role="loading-text">Opening your video…</div>
        <div class="player-recovery"><button class="ghost-btn" data-load-cancel>Cancel</button><button class="ghost-btn" data-load-source>Choose source</button></div>
      </div>
    `;
    document.body.appendChild(this.root);
    this.video = $('.player-video', this.root);
    $('[data-load-cancel]', this.root).onclick = () => this.close(false);
    $('[data-load-source]', this.root).onclick = () => { const select=this.options.onChangeSource; this.close(false).then(() => select?.()); };
    // Only used by the (effectively unreachable today) non-native fallback
    // path -- every real add-on stream carries an infoHash or url, both of
    // which route through the native mpv player below.
    this.video.classList.add('hidden');

    this.bindMediaEvents();
    this.bindEngineStatus();
    document.addEventListener('keydown', this.boundKey);

    try {
      this.setLoading(randomOf(HUNTING_LINES));
      const prepared = await this.withLoadTimeout(this.prepareStream(stream));
      if (this.destroyed) return;
      this.castUrl = prepared?.castUrl || prepared?.url || '';
      // The engine raced the ranked sources and a faster one won: label,
      // stats and copy-link now follow the stream actually playing.
      if (prepared?.switchedStream) this.options.stream = prepared.switchedStream;
      if (prepared?.native) {
        this.nativeMode = true;
        this.hideLoading();
        this.markPlaybackResult(true);
        await this.enterNativeEmbeddedMode();
        this.bindNativeEvents();
        this.startProgressLoop();
        return;
      }
      this.setLoading(randomOf(BUFFERING_LINES));
      await this.attachMedia(prepared.url);
      this.hideLoading();
      this.startProgressLoop();
    } catch (error) {
      if (error?.code === 'COCOASTREAM_PLAYBACK_CANCELLED') { await this.close(false, true); return; }
      if (this.destroyed || error?.code === 'COCOASTREAM_PLAYBACK_SUPERSEDED') return;
      this.markPlaybackResult(false);
      const message = error?.message || 'This source could not be started.';
      this.recordFailure(message);
      if (this.options.preferences?.autoTryNextSource !== false && this.options.onTryNextSource) {
        this.setLoading(randomOf(RETRY_LINES));
        setTimeout(async () => {
          if (this.destroyed) return;
          const next = this.options.onTryNextSource;
          await this.close(false);
          next?.();
        }, 700);
      } else {
        // No more ranked sources -- the UI stays on this shell to show the
        // error (unlike the retry branch above, so this can't call the
        // full close(), which would tear the shell down). But the IPC call
        // that triggered this (a real rejection, or the load-timeout race
        // above) may still be a live, unaborted request in the main
        // process -- cancel it directly so a load-timeout doesn't leave a
        // background torrent-create running for its full ~95s after the
        // user is already looking at an error screen.
        if (this.nativeRequested) window.cocoa.playback.nativeStop(this.ownerId).catch(() => {});
        this.showError(this.failureSummary(message));
      }
    }
  }

  bindMediaEvents() {
    this.video.addEventListener('playing', () => { this.hideLoading(); this.markPlaybackResult(true); });
    this.video.addEventListener('canplay', () => { this.hideLoading(); this.markPlaybackResult(true); });
    this.video.addEventListener('waiting', () => { if (!this.video.paused) this.setLoading(randomOf(BUFFERING_LINES)); });
    this.video.addEventListener('pause', () => { this.hideLoading(); this.saveProgress(true); });
    this.video.addEventListener('ended', async () => {
      await this.saveProgress(true, true);
      if (this.options.preferences?.autoplayNext && this.options.hasNext) {
        this.options.onNext?.();
        this.close(false);
      }
    });
    this.video.addEventListener('error', () => {
      const mediaError = this.video.error;
      const text = mediaError?.message || 'Chromium could not decode this source.';
      this.markPlaybackResult(false);
      this.showError(`${text}\n\nTry another source if this file uses an unsupported video/audio codec.`);
    });
  }

  nativeCommand(command) { return window.cocoa.playback.nativeCommand(command, this.ownerId); }

  // Two-phase backstop. Phase 1 bounds metadata/`/create`; the engine emits
  // `torrent-stage: ready` for THIS owner as soon as the playback URL exists,
  // which re-arms the timer as phase 2 for the actual player load. Without the
  // reset, a 5.7s /create ate most of a 9s window and a perfectly good source
  // was reported as a failure.
  withLoadTimeout(promise) {
    // Android bounds total startup, including metadata; allow its native error to arrive first.
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error('This source did not start in time. Choose another source.'), { stage: 'load-timeout' })), PER_SOURCE_LOAD_TIMEOUT_MS + 5000);
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }

  async prepareStream(stream) {
    if (stream.externalUrl) {
      await window.cocoa.app.openExternal(stream.externalUrl);
      throw new Error('This source opens in an external service.');
    }
    if (stream.ytId) {
      await window.cocoa.app.openExternal(`https://www.youtube.com/watch?v=${encodeURIComponent(stream.ytId)}`);
      throw new Error('The YouTube source was opened in your browser.');
    }
    if (stream.infoHash || stream.url) {
      this.setLoading(randomOf(HUNTING_LINES));
      this.nativeRequested = true;
      return window.cocoa.playback.nativeStart(this.nativePayload(stream));
    }
    throw new Error('This add-on returned a source type CocoaStream does not support yet.');
  }

  nativePayload(stream,resumePosition=Number(this.options.resumePosition||0)) {
    return {
      ownerId:this.ownerId,
      stream,
      title:this.nativeTitle(),
      resumePosition,
      resumeDuration:Number(this.options.resumeDuration||0),
      preferences:this.options.preferences||{},
      season:this.options.video?.season??this.options.video?.seasonNumber??null,
      episode:this.options.video?.episode??this.options.video?.episodeNumber??null,
      loadTimeoutMs:PER_SOURCE_LOAD_TIMEOUT_MS,
      prefetchStreams:[]
    };
  }

  async replaceNativeSource(stream) {
    if(this.destroyed||!this.nativeMode)return false;
    const position=Number(this.nativeStats?.position??this.options.resumePosition??0);
    const result=await window.cocoa.playback.nativeReplace(this.nativePayload(stream,position));
    if(!result?.ok)throw new Error('The player could not switch to that source.');
    this.options.stream=stream;
    this.castUrl=stream.url||'';
    return true;
  }

  // Unreachable with today's add-on stream shapes (see note above), kept as
  // a safety net so a future non-native source still plays, just without
  // the floating glass controls the native path gets.
  async attachMedia(url) {
    this.video.classList.remove('hidden');
    const isHls = /\.m3u8(?:\?|$)/i.test(url) || /\.m3u8(?:\?|$)/i.test(this.options.stream?.behaviorHints?.filename || '');
    if (isHls && window.Hls?.isSupported?.()) {
      this.hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, startFragPrefetch: true, maxBufferSize: 512 * 1024 * 1024, backBufferLength: 90 });
      this.hls.loadSource(url);
      this.hls.attachMedia(this.video);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('The HLS playlist did not load within 15 seconds.')), 15000);
        this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => { clearTimeout(timeout); resolve(); });
        this.hls.on(window.Hls.Events.ERROR, (_event, data) => {
          if (data?.fatal) { clearTimeout(timeout); reject(new Error(`HLS error: ${data.details || data.type}`)); }
        });
      });
    } else {
      this.video.preload = 'auto';
      this.video.src = url;
      this.video.load();
    }
    await new Promise((resolve, reject) => {
      if (this.video.readyState >= 1) return resolve();
      let timer;
      const cleanup = () => { clearTimeout(timer); this.video.removeEventListener('loadedmetadata', done); this.video.removeEventListener('error', failed); };
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('The selected file could not be decoded or loaded.')); };
      this.video.addEventListener('loadedmetadata', done, { once: true });
      this.video.addEventListener('error', failed, { once: true });
      timer = setTimeout(() => { cleanup(); reject(new Error('The selected source did not begin loading within 20 seconds. Try the next ranked source.')); }, 20000);
    });
    const resume = Number(this.options.resumePosition || 0);
    if (this.options.preferences?.resumePlayback !== false && resume > 20 && Number.isFinite(this.video.duration) && resume < this.video.duration - 30) {
      this.video.currentTime = resume;
    }
    this.video.play().catch(() => {});
    this.applyPreferredSubtitle();
  }

  nativeTitle() {
    const episode = this.options.video && this.options.video.id !== this.options.item.id ? episodeLabel(this.options.video) : '';
    return [this.options.item?.name || 'CocoaStream', episode].filter(Boolean).join(' — ');
  }

  overlaySubtitleLine() {
    const { item, video, stream } = this.options;
    const episodeText = video && video.id !== item.id ? episodeLabel(video) : '';
    const quality = qualityOf(stream);
    const kind = streamType(stream);
    return [episodeText, sourceLabel(stream), quality || kind].filter(Boolean).join(' • ');
  }

  async enterNativeEmbeddedMode() {
    if (!this.root) return;
    this.root.classList.add('native-embedded');
    this.overlayOpen = await window.cocoa.overlay.open(this.overlaySyncState()).catch(() => false);
    this.offOverlayAction = window.cocoa.overlay.onAction?.(payload => this.onOverlayAction(payload));
  }

  overlaySyncState() {
    const episodes = Array.isArray(this.options.episodes) ? this.options.episodes : [];
    return {
      ownerId: this.ownerId,
      title: this.options.item?.name || 'CocoaStream',
      subtitle: this.overlaySubtitleLine(),
      hasNext: Boolean(this.options.hasNext),
      subtitles: this.subtitleRows(),
      subtitleKey: this.activeSubtitleKey(),
      optionsMenu: this.optionsMenuItems(),
      // Casting is driven entirely from the overlay (the only surface above
      // the video surface). It needs the direct stream URL; only the player
      // holds it, so it travels in the sync payload like everything else.
      castUrl: this.castUrl || '',
      episodes,
      episodeIndex: Number.isInteger(this.options.episodeIndex) ? this.options.episodeIndex : -1
    };
  }

  // The options menu is rebuilt from the CURRENT subtitle selection so the
  // "Download Subtitles" row only exists when a subtitle is actually
  // selected (upstream gates it on subtitlesTrackUrl the same way).
  optionsMenuItems() {
    const sub = this.selectedAddonSubtitle();
    return optionsMenuModel(this.options.stream || {}, { subtitleUrl: sub?.url || '' });
  }

  onOverlayAction(payload = {}) {
    if (this.destroyed) return;
    const { action } = payload;
    if (action === 'close') this.close();
    else if (action === 'source' || action === 'request-sources') this.requestSources();
    else if (action === 'next') { this.saveProgress(true).then(() => { this.options.onNext?.(); this.close(false); }); }
    else if (action === 'select-episode') { this.saveProgress(true).then(() => { this.options.onSelectEpisode?.(payload.videoId); this.close(false); }); }
    else if (action === 'subtitle-search') this.subtitleSearchOpen = Boolean(payload.open);
    else if (action === 'toggle-fullscreen') { if (document.fullscreenElement) document.exitFullscreen(); else this.root.requestFullscreen().catch(() => {}); }
    else if (action === 'select-subtitle') this.selectSubtitle(payload.key);
    else if (action === 'copy-stream') this.copyStreamLink();
    else if (action === 'copy-magnet') this.copyMagnetLink();
    else if (action === 'open-stream') this.openStreamLink();
    else if (action === 'download-subs') this.openSubtitleLink();
    else if (action === 'cast-started') this.onCastStarted(payload.deviceId);
    else if (action === 'select-source') this.selectSourceByIndex(Number(payload.index));
  }

  // --- Options menu actions (upstream: Copy Stream Link / Copy Magnet Link).
  // Copying happens in the MAIN process (app:write-clipboard) because the
  // controls overlay window is deliberately non-focusable and can't own the
  // system clipboard. The user gets an explicit toast either way -- a silent
  // "copied" that actually copied nothing would be worse than an error.

  async copyStreamLink() {
    const url = streamCopyUrl(this.options.stream || {});
    if (!url) { toast('This source has no stream link to copy.', 'error'); return; }
    try {
      const ok = await window.cocoa.app.writeClipboard(url);
      toast(ok ? 'Stream link copied' : 'Could not copy the stream link.', ok ? 'info' : 'error');
    } catch {
      toast('Could not copy the stream link.', 'error');
    }
  }

  async copyMagnetLink() {
    const magnet = magnetUriFor(this.options.stream || {}, this.options.stream?.name || this.options.stream?.title || '');
    if (!magnet) { toast('This source has no magnet link to copy.', 'error'); return; }
    try {
      const ok = await window.cocoa.app.writeClipboard(magnet);
      toast(ok ? 'Magnet link copied' : 'Could not copy the magnet link.', ok ? 'info' : 'error');
    } catch {
      toast('Could not copy the magnet link.', 'error');
    }
  }

  async openStreamLink() {
    const url = streamCopyUrl(this.options.stream || {});
    if (!url) { toast('This source has no stream link to open.', 'error'); return; }
    await window.cocoa.app.openExternal(url).catch(() => {});
  }

  async openSubtitleLink() {
    const sub = this.selectedAddonSubtitle();
    if (!sub?.url) { toast('Select a subtitle first.', 'error'); return; }
    await window.cocoa.app.openExternal(sub.url).catch(() => {});
  }

  // The add-on subtitle the user picked, if the current selection is one we
  // hold a URL for. A container track (muxed into the file) has no add-on URL,
  // so it legitimately returns null here rather than inventing one.
  selectedAddonSubtitle() {
    if (!this.selectedSubtitleKey.startsWith('addon:')) return null;
    const index = Number(this.selectedSubtitleKey.slice('addon:'.length));
    return Number.isInteger(index) ? this.options.subtitles?.[index] || null : null;
  }

  bindEngineStatus() {
    // Just rotates the fun headline on real engine progress so it doesn't
    // look frozen -- the engine's own message text is intentionally never
    // shown (no peer counts / stage names in the UI).
    this.offEngineStatus = window.cocoa.playback.onEngineStatus?.(detail => {
      if (this.destroyed || !detail) return;
      if (detail.type === 'torrent-stage') this.setLoading(randomOf(HUNTING_LINES));
    });
  }

  recordFailure(message) {
    if (!Array.isArray(this.options.failureHistory)) return;
    this.options.failureHistory.push({
      source: sourceLabel(this.options.stream),
      addon: this.options.stream?.addonName || '',
      message: String(message || 'Source failed').replace(/\s+/g, ' ').slice(0, 380)
    });
    if (this.options.failureHistory.length > 20) this.options.failureHistory.splice(0, this.options.failureHistory.length - 20);
  }

  failureSummary(lastMessage) {
    const failures = Array.isArray(this.options.failureHistory) ? this.options.failureHistory : [];
    if (failures.length < 2) return lastMessage;
    const unique = [];
    const seen = new Set();
    for (const failure of failures.slice(-8).reverse()) {
      if (seen.has(failure.message)) continue;
      seen.add(failure.message);
      unique.push(failure);
      if (unique.length >= 3) break;
    }
    const detail = unique.map(failure => `• ${failure.source}: ${failure.message}`).join('\n');
    return `CocoaStream tried ${failures.length} source${failures.length === 1 ? '' : 's'} and none opened.\n\n${detail}\n\nA detailed playback log was saved automatically.`;
  }

  bindNativeEvents() {
    this.offNativeClosed = window.cocoa.playback.onNativeClosed?.(detail => {
      if (this.destroyed || detail?.ownerId !== this.ownerId) return;
      this.nativeStats = { ...this.nativeStats, ...detail };
      this.saveProgress(true).finally(() => this.close(false, true));
    });
    this.offNativeEnded = window.cocoa.playback.onNativeEnded?.(async detail => {
      if (this.destroyed || detail?.ownerId !== this.ownerId) return;
      this.nativeStats = { ...this.nativeStats, ...detail };
      await this.saveProgress(true, true).catch(() => {});
      if (this.options.preferences?.autoplayNext && this.options.hasNext) {
        const next = this.options.onNext;
        await this.close(false, true);
        next?.();
      } else {
        await this.close(false, true);
      }
    });
    this.offNativeStats = window.cocoa.playback.onNativeStats?.(stats => {
      if (this.destroyed || !stats || stats.ownerId !== this.ownerId) return;
      this.nativeStats = { ...this.nativeStats, ...stats };
    });
    this.offNativeError = window.cocoa.playback.onNativeError?.(detail => {
      if (this.destroyed || detail?.ownerId !== this.ownerId) return;
      this.markPlaybackResult(false);
      const message = detail?.message || 'The native player could not continue this source.';
      this.recordFailure(message);
      if (this.options.preferences?.autoTryNextSource !== false && this.options.onTryNextSource) {
        toast('That one flopped. Trying the next best source…');
        const next = this.options.onTryNextSource;
        this.close(false, true).then(() => next?.());
      } else {
        toast(this.failureSummary(message), 'error');
        this.close(false, true);
      }
    });
    this.offSafetyStop = window.cocoa.playback.onSafetyStop?.(detail => {
      if (this.destroyed) return;
      this.markPlaybackResult(false);
      const safetyMessage = detail?.reason || 'Torrent playback stopped because the protected route changed.';
      this.recordFailure(safetyMessage);
      toast(safetyMessage, 'error');
      if (this.options.preferences?.autoTryNextSource !== false && this.options.onTryNextSource) {
        const next = this.options.onTryNextSource;
        this.close(false, true).then(() => next?.());
      } else {
        this.close(false, true);
      }
    });
  }

  // Preferred-language-first, matching the reference player's own subtitle menu ordering
  // -- `index` is always the REAL position in options.subtitles (what
  // selectSubtitle() expects), independent of display order, so sorting
  // here never breaks selection.
  // The subtitle menu is built from what mpv ACTUALLY has, merged with the
  // add-on list. Sam's real-app report: "subtitles don't actually turn off or
  // switch tracks". Three causes, all fixed here:
  //   1. every selection ran `sub-add`, which APPENDS a new track instead of
  //      switching, so choosing a second subtitle piled up duplicates;
  //   2. subtitles muxed into the file were invisible -- they were never in
  //      the add-on list, so they could not be chosen at all;
  //   3. the menu's idea of the current selection was pinned to -1, so it
  //      always redrew as "Off" even when a track was showing.
  // Rows carry a stable `key` (not a position) so a track-list update between
  // render and click cannot make a click select the wrong row. `active` comes
  // from mpv's observed `sid`, which is the only honest source of truth.
  subtitleRows() {
    const addons = Array.isArray(this.options.subtitles) ? this.options.subtitles : [];
    const tracks = Array.isArray(this.nativeStats?.subtitleTracks) ? this.nativeStats.subtitleTracks : [];
    const activeId = Number(this.nativeStats?.subtitleId ?? -1);
    // A track we added via `sub-add` carries the title we passed, so an exact
    // title match is a reliable "this add-on row is already a real track".
    const loadedTitles = new Set(tracks.filter(track => track.external).map(track => String(track.label || '').toLowerCase()));
    const rows = tracks.map(track => ({
      key: `mpv:${track.id}`,
      kind: 'mpv',
      id: track.id,
      addonIndex: -1,
      label: track.label,
      lang: String(track.lang || '').toLowerCase(),
      active: track.id === activeId
    }));
    addons.forEach((sub, index) => {
      const label = subtitleName(sub, index);
      if (loadedTitles.has(label.toLowerCase())) return;
      rows.push({
        key: `addon:${index}`,
        kind: 'addon',
        id: -1,
        addonIndex: index,
        label,
        lang: String(sub.lang || sub.language || '').toLowerCase(),
        active: false
      });
    });
    const preferred = String(this.options.preferences?.subtitleLanguage || '').toLowerCase().slice(0, 2);
    // Display order only: container tracks keep mpv's own order, add-on rows
    // are sorted preferred-language-first. Keys are unaffected by sorting.
    const container = rows.filter(row => row.kind === 'mpv');
    const addonRows = rows.filter(row => row.kind === 'addon').sort((a, b) => {
      const aPreferred = preferred && a.lang.startsWith(preferred) ? 0 : 1;
      const bPreferred = preferred && b.lang.startsWith(preferred) ? 0 : 1;
      if (aPreferred !== bPreferred) return aPreferred - bPreferred;
      return a.label.localeCompare(b.label);
    });
    return [...container, ...addonRows];
  }
  // The stable key of whatever is currently showing, for the overlay's
  // checked row. Empty string means subtitles are off.
  activeSubtitleKey() {
    return this.subtitleRows().find(row => row.active)?.key || '';
  }

  syncOverlaySubtitles() {
    if (!this.overlayOpen) return;
    // The options menu depends on the current subtitle selection (the
    // "Download Subtitles" row only exists once one is chosen), so it is
    // re-sent alongside the list rather than only at overlay-open time.
    window.cocoa.overlay.sync({
      subtitles: this.subtitleRows(),
      subtitleKey: this.activeSubtitleKey(),
      optionsMenu: this.optionsMenuItems()
    }).catch(() => {});
  }

  setSubtitles(subtitles = []) {
    if (this.destroyed) return;
    this.options.subtitles = Array.isArray(subtitles) ? subtitles : [];
    this.syncOverlaySubtitles();
    // Subtitles are added to mpv ON DEMAND, when the user actually picks one,
    // never bulk-loaded. The old code pushed up to 24 `sub-add` commands on
    // every load, which is where the duplicate-track pile-up came from and
    // which made "switch track" meaningless (every track was "new").
    if (this.nativeMode) {
      // Honour a remembered language once, by selecting the matching row --
      // still a single add, through the same path a manual pick takes.
      if (this.options.subtitles.length && !this.selectedSubtitleKey) this.applyPreferredSubtitle();
      return;
    }
    if (this.options.subtitles.length) this.applyPreferredSubtitle();
  }

  applyPreferredSubtitle() {
    const prefs = this.options.preferences || {};
    if (!prefs.rememberSubtitle || !this.options.subtitles?.length) return;
    const wanted = String(prefs.subtitleLanguage || 'eng').toLowerCase();
    const index = this.options.subtitles.findIndex(sub => {
      const lang = String(sub.lang || sub.language || '').toLowerCase();
      return lang === wanted || lang.startsWith(wanted.slice(0, 2));
    });
    if (index >= 0) this.selectSubtitle(`addon:${index}`);
  }

  // Selection is by STABLE KEY, not array position: `mpv:<id>` switches to a
  // track that already exists, `addon:<n>` adds the add-on subtitle once and
  // then selects the real track id mpv reports back. Nothing here appends a
  // duplicate when the user just wants to switch.
  async selectSubtitle(key) {
    this.selectedSubtitleKey = String(key || '');
    if (this.nativeMode) {
      if (!this.selectedSubtitleKey) {
        await window.cocoa.playback.nativeSelectSubtitle(-1, this.ownerId).catch(() => {});
        this.syncOverlaySubtitles();
        return;
      }
      const row = this.subtitleRows().find(candidate => candidate.key === this.selectedSubtitleKey);
      if (!row) return;
      try {
        if (row.kind === 'mpv') {
          await window.cocoa.playback.nativeSelectSubtitle(row.id, this.ownerId);
        } else {
          const sub = this.options.subtitles?.[row.addonIndex];
          if (!sub?.url) return;
          await window.cocoa.playback.nativeAddSubtitle({
            url: sub.url,
            title: subtitleName(sub, row.addonIndex),
            lang: String(sub.lang || sub.language || ''),
            select: true
          });
          if (this.options.preferences?.rememberSubtitle && sub.lang) this.options.onSubtitleLanguage?.(sub.lang);
        }
      } catch (error) {
        toast(`Subtitle failed: ${error.message}`, 'error');
      }
      // mpv's observed `sid` decides what the menu shows next; nothing here
      // guesses. The stats tick will re-sync the overlay.
      this.syncOverlaySubtitles();
      return;
    }
    if (!this.selectedSubtitleKey) {
      this.clearSubtitle();
      return;
    }
    const row = this.subtitleRows().find(candidate => candidate.key === this.selectedSubtitleKey);
    this.clearSubtitle();
    if (!row || row.kind !== 'addon') return;
    const sub = this.options.subtitles?.[row.addonIndex];
    if (!sub?.url) return;
    try {
      const vtt = await window.cocoa.playback.subtitle(sub.url, sub.headers || {});
      const blob = new Blob([vtt], { type: 'text/vtt' });
      this.subtitleBlob = URL.createObjectURL(blob);
      this.trackEl = document.createElement('track');
      this.trackEl.kind = 'subtitles';
      this.trackEl.label = subtitleName(sub, row.addonIndex);
      this.trackEl.srclang = String(sub.lang || sub.language || 'en').slice(0, 2);
      this.trackEl.src = this.subtitleBlob;
      this.trackEl.default = true;
      this.video.appendChild(this.trackEl);
      this.trackEl.addEventListener('load', () => {
        for (const track of this.video.textTracks) track.mode = track === this.trackEl.track ? 'showing' : 'disabled';
      });
      if (this.options.preferences?.rememberSubtitle && sub.lang) {
        this.options.onSubtitleLanguage?.(sub.lang);
      }
    } catch (error) {
      toast(`Subtitle failed: ${error.message}`, 'error');
    }
  }

  clearSubtitle() {
    if (this.trackEl) this.trackEl.remove();
    if (this.subtitleBlob) URL.revokeObjectURL(this.subtitleBlob);
    this.trackEl = null;
    this.subtitleBlob = null;
    if (this.video) for (const track of this.video.textTracks) track.mode = 'disabled';
  }

  onKey(event) {
    if (this.destroyed) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target?.tagName)) return;
    // NOTE: the "keyboard interaction shows the chrome" signal (1c contract)
    // is reported once, from the always-loaded app shell (see app.js) -- not
    // here -- so it works even when no CocoaPlayer exists. This handler owns
    // only the playback shortcuts below.
    // IMPORTANT (regression fixed 2026-09): keyboard shortcuts must be
    // handled HERE during native playback too. This used to bail out with
    // "the overlay window owns keyboard shortcuts while it is open" -- but
    // the overlay is shown with showInactive() and is deliberately
    // non-focusable (see controls-overlay.mjs), so it never receives OS key
    // events at all. The result was that during native playback NOTHING
    // handled the keyboard: Space, the arrow keys, M and F were all dead
    // until the user happened to click something. The main window is the
    // real foreground window throughout native playback, so it is the one
    // that actually receives these events -- and it drives mpv over the
    // same IPC path the overlay uses, so a key here reaches mpv exactly
    // once, with no double-fire against the overlay's own listener.
    if (this.nativeMode) {
      // While the subtitle language search is open, letters are search text
      // (the overlay gets them via app.js), not playback shortcuts.
      if (this.subtitleSearchOpen && (event.key?.length === 1 || event.key === 'Backspace')) return;
      if (event.code === 'Space') { event.preventDefault(); this.nativeCommand(['cycle', 'pause']).catch(() => {}); }
      else if (event.code === 'ArrowLeft') { event.preventDefault(); this.nativeCommand(['seek', -10, 'relative+exact']).catch(() => {}); }
      else if (event.code === 'ArrowRight') { event.preventDefault(); this.nativeCommand(['seek', 10, 'relative+exact']).catch(() => {}); }
      else if (event.code === 'ArrowUp') { event.preventDefault(); this.nativeCommand(['add', 'volume', 5]).catch(() => {}); }
      else if (event.code === 'ArrowDown') { event.preventDefault(); this.nativeCommand(['add', 'volume', -5]).catch(() => {}); }
      else if (event.key?.toLowerCase() === 'm') this.nativeCommand(['cycle', 'mute']).catch(() => {});
      else if (event.key?.toLowerCase() === 'c') this.nativeCommand(['cycle', 'sub-visibility']).catch(() => {});
      else if (event.key?.toLowerCase() === 'b') this.nativeCommand(['cycle', 'aid']).catch(() => {});
      else if (event.key?.toLowerCase() === 'f') {
        if (document.fullscreenElement) document.exitFullscreen();
        else this.root.requestFullscreen().catch(() => {});
      } else if (event.key === 'Escape' && !document.fullscreenElement) this.close();
      return;
    }
    if (event.code === 'Space') { event.preventDefault(); if (this.video.paused) this.video.play().catch(() => {}); else this.video.pause(); }
    if (event.code === 'ArrowLeft' && Number.isFinite(this.video.duration)) { event.preventDefault(); this.video.currentTime = Math.max(0, this.video.currentTime - 10); }
    if (event.code === 'ArrowRight' && Number.isFinite(this.video.duration)) { event.preventDefault(); this.video.currentTime = Math.min(this.video.duration, this.video.currentTime + 10); }
    if (event.key?.toLowerCase() === 'm') this.video.muted = !this.video.muted;
    if (event.key?.toLowerCase() === 'f') { if (document.fullscreenElement) document.exitFullscreen(); else this.root.requestFullscreen().catch(() => {}); }
    if (event.key === 'Escape' && !document.fullscreenElement) this.close();
  }

  startProgressLoop() {
    this.progressTimer = setInterval(() => this.saveProgress(false), 5000);
  }

  async saveProgress(force = false, ended = false) {
    const now = Date.now();
    if (!force && now - this.lastSaved < 4500) return;
    this.lastSaved = now;
    if (this.nativeMode) {
      const duration = Number(this.nativeStats?.duration || 0);
      const position = Number(this.nativeStats?.position || 0);
      if (duration < 1) return;
      // Last five minutes: let the app get the next episode's source ready.
      if (!this.nextWarmed && duration - position < 300 && duration - position > 0) {
        this.nextWarmed = true;
        this.options.onNearEnd?.();
      }
      await this.options.onProgress?.({ position: ended ? duration : position, duration, ended });
      return;
    }
    if (!this.video || !Number.isFinite(this.video.duration) || this.video.duration < 1) return;
    await this.options.onProgress?.({
      position: ended ? this.video.duration : this.video.currentTime,
      duration: this.video.duration,
      ended
    });
  }

  setLoading(headline) {
    const box = $('[data-role="loading"]', this.root);
    const headlineEl = $('[data-role="loading-text"]', this.root);
    if (headlineEl) headlineEl.textContent = headline || randomOf(HUNTING_LINES);
    box?.classList.remove('hidden');
  }

  hideLoading() {
    $('[data-role="loading"]', this.root)?.classList.add('hidden');
  }

  markPlaybackResult(success) {
    if (this.playbackResultReported) return;
    this.playbackResultReported = true;
    this.options.onPlaybackResult?.(Boolean(success), this.options.stream);
  }

  // Casting lives in the overlay window (the only surface above mpv's video;
  // see overlay.js's renderCastMenu). The picker used to be a DOM modal here,
  // which is why Sam's real-app test saw "Cast button does nothing" -- the
  // modal was painted behind the video and the picker closed the overlay to
  // make room for itself. The main window's only remaining cast duty is the
  // local half of the handoff: pause our own playback when the remote starts
  // (contract: "local pause on remote start").
  onCastStarted(deviceId) {
    if (this.destroyed) return;
    this.castDeviceId = deviceId || '';
    if (this.nativeMode) this.nativeCommand(['set_property', 'pause', true]).catch(() => {});
    else this.video?.pause?.();
  }

  // --- In-player source switching (Sam: the Sources button used to exit
  // playback and go home). The list is Fetched and ranked by app.js, which
  // owns the add-on client and the ranking pipeline; this class only asks for
  // it and relays the user's pick. Nothing is re-implemented here.
  async requestSources() {
    if (this.destroyed || !this.options.onRequestSources) return;
    try {
      const payload = await this.options.onRequestSources();
      if (this.destroyed) return;
      this.overlaySourcesSync(payload?.sources || [], payload?.sourceIndex ?? -1,payload?.sourcesError||'');
    } catch (error) {
      if (this.destroyed) return;
      window.cocoa.overlay.sync({ sources: [], sourcesError: error?.message || 'Could not load sources.' }).catch(() => {});
    }
  }

  overlaySourcesSync(sources, sourceIndex, sourcesError='') {
    window.cocoa.overlay.sync({ sources, sourceIndex, sourcesError }).catch(() => {});
  }

  selectSourceByIndex(index) {
    if (this.destroyed || !Number.isInteger(index) || index < 0) return;
    this.options.onSelectSource?.(index);
  }

  showError(message) {
    if (!this.root || this.destroyed) return;
    this.hideLoading();
    let error = $('.player-error', this.root);
    if (!error) {
      error = document.createElement('div');
      error.className = 'player-error';
      this.root.appendChild(error);
    }
    error.innerHTML = `
      <div style="max-width:650px">
        <strong>Playback hit a problem</strong>
        <div class="muted" style="white-space:pre-line;line-height:1.55;font-family:inherit">${escapeHtml(message)}</div>
        <div style="display:flex;justify-content:center;gap:9px;margin-top:22px;flex-wrap:wrap">
          ${this.options.onTryNextSource ? '<button class="solid-btn" data-error-next>Try next best</button>' : ''}
          <button class="ghost-btn" data-error-source>Choose another source</button>
          <button class="ghost-btn" data-error-close>Back</button>
        </div>
      </div>`;
    const next = $('[data-error-next]', error);
    if (next) next.onclick = async () => {
      const callback = this.options.onTryNextSource;
      await this.close(false);
      callback?.();
    };
    $('[data-error-source]', error).onclick = async () => {
      const callback = this.options.onChangeSource;
      await this.close(false);
      callback?.();
    };
    $('[data-error-close]', error).onclick = () => this.close();
  }

  async close(save = true, nativeAlreadyClosed = false) {
    if (this.destroyed) return;
    this.destroyed = true;
    if (save) await this.saveProgress(true).catch(() => {});
    clearInterval(this.progressTimer);
    clearInterval(this.statsTimer);
    clearInterval(this.bufferTimer);
    document.removeEventListener('keydown', this.boundKey);
    this.offNativeClosed?.(); this.offNativeClosed = null;
    this.offNativeEnded?.(); this.offNativeEnded = null;
    this.offNativeStats?.(); this.offNativeStats = null;
    this.offNativeError?.(); this.offNativeError = null;
    this.offSafetyStop?.(); this.offSafetyStop = null;
    this.offEngineStatus?.(); this.offEngineStatus = null;
    this.offOverlayAction?.(); this.offOverlayAction = null;
    if (this.overlayOpen) await window.cocoa.overlay.close().catch(() => {});
    this.overlayOpen = false;
    if (this.nativeRequested && !nativeAlreadyClosed) await window.cocoa.playback.nativeStop(this.ownerId).catch(() => {});
    this.nativeMode = false;
    this.clearSubtitle();
    try { this.hls?.destroy(); } catch {}
    try { this.video?.pause(); } catch {}
    if (this.directBufferId) {
      await window.cocoa.playback.directBufferStop(this.directBufferId).catch(() => {});
      this.directBufferId = null;
    }
    if (this.hlsProxyId) {
      await window.cocoa.playback.hlsProxyStop(this.hlsProxyId).catch(() => {});
      this.hlsProxyId = null;
    }
    this.root?.remove();
    this.options.onClose?.();
  }
}

let languageNames = null;
function languageDisplayName(code) {
  const trimmed = String(code || '').trim();
  if (!trimmed) return '';
  try {
    if (!languageNames) languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
    const name = languageNames.of(trimmed.slice(0, 2).toLowerCase());
    if (name && name.toLowerCase() !== trimmed.toLowerCase()) return name;
  } catch {}
  return trimmed.toUpperCase();
}

// "English", "English • OpenSubtitles" -- readable language name first
// (the reference player's own subtitle menu convention), addon/provider only appended
// when it adds real information beyond the language itself.
function subtitleName(sub, index) {
  const lang = languageDisplayName(sub.lang || sub.language) || 'Subtitle';
  const provider = sub.addonName || sub.name || sub.id || '';
  return [lang, provider && provider.toLowerCase() !== lang.toLowerCase() ? provider : ''].filter(Boolean).join(' • ') || `Subtitle ${index + 1}`;
}
