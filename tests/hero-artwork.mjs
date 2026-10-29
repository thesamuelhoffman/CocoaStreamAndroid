import vm from 'node:vm';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync('app/src/main/assets/app/app.js','utf8');
const fn=source.slice(source.indexOf('function heroHtml('),source.indexOf('function rowHtml('));
const escapeHtml=x=>String(x).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const html=vm.runInNewContext(fn+'\nheroHtml(item)',{
 item:{name:'A movie',background:'https://example.org/backdrop.jpg',poster:'https://example.org/poster.jpg'},
 escapeHtml,cssUrl:x=>x,safeYear:()=>2026
});
assert.match(html,/<img[^>]+class="hero-bg"/,'Artwork must have an actual image box, not an empty absolute div');
assert.match(html,/data-fallback-src="https:\/\/example.org\/poster.jpg"/,'Backdrop failures must fall back to the poster');
console.log('Spotlight uses an image element with poster fallback PASS');
