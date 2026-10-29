function $(selector, root = document) { return root.querySelector(selector); }
function $$(selector, root = document) { return Array.from(root.querySelectorAll(selector)); }

function formatTime(seconds) {
  seconds = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

const state = {
  ownerId: '',
  paused: false,
  muted: false,
  volume: 100,
  speed: 1,
  position: 0,
  duration: 0,
  subtitles: [],
  // Stable key of the showing subtitle (`mpv:<id>` / `addon:<n>`), or '' for
  // off. Comes from player.js, which takes it from mpv's observed `sid` --
  // the overlay never infers the selection from a list position.
  subtitleKey: '',
  subsOpen: false,
  subsFilter: '',
  subScale: 1,
  subDelay: 0,
  audioTracks: [],
  optionsMenu: [],
  hasNext: false,
  scrubbing: false,
  fullscreen: false,
  episodes: [],
  episodeIndex: -1,
  // Cast picker state. Discovery runs in the OVERLAY window (see
  // renderCastMenu) because that window is the only surface above the mpv
  // video. `castUrl` arrives from player.js in the sync payload: casting
  // needs the direct stream URL, and only the player holds it.
  castUrl: '',
  castStatus: 'idle',
  castError: '',
  castNotice: '',
  castDevices: [],
  castDeviceId: '',
  // In-player source popover. Sam's real-app test: the Sources button used to
  // exit playback and dump him on the home page. The list itself is fetched
  // by the MAIN window (it owns the add-on client and the ranking pipeline)
  // and arrives through overlay.sync, exactly like subtitles/episodes.
  sources: [],
  sourcesStatus: 'idle',
  sourcesError: '',
  sourceIndex: -1
};

let volumeHideTimer = null;

function nativeCommand(command) {
  return window.cocoa.playback.nativeCommand(command, state.ownerId).catch(() => {});
}

// Single coherent controls-visibility state machine. Anything that needs
// the controls to stay up (an open menu, active scrubbing, the video being
// paused) registers a named "hold"; the auto-hide timer only ever runs
// when no hold is active. Replaces the old pattern of independent
// setTimeout()s racing/fighting each other (a sticky-flag hide timer here,
// a separate volume-slider hide timer, an implicit "menu open" state
// nothing actually held) -- the exact class of bug behind controls getting
// stuck open or disappearing while a menu was still open.
const SUB_MARGIN_CONTROLS_VISIBLE = 118; // clears the bottom control bar
const SUB_MARGIN_DEFAULT = 44;

const controlsVisibility = (() => {
  let timer = null;
  let shown = false;
  const holds = new Set();
  // mpv-side repositioning (not a fake DOM subtitle element racing the
  // real one, see the reference player's own approach to this): push subtitles up
  // above the control bar while it's visible, let them settle back down
  // once it fades. Only sent on an actual transition, never per-tick.
  function setShown(next) {
    if (shown === next) return;
    shown = next;
    document.body.classList.toggle('ov-controls-visible', shown);
    nativeCommand(['set_property', 'sub-margin-y', shown ? SUB_MARGIN_CONTROLS_VISIBLE : SUB_MARGIN_DEFAULT]);
  }
  // Only real activity (mouse/key/click) restarts the idle countdown from
  // now. hold()/release() must NOT do that -- onNativeStats calls
  // release('paused') on every single stats tick while playing (several
  // times a second), and this used to unconditionally re-show + reset the
  // timer on every one of those calls (regression found 2026-09: it made
  // the hide timer effectively never fire during real playback, since it
  // kept getting restarted faster than its own 2600ms delay). hold()/
  // release() now only recompute visibility from the current hold set and
  // are no-ops when that set doesn't actually change.
  function scheduleHide() {
    // 3000ms matches the reference player's own player: it debounces `setImmersed` by
    // 3000 (debounce(setImmersed, 3000) in the reference player-web's Player), which is
    // what decides when the chrome fades. The clone used 2600, so controls
    // disappeared noticeably sooner than the real thing (fidelity fix
    // 2026-09). The hold rules (paused / menu open / scrubbing) still match.
    timer = setTimeout(() => { timer = null; setShown(false); }, 3000);
  }
  function activity() {
    setShown(true);
    clearTimeout(timer);
    timer = null;
    if (holds.size > 0) return;
    scheduleHide();
  }
  function recompute() {
    if (holds.size > 0) { setShown(true); clearTimeout(timer); timer = null; return; }
    // A hold just cleared: show once, then let the existing countdown (or
    // a fresh one if none was running) decide when to fade -- not forced
    // fresh activity.
    setShown(true);
    if (!timer) scheduleHide();
  }
  return {
    activity,
    hold(reason) {
      if (holds.has(reason)) return;
      holds.add(reason);
      recompute();
    },
    release(reason) {
      if (!holds.has(reason)) return;
      holds.delete(reason);
      recompute();
    },
    debug: () => ({ shown, holds: [...holds], timerActive: Boolean(timer) })
  };
})();
window.__cocoaOverlayDebug = () => controlsVisibility.debug();
function showControls() { controlsVisibility.activity(); }

function pulseIcon(kind) {
  const el = $('#bigPulse');
  // Same upstream @the reference player/the reference player-icons vectors as the control bar, via the
  // in-document sprite, so the pulse glyph matches the play/pause button.
  el.innerHTML = kind === 'play'
    ? '<svg viewBox="0 0 512 512"><use href="#i-play"/></svg>'
    : '<svg viewBox="0 0 512 512"><use href="#i-pause"/></svg>';
  el.classList.remove('pulse');
  // Force reflow so the animation restarts on rapid re-triggers.
  void el.offsetWidth;
  el.classList.add('pulse');
}

// Never flips `state.paused`/the button icon here -- that used to be an
// optimistic local toggle, which drifts out of sync with mpv's real state
// under rapid clicks, a delayed/failed IPC round-trip, or any other command
// changing pause independently (e.g. auto-pause on window blur). `cycle
// pause` lets mpv itself decide the new value atomically; the button only
// ever updates from the real `pause` property-change event mpv sends back,
// already wired up in onNativeStats below. The center pulse icon is purely
// decorative feedback, not a state indicator, so it's fine to guess its
// direction from the last known state.
function togglePlay() {
  nativeCommand(['cycle', 'pause']);
  pulseIcon(state.paused ? 'play' : 'pause');
}

function seekBy(seconds) {
  nativeCommand(['seek', seconds, 'relative+exact']);
}

// Same reasoning as togglePlay(): let mpv own the toggle and drive the
// button from its real property-change event, not an optimistic guess.
function toggleMute() {
  nativeCommand(['cycle', 'mute']);
}

function setVolume(value) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  state.volume = v;
  state.muted = false;
  nativeCommand(['set_property', 'volume', v]);
  nativeCommand(['set_property', 'mute', false]);
  updateMuteButton();
}

function setSpeed(value) {
  state.speed = value;
  nativeCommand(['set_property', 'speed', value]);
  $('[data-role="speed-label"]').textContent = `${value}×`;
  renderSpeedMenu();
}

// Subtitle appearance controls. These are NOT cosmetic DOM tweaks: each
// nudge issues the real mpv property (`sub-scale` / `sub-delay`), so the
// rendered subtitles actually change size/delay -- and the harness can read
// the same property back to prove the control really worked. mpv's own
// defaults are scale 1.0 and delay 0s, which is what state starts at.
const SUB_SCALE_MIN = 0.5, SUB_SCALE_MAX = 2.0, SUB_SCALE_STEP = 0.1;
const SUB_DELAY_MIN = -10, SUB_DELAY_MAX = 10, SUB_DELAY_STEP = 0.1;

function nudgeSubScale(delta) {
  const next = Math.min(SUB_SCALE_MAX, Math.max(SUB_SCALE_MIN,
    Math.round((state.subScale + delta * SUB_SCALE_STEP) * 100) / 100));
  state.subScale = next;
  nativeCommand(['set_property', 'sub-scale', next]);
  renderCaptionsMenu();
}

function nudgeSubDelay(delta) {
  const next = Math.min(SUB_DELAY_MAX, Math.max(SUB_DELAY_MIN,
    Math.round((state.subDelay + delta * SUB_DELAY_STEP) * 100) / 100));
  state.subDelay = next;
  nativeCommand(['set_property', 'sub-delay', next]);
  renderCaptionsMenu();
}

function stepperRow(label, valueText, attr) {
  return `
    <div class="ov-menu-stepper" data-role="stepper-${attr}">
      <span class="ov-menu-stepper-label">${label}</span>
      <div class="ov-menu-stepper-ctl">
        <button class="ov-step-btn" data-${attr}-delta="-1" title="Decrease ${label}" aria-label="Decrease ${label}">\u2212</button>
        <span class="ov-menu-stepper-value" data-role="${attr}-value">${valueText}</span>
        <button class="ov-step-btn" data-${attr}-delta="1" title="Increase ${label}" aria-label="Increase ${label}">+</button>
      </div>
    </div>`;
}

// Rows are identified by a stable key, never by array position: player.js
// merges mpv's real track list with the add-on list, and that list can change
// between render and click. '' means "off".
function selectSubtitle(key) {
  const wanted = String(key || '');
  // Optimistic only in the sense of "the click was accepted"; the checked row
  // still comes from mpv's observed `sid`, so a selection that mpv refuses
  // (or an added subtitle that fails to load) will correct itself on the next
  // stats tick rather than showing a lie.
  state.subtitleKey = wanted;
  if (wanted === '' || wanted.startsWith('mpv:')) {
    // Switching to a track mpv already has (or turning subtitles off) is
    // self-contained: the track id is mpv's own, so the overlay drives it
    // directly, exactly like the audio-track control. No round-trip through
    // the player window is needed, and none is possible when the player
    // window isn't the one that owns the session.
    const target = wanted === '' ? 'no' : Number(wanted.slice('mpv:'.length));
    nativeCommand(['set_property', 'sid', target]);
  } else {
    // An add-on subtitle has to be fetched and `sub-add`ed, which needs its
    // URL -- only the player window holds that, so this one relays.
    window.cocoa.overlay.sendAction({ action: 'select-subtitle', key: wanted });
  }
  renderCaptionsMenu();
}

function updatePlayButton() {
  const btn = $('[data-role="play-btn"]');
  $('[data-icon="play"]', btn).classList.toggle('hidden', !state.paused);
  $('[data-icon="pause"]', btn).classList.toggle('hidden', state.paused);
}

function updateMuteButton() {
  const btn = $('[data-role="mute-btn"]');
  const level = state.muted || state.volume === 0 ? 'mute' : state.volume < 45 ? 'low' : 'high';
  $('[data-icon="vol-high"]', btn).classList.toggle('hidden', level !== 'high');
  $('[data-icon="vol-low"]', btn).classList.toggle('hidden', level !== 'low');
  $('[data-icon="vol-mute"]', btn).classList.toggle('hidden', level !== 'mute');
  $('[data-role="volume"]').value = String(state.muted ? 0 : state.volume / 100);
}

function updateTimeline() {
  if (state.scrubbing) return;
  const pct = state.duration > 0 ? (state.position / state.duration) * 1000 : 0;
  const timeline = $('[data-role="timeline"]');
  timeline.value = String(pct);
  timeline.style.setProperty('--progress', `${(pct / 1000) * 100}%`);
  $('[data-role="time"]').textContent = `${formatTime(state.position)} / ${formatTime(state.duration)}`;
}

function closeAllMenus() {
  $('[data-role="captions-menu"]').classList.add('hidden');
  $('[data-role="audio-menu"]')?.classList.add('hidden');
  $('[data-role="speed-menu"]').classList.add('hidden');
  $('[data-role="options-menu"]')?.classList.add('hidden');
  $('[data-role="episodes-menu"]')?.classList.add('hidden');
  $('[data-role="cast-menu"]')?.classList.add('hidden');
  $('[data-role="source-menu"]')?.classList.add('hidden');
  if (state.subsOpen) {
    state.subsOpen = false;
    state.subsFilter = '';
    window.cocoa.overlay.sendAction({ action: 'subtitle-search', open: false });
    renderCaptionsMenu();
  }
  controlsVisibility.release('menu');
}

// In-player source popover (Sam: "Sources button wrongly exits playback to go
// home instead of opening an in-player popover"). The list comes from
// app.js's existing ranking pipeline via overlay.sync; choosing a row relays
// the index back so app.js can relaunch with that stream WITHOUT leaving the
// player. Nothing here re-implements source discovery.
function renderSourcesMenu() {
  const menu = $('[data-role="source-menu"]');
  if (!menu) return;
  const parts = ['<div class="ov-menu-title">Sources</div>'];
  if (state.sourcesStatus === 'loading') {
    parts.push('<div class="ov-menu-status">Cocoa is sniffing out sources…</div>');
  } else if (state.sourcesStatus === 'error') {
    parts.push(`<div class="ov-menu-status ov-menu-status-error">${escapeHtml(state.sourcesError || 'Could not load sources.')}</div>`);
  } else if (state.sourcesStatus === 'empty') {
    parts.push(`<div class="ov-menu-status">${escapeHtml(state.sourcesError || 'No usable sources returned.')}</div>`);
  }
  state.sources.forEach((source, index) => {
    const active = index === state.sourceIndex;
    const badges = [
      source.best ? '<span class="ov-menu-sub">BEST</span>' : '',
      source.quality ? `<span class="ov-menu-sub">${escapeHtml(source.quality)}</span>` : '',
      source.size ? `<span class="ov-menu-sub">${escapeHtml(source.size)}</span>` : ''
    ].filter(Boolean).join(' · ');
    parts.push(`<button class="ov-menu-option${active ? ' active' : ''}" data-source-pick="${index}" title="${escapeHtml(source.label || '')}">
      <span><span>${escapeHtml(source.label || 'Source')}</span>${badges ? `<br><span class="ov-menu-sub">${badges}</span>` : ''}</span>
    </button>`);
  });
  menu.innerHTML = parts.join('');
}

// Cast picker. Sam's real-app test: "Cast button does nothing". The old
// picker was a DOM modal in the MAIN window, which during native playback is
// painted behind mpv's raw child video surface -- the modal existed, it was
// simply never visible (and it closed this overlay to make room). Rendering
// it here, in the window that is genuinely above the video, is the fix; the
// same reasoning applies to every status message, so they are shown in-menu
// rather than as a main-window toast.
async function renderCastMenu() {
  const menu = $('[data-role="cast-menu"]');
  if (!menu) return;
  const parts = ['<div class="ov-menu-title">Cast to a device</div>'];
  if (state.castStatus === 'discovering') {
    parts.push('<div class="ov-menu-status">Looking for TVs and AirPlay devices…</div>');
  } else if (state.castStatus === 'error') {
    parts.push(`<div class="ov-menu-status ov-menu-status-error">${escapeHtml(state.castError || 'Discovery failed.')}</div>`);
  } else if (state.castStatus === 'empty') {
    parts.push('<div class="ov-menu-status">No TVs or AirPlay devices found on this network.</div>');
  }
  if (state.castNotice) {
    parts.push(`<div class="ov-menu-status">${escapeHtml(state.castNotice)}</div>`);
  }
  for (const device of state.castDevices) {
    const protocol = device.protocol === 'airplay' ? 'AirPlay'
      : device.protocol === 'chromecast' ? 'Chromecast' : 'DLNA / smart TV';
    const active = state.castDeviceId && state.castDeviceId === device.id;
    parts.push(`<button class="ov-menu-option ov-menu-option-icon${active ? ' active' : ''}" data-cast-device="${escapeHtml(device.id)}">
      <span class="ov-menu-check"><svg viewBox="0 0 512 512"><use href="#i-cast"/></svg></span>
      <span><span>${escapeHtml(device.name)}</span><br><span class="ov-menu-sub">${protocol}</span></span>
    </button>`);
  }
  menu.innerHTML = parts.join('');
}

// Discovery is genuinely async and can be slow (SSDP/MDNS). Guard against a
// stale run repainting a menu the user has since closed or re-opened.
let castDiscoverToken = 0;

async function openCastPicker() {
  const menu = $('[data-role="cast-menu"]');
  if (!menu) return;
  if (!state.castUrl) {
    // Say WHY, in the surface the user can actually see.
    state.castDevices = [];
    state.castStatus = 'error';
    state.castError = 'This source has no direct URL to cast yet.';
    renderCastMenu();
    return;
  }
  if (!state.castDevices.length) state.castStatus = 'discovering';
  state.castError = '';
  renderCastMenu();
  const token = ++castDiscoverToken;
  let devices = [];
  try {
    devices = await window.cocoa.cast.discover();
  } catch (error) {
    if (token !== castDiscoverToken) return;
    state.castDevices = [];
    state.castStatus = 'error';
    state.castError = error?.message || 'Discovery failed.';
    renderCastMenu();
    return;
  }
  if (token !== castDiscoverToken) return;
  state.castDevices = Array.isArray(devices) ? devices : [];
  state.castStatus = state.castDevices.length ? 'ready' : 'empty';
  renderCastMenu();
}

async function castToDevice(deviceId) {
  const device = state.castDevices.find(d => d.id === deviceId);
  if (!device) return;
  state.castDeviceId = deviceId;
  state.castNotice = `Connecting to ${device.name}…`;
  renderCastMenu();
  try {
    await window.cocoa.cast.play({
      deviceId,
      url: state.castUrl,
      title: $('[data-role="title"]')?.textContent || 'CocoaStream'
    });
    state.castNotice = `Casting to ${device.name}.`;
    // Ask the main window to pause the local copy -- the contract's "local
    // pause on remote start".
    window.cocoa.overlay.sendAction({ action: 'cast-started', deviceId });
  } catch (error) {
    state.castDeviceId = '';
    state.castNotice = '';
    state.castStatus = 'error';
    state.castError = `Cast failed: ${error?.message || 'unknown error'}`;
  }
  renderCastMenu();
}

let languageNames = null;
try { languageNames = new Intl.DisplayNames(['en'], { type: 'language' }); } catch {}
// OpenSubtitles' own codes that are not ISO, mapped to ones Intl knows.
const LANGUAGE_ALIASES = { pob: 'pt-BR', zht: 'zh-Hant', zhs: 'zh-Hans', chi: 'zh', ze: 'zh', spn: 'es', scc: 'sr', sx: 'sr' };
function languageName(code) {
  const raw = String(code || '').trim().toLowerCase();
  const lang = LANGUAGE_ALIASES[raw] || raw;
  if (!lang) return 'Other';
  try { return languageNames?.of(lang) || lang.toUpperCase(); } catch { return lang.toUpperCase(); }
}

function renderCaptionsMenu() {
  const menu = $('[data-role="captions-menu"]');
  // Each row carries a STABLE KEY (mpv track id or add-on index) rather than a
  // list position, so a track-list change between render and click cannot make
  // a click select the wrong subtitle. The checked row is the one whose key
  // matches mpv's live `sid`.
  const current = state.subtitles.find(row => row.key === state.subtitleKey);
  const option = row => `
    <button class="ov-menu-option${row.key === state.subtitleKey ? ' active' : ''}" data-subtitle-key="${escapeHtml(row.key)}">
      <span class="ov-menu-check">${row.key === state.subtitleKey ? checkIconSvg() : ''}</span>${escapeHtml(row.label)}
    </button>`;
  // One collapsed line until opened (Sam, Oct 29): the full list, grouped by
  // language, with type-to-search. The overlay can't take focus, so the main
  // window forwards each key press here (onActivity).
  let list = `<button class="ov-menu-option ov-subs-head" data-subs-toggle>
      <span class="ov-menu-check">${state.subsOpen ? '&#9662;' : '&#9656;'}</span>Subtitles: ${escapeHtml(current ? current.label : 'Off')}
    </button>`;
  if (state.subsOpen) {
    const needle = state.subsFilter.toLowerCase();
    const groups = new Map();
    for (const row of state.subtitles) {
      const name = languageName(row.lang);
      if (needle && !`${name} ${row.label}`.toLowerCase().includes(needle)) continue;
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(row);
    }
    const ordered = [...groups].sort(([a], [b]) => (a === 'English' ? -1 : b === 'English' ? 1 : a.localeCompare(b)));
    list += `<div class="ov-subs-search">${state.subsFilter ? `Search: <b>${escapeHtml(state.subsFilter)}</b>` : 'Type to search languages'}</div>
      <div class="ov-subs-list">${needle ? '' : option({ label: 'Off', key: '' })}${ordered.map(([name, rows]) =>
        `<div class="ov-menu-sub ov-subs-lang">${escapeHtml(name)} <span>${rows.length}</span></div>${rows.map(option).join('')}`).join('')
        || '<div class="ov-menu-status">No match</div>'}</div>`;
  }
  // Size + delay steppers, mirroring the reference player's subtitle settings panel.
  // They stay available even with no subtitle selected, so a user can set
  // them up before turning subtitles on.
  const settings = `<div class="ov-menu-title">Subtitle settings</div>`
    + stepperRow('Size', `${Math.round(state.subScale * 100)}%`, 'subscale')
    + stepperRow('Delay', `${state.subDelay >= 0 ? '+' : ''}${state.subDelay.toFixed(1)}s`, 'subdelay');
  menu.innerHTML = state.subtitles.length
    ? list + settings
    : '<div class="ov-menu-title">No subtitles found for this source</div>' + settings;
}

// Audio tracks come straight from mpv's own `track-list` (see
// native-player.mjs's normalizeAudioTracks): each row already carries its
// real mpv track id, so selecting one is `set_property aid <id>` -- no
// invented index, no guessing which stream the user actually picked.
function renderAudioMenu() {
  const menu = $('[data-role="audio-menu"]');
  if (!menu) return;
  const tracks = state.audioTracks;
  if (!tracks.length) { menu.innerHTML = '<div class="ov-menu-title">No other audio tracks</div>'; return; }
  menu.innerHTML = tracks.map(track => `
    <button class="ov-menu-option${track.selected ? ' active' : ''}" data-audio-id="${track.id}">
      <span class="ov-menu-check">${track.selected ? checkIconSvg() : ''}</span>${escapeHtml(track.label)}
    </button>`).join('');
}

function selectAudioTrack(id) {
  if (!Number.isFinite(id) || id <= 0) return;
  nativeCommand(['set_property', 'aid', id]);
  // Optimistic local update so the checkmark moves immediately; the
  // authoritative `track-list` observation confirms it a moment later.
  state.audioTracks = state.audioTracks.map(track => ({ ...track, selected: track.id === id }));
  renderAudioMenu();
}

// Options menu -- upstream the reference player's player overflow menu (Copy Stream Link
// / Copy Magnet Link / Download Subtitles). The rows come from player.js as
// plain data (lib.js's optionsMenuModel), which already omits any row whose
// backing value doesn't exist, so there is never a dead option here. Each
// row's icon is an inline <use> against the shared sprite -- same sprite the
// control bar uses, so the iconography stays consistent.
function renderOptionsMenu() {
  const menu = $('[data-role="options-menu"]');
  if (!menu) return;
  const items = state.optionsMenu;
  if (!items.length) { menu.innerHTML = '<div class="ov-menu-title">No options for this source</div>'; return; }
  menu.innerHTML = items.map(item => `
    <button class="ov-menu-option ov-menu-option-icon" data-option-id="${escapeHtml(item.id)}">
      <span class="ov-menu-check"><svg viewBox="0 0 512 512"><use href="#i-${escapeHtml(item.icon)}"/></svg></span>${escapeHtml(item.label)}
    </button>`).join('');
}

function renderSpeedMenu() {
  const menu = $('[data-role="speed-menu"]');
  menu.innerHTML = SPEEDS.map(value => `
    <button class="ov-menu-option${value === state.speed ? ' active' : ''}" data-speed-value="${value}">
      <span class="ov-menu-check">${value === state.speed ? checkIconSvg() : ''}</span>${value}×${value === 1 ? ' (normal)' : ''}
    </button>`).join('');
}

function episodeLabel(ep) {
  const s = ep.season, e = ep.episode;
  return s != null && e != null ? `S${s}E${e}` : (ep.name || 'Episode');
}

// Nearby-episodes window (the reference player's player episode menu doesn't show a full
// season grid either) rather than one enormous list -- current episode
// plus a handful before/after, always including the very first and the
// current one so short lists never look truncated oddly.
function renderEpisodesMenu() {
  const menu = $('[data-role="episodes-menu"]');
  if (!menu) return;
  const list = state.episodes;
  if (!list.length) { menu.innerHTML = '<div class="ov-menu-title">No other episodes</div>'; return; }
  const WINDOW = 6;
  const start = Math.max(0, Math.min(state.episodeIndex - Math.floor(WINDOW / 2), list.length - WINDOW));
  const visible = list.slice(Math.max(0, start), start + WINDOW);
  menu.innerHTML = visible.map(ep => {
    const idx = list.indexOf(ep);
    const active = idx === state.episodeIndex;
    return `
    <button class="ov-menu-option ov-episode-option${active ? ' active' : ''}" data-episode-id="${escapeHtml(ep.id)}">
      <span class="ov-menu-check">${active ? checkIconSvg() : ''}</span>
      <span class="ov-episode-meta">
        <span class="ov-episode-num">${escapeHtml(episodeLabel(ep))}</span>
        ${ep.name ? `<span class="ov-episode-title">${escapeHtml(ep.name)}</span>` : ''}
      </span>
    </button>`;
  }).join('');
}

function checkIconSvg() {
  return '<svg viewBox="0 0 512 512" width="15" height="15"><use href="#i-checkmark"/></svg>';
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bindEvents() {
  const hit = $('#hit');
  hit.addEventListener('mousemove', () => showControls());
  hit.addEventListener('click', event => {
    if (event.detail > 1) return; // let dblclick handle multi-clicks
    closeAllMenus();
    showControls();
    // Clicking the picture toggles playback, the way the reference player and every
    // mobile player behave. It calls the same toggle as the Play button,
    // so there is one pause path (native mpv pause + overlay state).
    togglePlay();
  });
  hit.addEventListener('dblclick', () => window.cocoa.overlay.sendAction({ action: 'toggle-fullscreen' }));
  document.addEventListener('mousemove', () => showControls());

  document.body.addEventListener('click', event => {
    // Menu options (subtitle/speed picks) don't carry data-action -- they
    // must be checked before the data-action branch below, which used to
    // `return` early for exactly these clicks and made every option a dead
    // click (menus opened and displayed fine, but nothing was selectable).
    if (event.target.closest('[data-subs-toggle]')) {
      state.subsOpen = !state.subsOpen;
      state.subsFilter = '';
      window.cocoa.overlay.sendAction({ action: 'subtitle-search', open: state.subsOpen });
      renderCaptionsMenu();
      showControls();
      return;
    }
    const subtitleOption = event.target.closest('[data-subtitle-key]');
    if (subtitleOption) { selectSubtitle(subtitleOption.dataset.subtitleKey); closeAllMenus(); showControls(); return; }
    const speedOption = event.target.closest('[data-speed-value]');
    if (speedOption) { setSpeed(Number(speedOption.dataset.speedValue)); closeAllMenus(); showControls(); return; }
    const audioOption = event.target.closest('[data-audio-id]');
    if (audioOption) { selectAudioTrack(Number(audioOption.dataset.audioId)); closeAllMenus(); showControls(); return; }
    // Subtitle appearance steppers. Like the option rows above, these are
    // not `data-action` buttons -- without this branch a stepper click fell
    // through every handler and the menu simply stayed open doing nothing
    // (a dead control). They keep the menu open on purpose so the value can
    // be nudged repeatedly.
    const subScaleStep = event.target.closest('[data-subscale-delta]');
    if (subScaleStep) { nudgeSubScale(Number(subScaleStep.dataset.subscaleDelta)); showControls(); return; }
    const subDelayStep = event.target.closest('[data-subdelay-delta]');
    if (subDelayStep) { nudgeSubDelay(Number(subDelayStep.dataset.subdelayDelta)); showControls(); return; }

    // Options-menu rows (Copy Stream Link / Copy Magnet Link / ...). Like the
    // other menu rows, these carry no data-action -- without this branch the
    // click would fall through and the menu would just sit there.
    const optionRow = event.target.closest('[data-option-id]');
    if (optionRow) {
      closeAllMenus();
      window.cocoa.overlay.sendAction({ action: optionRow.dataset.optionId });
      showControls();
      return;
    }

    const episodeOption = event.target.closest('[data-episode-id]');
    if (episodeOption) {
      closeAllMenus();
      window.cocoa.overlay.sendAction({ action: 'select-episode', videoId: episodeOption.dataset.episodeId });
      return;
    }

    const castDevice = event.target.closest('[data-cast-device]');
    if (castDevice) {
      castToDevice(castDevice.dataset.castDevice);
      showControls();
      return;
    }

    const sourcePick = event.target.closest('[data-source-pick]');
    if (sourcePick) {
      closeAllMenus();
      window.cocoa.overlay.sendAction({ action: 'select-source', index: Number(sourcePick.dataset.sourcePick) });
      showControls();
      return;
    }

    const button = event.target.closest('[data-action]');
    if (!button) { if (!event.target.closest('.ov-menu')) closeAllMenus(); return; }
    showControls();
    const action = button.dataset.action;
    if (action === 'play') togglePlay();
    else if (action === 'back10') seekBy(-10);
    else if (action === 'forward10') seekBy(10);
    else if (action === 'mute') toggleMute();
    else if (action === 'full') window.cocoa.overlay.sendAction({ action: 'toggle-fullscreen' });
    else if (action === 'close') window.cocoa.overlay.sendAction({ action: 'close' });
    else if (action === 'source-toggle') {
      const menu = $('[data-role="source-menu"]');
      const wasHidden = menu.classList.contains('hidden');
      closeAllMenus();
      if (wasHidden) {
        menu.classList.remove('hidden');
        controlsVisibility.hold('menu');
        // Ask the main window for the ranked list; it owns the add-on client.
        // Showing the menu immediately (above) with a loading row means the
        // popover opens instantly instead of after the network round-trip.
        state.sourcesStatus = state.sources.length ? 'ready' : 'loading';
        state.sourcesError = '';
        renderSourcesMenu();
        window.cocoa.overlay.sendAction({ action: 'request-sources' });
      }
    }
    else if (action === 'next') window.cocoa.overlay.sendAction({ action: 'next' });
    else if (action === 'cast') {
      // Discovery + the picker now live in THIS window (see renderCastMenu).
      // `openCastPicker` owns the menu's open state so a closed menu is not
      // needlessly re-discovered.
      const menu = $('[data-role="cast-menu"]');
      const wasHidden = menu.classList.contains('hidden');
      closeAllMenus();
      if (wasHidden) {
        menu.classList.remove('hidden');
        controlsVisibility.hold('menu');
        openCastPicker();
      }
    }
    else if (action === 'captions-toggle') {
      const menu = $('[data-role="captions-menu"]');
      const wasHidden = menu.classList.contains('hidden');
      closeAllMenus();
      renderCaptionsMenu();
      menu.classList.toggle('hidden', !wasHidden);
      if (wasHidden) controlsVisibility.hold('menu');
    } else if (action === 'speed-toggle') {
      const menu = $('[data-role="speed-menu"]');
      const wasHidden = menu.classList.contains('hidden');
      closeAllMenus();
      renderSpeedMenu();
      menu.classList.toggle('hidden', !wasHidden);
      if (wasHidden) controlsVisibility.hold('menu');
    } else if (action === 'audio-toggle') {
      const menu = $('[data-role="audio-menu"]');
      const wasHidden = menu.classList.contains('hidden');
      closeAllMenus();
      renderAudioMenu();
      menu.classList.toggle('hidden', !wasHidden);
      if (wasHidden) controlsVisibility.hold('menu');
    } else if (action === 'options-toggle') {
      const menu = $('[data-role="options-menu"]');
      const wasHidden = menu.classList.contains('hidden');
      closeAllMenus();
      renderOptionsMenu();
      menu.classList.toggle('hidden', !wasHidden);
      if (wasHidden) controlsVisibility.hold('menu');
    } else if (action === 'episodes-toggle') {
      const menu = $('[data-role="episodes-menu"]');
      const wasHidden = menu.classList.contains('hidden');
      closeAllMenus();
      menu.classList.toggle('hidden', !wasHidden);
      if (wasHidden) controlsVisibility.hold('menu');
    }
  });

  const timeline = $('[data-role="timeline"]');
  timeline.addEventListener('pointerdown', () => { state.scrubbing = true; controlsVisibility.hold('scrub'); });
  timeline.addEventListener('input', () => {
    timeline.style.setProperty('--progress', `${Number(timeline.value) / 10}%`);
    if (state.duration > 0) {
      const target = (Number(timeline.value) / 1000) * state.duration;
      $('[data-role="time"]').textContent = `${formatTime(target)} / ${formatTime(state.duration)}`;
    }
  });
  const commitScrub = () => {
    if (!state.scrubbing) return;
    state.scrubbing = false;
    if (state.duration > 0) nativeCommand(['set_property', 'time-pos', (Number(timeline.value) / 1000) * state.duration]);
    controlsVisibility.release('scrub');
  };
  timeline.addEventListener('pointerup', commitScrub);
  timeline.addEventListener('change', commitScrub);

  const volume = $('[data-role="volume"]');
  volume.addEventListener('input', () => setVolume(Number(volume.value) * 100));
  const volumeGroup = $('[data-role="volume-group"]');
  volumeGroup.addEventListener('mouseenter', () => volumeGroup.classList.add('expanded'));
  volumeGroup.addEventListener('mouseleave', () => { clearTimeout(volumeHideTimer); volumeHideTimer = setTimeout(() => volumeGroup.classList.remove('expanded'), 500); });

  // Pointer-over-controls hold: while the pointer rests over either bar (or
  // an open menu), the chrome must never fade -- the user is actively using
  // it. the reference player keeps its chrome up on hover for the same reason. The bars
  // are pointer-events:none while hidden, so these only fire when visible.
  for (const bar of [$('#top'), $('#bottom')]) {
    bar.addEventListener('mouseenter', () => controlsVisibility.hold('hover'));
    bar.addEventListener('mouseleave', () => controlsVisibility.release('hover'));
  }

  // Keyboard-interaction hold: the overlay window is deliberately
  // non-focusable (see controls-overlay.mjs), so it never receives OS key
  // events and a DOM focusin/keydown listener here can never fire. The main
  // window owns the keyboard during native playback and reports each key
  // press over IPC; treat that as real activity so the chrome is visible
  // whenever the user is driving playback from the keyboard (1c contract).
  window.cocoa.overlay.onActivity?.(key => {
    const menu = $('[data-role="captions-menu"]');
    if (state.subsOpen && menu && !menu.classList.contains('hidden')) {
      if (key === 'Backspace') state.subsFilter = state.subsFilter.slice(0, -1);
      else if (key.length === 1 && /[\p{L}\p{N} ]/u.test(key)) state.subsFilter = (state.subsFilter + key).slice(0, 24);
      renderCaptionsMenu();
    }
    showControls();
  });

  // This is the only keyboard listener in the whole player -- mpv's own
  // window never receives OS input focus (it's an unmanaged child HWND
  // embedded behind this overlay, see video-surface.mjs), so there is no
  // second listener to double-fire against. Every key here reaches mpv
  // exactly once, via nativeCommand(), same as a button click would.
  document.addEventListener('keydown', event => {
    if (event.code === 'Space') { event.preventDefault(); togglePlay(); }
    else if (event.code === 'ArrowLeft') { event.preventDefault(); seekBy(-10); }
    else if (event.code === 'ArrowRight') { event.preventDefault(); seekBy(10); }
    else if (event.code === 'ArrowUp') { event.preventDefault(); setVolume(state.volume + 5); }
    else if (event.code === 'ArrowDown') { event.preventDefault(); setVolume(state.volume - 5); }
    else if (event.key?.toLowerCase() === 'm') toggleMute();
    else if (event.key?.toLowerCase() === 'f') window.cocoa.overlay.sendAction({ action: 'toggle-fullscreen' });
    else if (event.key?.toLowerCase() === 'c') $('[data-action="captions-toggle"]')?.click();
    else if (event.key === 'Escape') {
      // Priority chain, not an unconditional close: a stray Escape must
      // never blow away playback just because a menu happened to be open.
      const menuWasOpen = $$('.ov-menu').some(menu => !menu.classList.contains('hidden'));
      if (menuWasOpen) closeAllMenus();
      else if (state.fullscreen) window.cocoa.overlay.sendAction({ action: 'toggle-fullscreen' });
      else window.cocoa.overlay.sendAction({ action: 'close' });
    }
    showControls();
  });

  window.cocoa.playback.onNativeStats(stats => {
    if (!stats || stats.ownerId !== state.ownerId) return;
    state.paused = Boolean(stats.paused);
    if (state.paused) controlsVisibility.hold('paused'); else controlsVisibility.release('paused');
    state.muted = Boolean(stats.muted);
    state.volume = Number(stats.volume ?? state.volume);
    state.speed = Number(stats.speed || state.speed);
    state.position = Number(stats.position || 0);
    state.duration = Number(stats.duration || 0);
    if (Array.isArray(stats.audioTracks)) {
      state.audioTracks = stats.audioTracks;
      // Show the control only when there is a genuine choice to make --
      // a dead button for a single-track file is exactly the kind of
      // "present but useless" UI the player contract forbids.
      $('[data-role="audio-wrap"]')?.classList.toggle('hidden', state.audioTracks.length < 2);
      if (!$('[data-role="audio-menu"]')?.classList.contains('hidden')) renderAudioMenu();
    }
    if (typeof stats.subScale === 'number') state.subScale = stats.subScale;
    if (typeof stats.subDelay === 'number') state.subDelay = stats.subDelay;
    updatePlayButton();
    updateMuteButton();
    updateTimeline();
    $('[data-role="speed-label"]').textContent = `${state.speed}×`;
  });

  window.cocoa.overlay.onState(payload => {
    if (payload.ownerId) state.ownerId = payload.ownerId;
    if (payload.title !== undefined) $('[data-role="title"]').textContent = payload.title;
    if (payload.subtitle !== undefined) $('[data-role="subtitle"]').textContent = payload.subtitle;
    if (payload.hasNext !== undefined) {
      state.hasNext = Boolean(payload.hasNext);
      $('[data-role="next-btn"]').classList.toggle('hidden', !state.hasNext);
    }
    if (payload.subtitles !== undefined) {
      state.subtitles = Array.isArray(payload.subtitles) ? payload.subtitles : [];
      // mpv's live `sid` is authoritative; only fall back to the previous
      // value when the payload genuinely omits it.
      state.subtitleKey = typeof payload.subtitleKey === 'string' ? payload.subtitleKey : state.subtitleKey;
      renderCaptionsMenu();
    }
    if (payload.fullscreen !== undefined) {
      state.fullscreen = Boolean(payload.fullscreen);
      $('[data-icon="expand"]').classList.toggle('hidden', payload.fullscreen);
      $('[data-icon="collapse"]').classList.toggle('hidden', !payload.fullscreen);
    }
    if (payload.sources !== undefined) {
      state.sources = Array.isArray(payload.sources) ? payload.sources : [];
      // `sourcesStatus` is owned by the requester; a payload without an
      // explicit status means "here is the list you asked for".
      state.sourcesStatus = payload.sources.length ? 'ready' : 'empty';
      if (payload.sourcesError) { state.sourcesStatus = 'error'; state.sourcesError = payload.sourcesError; }
      if (typeof payload.sourceIndex === 'number') state.sourceIndex = payload.sourceIndex;
      if (!$('[data-role="source-menu"]')?.classList.contains('hidden')) renderSourcesMenu();
    }
    if (payload.castUrl !== undefined) {
      state.castUrl = String(payload.castUrl || '');
    }
    if (payload.episodes !== undefined) {
      state.episodes = Array.isArray(payload.episodes) ? payload.episodes : [];
      state.episodeIndex = typeof payload.episodeIndex === 'number' ? payload.episodeIndex : -1;
      $('[data-role="episodes-btn"]')?.classList.toggle('hidden', state.episodes.length < 2);
      renderEpisodesMenu();
    }
    if (payload.audioTracks !== undefined) {
      // Same rule as the live stats path: only offer the control when the
      // source genuinely has more than one audio track.
      state.audioTracks = Array.isArray(payload.audioTracks) ? payload.audioTracks : [];
      $('[data-role="audio-wrap"]')?.classList.toggle('hidden', state.audioTracks.length < 2);
      renderAudioMenu();
    }
    if (payload.optionsMenu !== undefined) {
      // Upstream keeps the options button enabled for any real stream; the
      // model itself decides which rows exist, so the button is shown
      // whenever there is at least one genuine action to offer.
      state.optionsMenu = Array.isArray(payload.optionsMenu) ? payload.optionsMenu : [];
      $('[data-role="options-btn"]')?.classList.toggle('hidden', state.optionsMenu.length === 0);
      renderOptionsMenu();
    }
  });
}

renderSpeedMenu();
bindEvents();
showControls();
