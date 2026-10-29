/*
 * CocoaStream for Android: the native side of the UI.
 * Every window.cocoa.* call here becomes a promise resolved by the Kotlin
 * bridge (Native.invoke), and native playback events are pushed back in.
 */
(function () {
  'use strict';

  var pending = new Map();
  var seq = 0;
  var listeners = new Map();

  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      var id = ++seq;
      pending.set(id, { resolve: resolve, reject: reject });
      try {
        window.Native.invoke(id, method, JSON.stringify(args));
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  window.__nativeResolve = function (id, ok, payload) {
    var entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok) entry.resolve(payload);
    else entry.reject(new Error((payload && payload.message) || 'Native call failed'));
  };

  function dispatch(name, detail) {
    var set = listeners.get(name);
    if (!set) return;
    set.forEach(function (fn) {
      try { fn(detail); } catch (error) { console.error(error); }
    });
  }

  function playbackSeconds(detail) {
    var copy = Object.assign({}, detail || {});
    ['position', 'duration', 'buffered'].forEach(function (key) {
      if (typeof copy[key] === 'number') copy[key] = Math.max(0, copy[key] / 1000);
    });
    return copy;
  }
  window.__nativeEvent = function (name, detail) {
    if (name === 'native-stats' || name === 'native-closed') detail = playbackSeconds(detail);
    if (name === 'native-closed' && detail && detail.ended) dispatch('native-ended', detail);
    else dispatch(name, detail);
  };

  function on(name, callback) {
    if (typeof callback !== 'function') return function () {};
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(callback);
    return function () { listeners.get(name).delete(callback); };
  }

  function resolved(value) { return Promise.resolve(value); }
  function ok() { return Promise.resolve({ ok: true }); }

  var cocoa = {
    auth: {
      session: function () { return call('auth:session'); },
      hasAccounts: function () { return call('auth:has-accounts'); },
      register: function (username, password) { return call('auth:register', username, password); },
      login: function (username, password) { return call('auth:login', username, password); },
      logout: function () { return call('auth:logout'); }
    },
    data: {
      get: function () { return call('data:get'); },
      save: function (data) { return call('data:save', data); }
    },
    addons: {
      manifest: function (url) { return call('addon:manifest', url); },
      request: function (payload) { return call('addon:request', payload); }
    },
    playback: {
      nativeStart: function (payload) {
        var nativePayload = Object.assign({}, payload, {
          resumePosition: payload.preferences && payload.preferences.resumePlayback === false ? 0 : Math.round((payload.resumePosition || 0) * 1000),
          resumeDuration: Math.round((payload.resumeDuration || 0) * 1000)
        });
        return call('playback:native-start', nativePayload).then(function (result) {
          if (result && result.failure) {
            var error = new Error(result.failure.message || 'The source did not open.');
            Object.assign(error, result.failure);
            throw error;
          }
          return result;
        });
      },
      nativePrewarm: function (payload) { return call('playback:native-prewarm', payload); },
      nativeWarmReport: function () { return call('playback:warm-report'); },
      nativeOpensubHash: function () { return call('playback:opensub-hash'); },
      nativeStop: function (ownerId) { return call('playback:native-stop', ownerId); },
      nativeStats: function () { return call('playback:native-stats').then(playbackSeconds); },
      torrentStats: function () { return call('playback:torrent-stats'); },
      nativeAddSubtitle: function (subtitle) { return call('playback:native-add-subtitle', subtitle); },
      nativeSelectSubtitle: function (id, ownerId) { return call('playback:native-select-subtitle', id, ownerId); },
      nativeCommand: function (command, ownerId) { return call('playback:native-command', command, ownerId); },
      nativeSetControlsVisible: function (visible) { return call('playback:native-surface-controls', visible); },
      vpnStatus: function () { return call('vpn:status'); },
      runtimeStatus: function () { return call('runtime:status'); },
      diagnosticPath: function () { return call('playback:diagnostic-path'); },
      subtitle: function (url, headers) { return call('subtitle:fetch', url, headers); },
      setRequestHeaders: function () { return ok(); },
      directBufferStart: function () { return resolved(null); },
      directBufferStats: function () { return resolved(null); },
      directBufferStop: function () { return ok(); },
      clearDirectBuffer: function () { return ok(); },
      hlsProxyStart: function () { return resolved(null); },
      hlsProxyStop: function () { return ok(); },
      clearHlsProxy: function () { return ok(); },
      onNativeClosed: function (cb) { return on('native-closed', cb); },
      onNativeEnded: function (cb) { return on('native-ended', cb); },
      onNativeStats: function (cb) { return on('native-stats', cb); },
      onNativeError: function (cb) { return on('native-error', cb); },
      onEngineStatus: function (cb) { return on('engine-status', cb); },
      onSafetyStop: function (cb) { return on('safety-stop', cb); }
    },
    overlay: {
      open: function (state) { return call('overlay:sync', state); },
      close: ok,
      sync: function (state) { return call('overlay:sync', state); },
      sendAction: function () {},
      activity: function () {},
      onAction: function (cb) { return on('overlay-action', cb); },
      onState: function () { return function () {}; },
      onActivity: function () { return function () {}; }
    },
    cast: {
      discover: function () { return call('cast:discover'); },
      play: function (payload) { return call('cast:play', payload); },
      stop: function (payload) { return call('cast:stop', payload); }
    },
    trakt: {
      status: function () { return call('trakt:status'); },
      setCredentials: function (payload) { return call('trakt:set-credentials', payload); },
      startAuth: function () { return call('trakt:start-auth'); },
      awaitAuth: function (options) { return call('trakt:await-auth', options); },
      disconnect: function () { return call('trakt:disconnect'); },
      scrobble: function (payload) { return call('trakt:scrobble', payload); },
      rate: function (media, rating) { return call('trakt:rate', media, rating); },
      unrate: function (media) { return call('trakt:unrate', media); },
      watchlist: function (media, listed) { return call('trakt:watchlist', media, listed); },
      rated: function () { return call('trakt:rated'); },
      history: function (options) { return call('trakt:history', options); },
      remoteWatchlist: function () { return call('trakt:remote-watchlist'); },
      lastActivities: function () { return call('trakt:last-activities'); }
    },
    ratings: {
      list: function () { return call('ratings:list'); },
      set: function (id, entry) { return call('ratings:set', id, entry); }
    },
    app: {
      version: function () { return call('app:version'); },
      clearCache: function () { return call('app:clear-cache'); },
      openExternal: function (url) { return call('app:open-external', url); },
      writeClipboard: function (text) { return call('app:write-clipboard', text); },
      checkUpdates: function (url) { return call('app:check-updates', url); }
    }
  };

  window.cocoa = cocoa;

  // Android's hardware back button: let the page handle it when it can
  // (open dialog or a back affordance on screen), otherwise leave the app.
  window.__csBack = function () {
    var dialog = document.querySelector('dialog[open]');
    if (dialog) { dialog.close(); return true; }
    var back = document.querySelector('.back-button, [data-action="back"], .detail-back, [aria-label="Back"]');
    if (back) { back.click(); return true; }
    return false;
  };
})();
