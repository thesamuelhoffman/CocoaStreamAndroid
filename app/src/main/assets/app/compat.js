/*
 * CocoaStream Android - small compatibility shim.
 *
 * Android phones with an older bundled WebView (an AOSP build ships Chromium 83,
 * and phones that have never opened Play Store can lag years behind) are missing
 * a few APIs the UI expects. Adding them here keeps the app working on old
 * devices instead of dying on a blank screen.
 */
(function () {
  'use strict';

  // crypto.randomUUID - Chrome 92+
  if (window.crypto && typeof window.crypto.randomUUID !== 'function') {
    var randomUUID = function () {
      var bytes = new Uint8Array(16);
      if (window.crypto.getRandomValues) {
        window.crypto.getRandomValues(bytes);
      } else {
        for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10
      var hex = '';
      for (var j = 0; j < 16; j++) {
        hex += (bytes[j] + 0x100).toString(16).slice(1);
      }
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
             '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    };
    try {
      Object.defineProperty(window.crypto, 'randomUUID', {
        value: randomUUID, configurable: true, writable: true,
      });
    } catch (e) {
      try { window.crypto.randomUUID = randomUUID; } catch (e2) { /* ignore */ }
    }
  }

  // structuredClone - Chrome 98+
  if (typeof window.structuredClone !== 'function') {
    window.structuredClone = function (value) {
      return value === undefined ? value : JSON.parse(JSON.stringify(value));
    };
  }

  // String.prototype.replaceAll - Chrome 85+
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function (pattern, replacement) {
      if (pattern instanceof RegExp) {
        if (!pattern.global) {
          throw new TypeError('replaceAll must be called with a global RegExp');
        }
        return this.replace(pattern, replacement);
      }
      return this.split(String(pattern)).join(String(replacement));
    };
  }

  // Array.prototype.at / String.prototype.at - Chrome 92+
  if (!Array.prototype.at) {
    Array.prototype.at = function (index) {
      var i = Math.trunc(index) || 0;
      if (i < 0) i += this.length;
      return (i < 0 || i >= this.length) ? undefined : this[i];
    };
  }
  if (!String.prototype.at) {
    String.prototype.at = function (index) {
      var i = Math.trunc(index) || 0;
      if (i < 0) i += this.length;
      return (i < 0 || i >= this.length) ? undefined : this.charAt(i);
    };
  }

  // Object.hasOwn - Chrome 93+
  if (!Object.hasOwn) {
    Object.hasOwn = function (object, property) {
      return Object.prototype.hasOwnProperty.call(object, property);
    };
  }
})();
