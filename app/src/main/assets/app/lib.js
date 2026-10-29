export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

export function canonicalKey(item) {
  return `${item?.type || 'unknown'}:${item?.id || item?.name || 'unknown'}`;
}

// Local ratings are stored keyed `type:id` with a small entry payload (see
// electron/store.mjs's sanitizeRating). This rebuilds them as normal media
// items so the SAME card renderer, click wiring and details page serve rated
// titles -- a rated section needs no second code path.
//
// The key's type prefix is authoritative on purpose: the stored `type` field
// is normalised to movie/series, so trusting it would relabel an anime as a
// movie and open it against the wrong metadata.
export function ratedItems(ratings = {}) {
  const output = [];
  for (const [key, entry] of Object.entries(ratings || {})) {
    if (!entry || typeof entry !== 'object') continue;
    // Same normalisation the store applies (clampRating: rounded, 1-10). The
    // renderer must not be more permissive than the writer, or a corrupt
    // profile could paint a "rated" card for something never actually rated.
    const rating = Math.round(Number(entry.rating));
    if (!Number.isFinite(rating) || rating < 1 || rating > 10) continue;
    const separator = String(key).indexOf(':');
    const id = separator > 0 ? String(key).slice(separator + 1) : '';
    if (!id) continue;
    output.push({
      id,
      type: separator > 0 ? String(key).slice(0, separator) : String(entry.type || 'movie'),
      name: String(entry.title || id),
      poster: String(entry.poster || ''),
      year: String(entry.year || ''),
      _rating: rating,
      _ratedAt: String(entry.ratedAt || '')
    });
  }
  // Highest rating first, then most recent. A predictable order that also puts
  // the user's actual favourites at the top of the section.
  return output.sort((a, b) =>
    (b._rating - a._rating) || String(b._ratedAt).localeCompare(String(a._ratedAt)));
}

export function dedupeItems(items = []) {
  const seen = new Set();
  const output = [];
  for (const item of items) {
    if (!item?.id || !item?.type) continue;
    const key = canonicalKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

export function cleanMeta(meta = {}) {
  const genres = normalizeGenres(meta.genres || meta.genre);
  return {
    ...meta,
    id: meta.id,
    type: meta.type || 'movie',
    name: meta.name || meta.title || 'Untitled',
    poster: meta.poster || meta.posterShape || '',
    background: meta.background || meta.poster || '',
    description: meta.description || meta.overview || '',
    genres,
    releaseInfo: meta.releaseInfo || meta.year || '',
    runtime: meta.runtime || '',
    imdbRating: meta.imdbRating || meta.rating || '',
    // Packet B: Cinemeta already ships these (bundled core addon), so preserve
    // them explicitly instead of relying on the spread -- cleanMeta's explicit
    // keys are what downstream reads. No new add-on or paid API is involved.
    cast: meta.cast || [],
    director: meta.director || [],
    writer: meta.writer || [],
    awards: meta.awards || '',
    country: meta.country || '',
    videos: Array.isArray(meta.videos) ? meta.videos : []
  };
}

export function normalizeGenres(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (!value) return [];
  return String(value).split(/[,/|]/).map(x => x.trim()).filter(Boolean);
}

// Packets B: cast/crew names as Cinemeta ships them. Cinemeta returns
// `cast`/`director`/`writer` as arrays of plain name strings (verified against
// v3-cinemeta meta for tt0133093), but other add-ons sometimes send
// comma-joined strings or [{name}] objects, so accept all three rather than
// assuming one. Deduped and capped: a long cast list must not push the
// description and Play button off the hero.
export function peopleList(value, limit = 0) {
  const raw = Array.isArray(value) ? value : normalizeGenres(value);
  const names = [];
  for (const entry of raw) {
    const name = String(
      entry && typeof entry === 'object' ? (entry.name || entry.title || '') : (entry ?? '')
    ).trim();
    if (name && !names.includes(name)) names.push(name);
    if (limit && names.length >= limit) break;
  }
  return names;
}

export function manifestResources(manifest = {}) {
  return (manifest.resources || []).map(r => typeof r === 'string' ? r : r?.name).filter(Boolean);
}

export function supportsResource(manifest = {}, name, type, id) {
  const descriptor = (manifest.resources || []).find(r => typeof r === 'string' ? r === name : r?.name === name);
  if (!descriptor) return false;
  if (typeof descriptor !== 'string') {
    if (type && descriptor.types?.length && !descriptor.types.includes(type)) return false;
    const prefixes = descriptor.idPrefixes || manifest.idPrefixes;
    if (id && prefixes?.length && !prefixes.some(prefix => String(id).startsWith(prefix))) return false;
  } else {
    if (type && manifest.types?.length && !manifest.types.includes(type)) return false;
    if (id && manifest.idPrefixes?.length && !manifest.idPrefixes.some(prefix => String(id).startsWith(prefix))) return false;
  }
  return true;
}

export function catalogSupportsSearch(catalog = {}) {
  return (catalog.extraSupported || []).includes('search') ||
    (catalog.extra || []).some(x => x?.name === 'search');
}

export function catalogUsableForHome(catalog = {}) {
  const required = catalog.extraRequired || [];
  if (required.some(x => !['skip', 'genre'].includes(x))) return false;
  const extras = catalog.extra || [];
  return !extras.some(x => x?.isRequired && !['skip', 'genre', 'search'].includes(x.name));
}

export function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const minutes = Math.floor(seconds / 60);
  const m = (minutes % 60).toString().padStart(2, '0');
  const h = Math.floor(minutes / 60);
  return h ? `${h}:${m}:${s}` : `${minutes}:${s}`;
}

export function formatBytes(bytes, speed = false) {
  if (!Number.isFinite(bytes) || bytes < 1) return speed ? '0 B/s' : '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value >= 10 || i === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[i]}${speed ? '/s' : ''}`;
}

export function qualityOf(stream = {}) {
  const text = `${stream.name || ''} ${stream.title || ''} ${stream.description || ''}`;
  const match = text.match(/(?:^|\D)(2160p|4k|1440p|1080p|720p|480p|360p)(?:\D|$)/i);
  return match ? match[1].toUpperCase().replace('2160P', '4K') : '';
}

export function streamType(stream = {}) {
  if (stream.infoHash) return 'Torrent';
  if (stream.url) return /\.m3u8(?:\?|$)/i.test(stream.url) || /\.m3u8(?:\?|$)/i.test(stream.behaviorHints?.filename || '') ? 'HLS' : 'Direct';
  if (stream.externalUrl) return 'External';
  if (stream.ytId) return 'YouTube';
  return 'Unknown';
}


export function streamCompatibility(stream = {}) {
  const kind = streamType(stream);
  if (kind === 'Torrent') return { playable: true, level: 'good', engine: 'native', reason: 'Native torrent stream' };
  if (kind === 'External' || kind === 'YouTube') return { playable: false, level: 'external', engine: 'external', reason: 'Opens outside CocoaStream' };
  if (!stream.url) return { playable: false, level: 'blocked', engine: 'none', reason: 'Unsupported source type' };
  // v0.3 routes HLS and direct URLs through the same embedded mpv session as torrents.
  // This avoids Chromium codec differences and the old disk-backed direct buffer.
  return { playable: true, level: 'good', engine: 'native', reason: kind === 'HLS' ? 'Native HLS' : 'Native direct stream' };
}

export function sourceLabel(stream = {}) {
  return stream.name || stream.addonName || 'Source';
}

export function sourceDescription(stream = {}) {
  return stream.description || stream.title || stream.behaviorHints?.filename || '';
}

function streamSearchText(stream = {}) {
  return [stream.name, stream.title, stream.description, stream.behaviorHints?.filename]
    .filter(Boolean)
    .join(' ');
}

export function isCameraSource(stream = {}) {
  const normalized = streamSearchText(stream)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  if (!normalized) return false;
  const tokens = new Set(normalized.split(/\s+/));
  if (['CAM', 'HDCAM', 'CAMRIP', 'HDTS', 'TELESYNC', 'TELECINE'].some(tag => tokens.has(tag))) return true;
  if (tokens.has('TS') && !/\bMPEG TS\b/.test(normalized) && !/\bTRANSPORT STREAM\b/.test(normalized)) return true;
  return false;
}

export function releaseTypeOf(stream = {}) {
  const text = streamSearchText(stream);
  if (/\bREMUX\b/i.test(text)) return 'REMUX';
  if (/\b(?:BLU[ ._-]?RAY|BDRIP|BDREMUX)\b/i.test(text)) return 'BluRay';
  if (/\bWEB[ ._-]?DL\b/i.test(text)) return 'WEB-DL';
  if (/\bWEB[ ._-]?RIP\b/i.test(text)) return 'WEBRip';
  if (/\b(?:BRRIP|BDRIP)\b/i.test(text)) return 'BRRip';
  if (/\bHDTV\b/i.test(text)) return 'HDTV';
  if (/\bDVD(?:RIP)?\b/i.test(text)) return 'DVD';
  return '';
}

export function seedersOf(stream = {}) {
  const text = streamSearchText(stream);
  const patterns = [
    /👤\s*([0-9][0-9,]*)/u,
    /\bseed(?:er)?s?\s*[:=]?\s*([0-9][0-9,]*)/i,
    /\bpeers?\s*[:=]?\s*([0-9][0-9,]*)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1].replaceAll(',', '')) || 0;
  }
  return 0;
}

// seedersOf() returns 0 both for "0 seeders" and for "this add-on doesn't
// report seeders at all", and those two mean opposite things: the first is a
// source that cannot deliver a byte, the second may be perfectly fine. This
// says whether a number was actually present in the add-on's own text.
export function seedersKnown(stream = {}) {
  const text = streamSearchText(stream);
  return /👤\s*[0-9][0-9,]*/u.test(text)
    || /\bseed(?:er)?s?\s*[:=]?\s*[0-9][0-9,]*/i.test(text)
    || /\bpeers?\s*[:=]?\s*[0-9][0-9,]*/i.test(text);
}

export function streamSizeBytes(stream = {}) {
  const text = streamSearchText(stream);
  const match = text.match(/(?:^|\s)([0-9]+(?:\.[0-9]+)?)\s*(TB|GB|MB)(?:\s|$)/i);
  if (!match) return Number(stream?.behaviorHints?.videoSize || 0) || 0;
  const value = Number(match[1]);
  const unit = match[2].toUpperCase();
  const multiplier = unit === 'TB' ? 1024 ** 4 : unit === 'GB' ? 1024 ** 3 : 1024 ** 2;
  return value * multiplier;
}

// Torrentio (and similar add-ons) sometimes return one file picked out of a
// giant multi-title torrent -- "Imdb top 263 movies ... gdrive" style packs
// bundling hundreds of unrelated movies/episodes into a single .torrent.
// These look completely healthy by seeder count (the count is for the whole
// pack, everyone who ever grabbed any part of it), but a live test caught
// the real failure mode directly: mpv had to seek to the tail of the file to
// read the MP4 index, that seek needs the swarm to have (and prioritize)
// that specific piece deep inside one specific file among hundreds, and it
// simply stalled forever -- the same swarm health number that looks great
// for the pack as a whole says nothing about one file's slice of it.
export function isPackTorrent(stream = {}) {
  const text = streamSearchText(stream);
  // Deliberately NOT a bare /collection/ or /pack/ match -- "Criterion
  // Collection" is a normal, single-file edition label. What actually
  // signals "many titles bundled into one torrent" is either an explicit
  // count/tag, a franchise-bundle word (trilogy etc.), or a year *range*
  // (single releases carry one year; a bundle spans several).
  return /\b[0-9]{2,4}\s*(?:movies|episodes|titles)\b/i.test(text)
    || /\b(?:movies?|episodes?)\s*(?:pack|collection)\b/i.test(text)
    || /\bcollection\b.{0,20}\b(?:movies|episodes)\b/i.test(text)
    || /\[\s*pack\s*\]/i.test(text)
    || /\b(?:tri|du|quad|penta)logy\b|\banthology\b/i.test(text)
    || (/\bpack\b|\bcollection\b/i.test(text) && /\b(?:19|20)\d{2}\s*[-–—]\s*(?:19|20)\d{2}\b/.test(text));
}

export function sourceProviderKey(stream = {}) {
  return String(stream.addonUrl || stream.addonName || stream.name || streamType(stream) || 'unknown').toLowerCase();
}

// How many failed plays with zero successes make an add-on "proven dead".
export const DEAD_PROVIDER_MIN_FAILURES = 5;

export function providerReliability(stream = {}, sourceStats = {}) {
  const stats = sourceStats?.[sourceProviderKey(stream)] || {};
  const successes = Number(stats.successes || 0);
  const failures = Number(stats.failures || 0);
  const attempts = successes + failures;
  // A mild prior prevents one lucky/failing attempt from completely reshuffling the list.
  const rate = (successes + 2) / (attempts + 3);
  // A provider the app has tried repeatedly and NEVER once played is not
  // "unlucky", it is broken (measured Oct 28: addon.peerflix.mov returned 436
  // candidates across 5 titles and the app played 0 of them in 19 attempts;
  // torrentsdb answered HTTP 502 on every request). Its candidates still stay
  // in the list as a last resort, but they must never be the first thing the
  // player touches.
  const condemned = successes === 0 && failures >= DEAD_PROVIDER_MIN_FAILURES;
  return { successes, failures, attempts, rate, condemned };
}

export function analyzeStream(stream = {}, sourceStats = {}) {
  const quality = qualityOf(stream).toUpperCase();
  const kind = streamType(stream);
  const release = releaseTypeOf(stream);
  const camera = isCameraSource(stream);
  const seeders = seedersOf(stream);
  const seedersReported = seedersKnown(stream);
  const sizeBytes = streamSizeBytes(stream);
  const text = streamSearchText(stream);
  const reliability = providerReliability(stream, sourceStats);
  const compatibility = streamCompatibility(stream);
  const pack = kind === 'Torrent' && isPackTorrent(stream);

  // 1080p outranks 4K on purpose. A 4K torrent needs several times the bytes
  // before the first frame decodes, and it usually comes from a thinner,
  // newer swarm: the app's own production log measured 46s to first picture
  // on a 2160p DV source (engine fed 8MiB in 20s) against 9s on a 1080p
  // source of the same movie minutes earlier. On a 1080p display the picture
  // looks the same, so the healthy 1080p release is the better default --
  // the 4K rows stay in the list, just below it. A 4K release with a much
  // healthier swarm can still win on the seeder bonus below.
  const qualityScores = { '4K': 560, '1440P': 600, '1080P': 700, '720P': 420, '480P': 200, '360P': 90 };
  const releaseScores = { REMUX: 170, BluRay: 235, 'WEB-DL': 285, WEBRip: 190, BRRip: 145, HDTV: 80, DVD: 35 };
  const typeScores = { HLS: 190, Direct: 170, Torrent: 120, External: -80, YouTube: -100, Unknown: -120 };

  let score = (qualityScores[quality] || 110) + (releaseScores[release] || 0) + (typeScores[kind] || 0);
  if (camera) score -= 10000;
  if (seeders) score += Math.min(320, Math.log2(seeders + 1) * 48);
  if (kind === 'Torrent' && !seeders) score -= 180;
  if (kind === 'Torrent' && seeders > 0 && seeders <= 2) score -= 520;
  else if (kind === 'Torrent' && seeders <= 5) score -= 260;
  else if (kind === 'Torrent' && seeders <= 15) score -= 90;

  if (pack) score -= 900;

  if (kind === 'Torrent' && sizeBytes) {
    const gib = sizeBytes / (1024 ** 3);
    if (gib > 45) score -= 1000;
    else if (gib > 30) score -= 650;
    else if (gib > 20) score -= 350;
    else if (gib > 12) score -= 150;
    else if (gib < 0.7 && quality === '4K') score -= 160;
    if (gib > 35 && seeders > 0 && seeders <= 5) score -= 700;
  }

  const h264 = /\b(?:H\.?264|AVC|X264)\b/i.test(text);
  const hevc = /\b(?:H\.?265|HEVC|X265)\b/i.test(text);
  const av1 = /\bAV1\b/i.test(text);
  const aac = /\bAAC\b/i.test(text);
  const riskyAudio = /\b(?:DTS|TRUEHD|EAC3|E-AC-3)\b/i.test(text);
  if (h264) score += 100;
  // AV1 hardware decode is still far from universal (roughly GPUs from
  // ~2020 onward), and there's no way from here to know whether this
  // machine's GPU/drivers actually support it. Caught the real cost of
  // guessing wrong directly in a live test: mpv logged repeated "hwaccel
  // initialisation returned error" for both d3d11 and dxva2_vld on a 4K
  // AV1 source, meaning it fell back to software-decoding 4K AV1 -- one of
  // the most CPU-demanding combinations there is -- and the attempt
  // stalled out. H.264/HEVC hardware decode is dramatically more likely to
  // actually be present, so no longer rewarding AV1 over them by default.
  if (av1) score -= 60;
  if (hevc) score += 25;
  if (aac) score += 45;
  if (riskyAudio) score += 5;

  if (compatibility.level === 'low') score -= 700;
  if (compatibility.level === 'medium') score -= 100;
  score += (reliability.rate - (2 / 3)) * 300;
  // Hard sinks, not silent deletions: the candidate stays in the list (so
  // failover still has somewhere to go) but it can never be picked first.
  // - "0 seeders" reported by the add-on itself: nothing to download from.
  // - a provider with zero successes in the app's own play history.
  if (kind === 'Torrent' && seedersReported && seeders === 0) score -= 2500;
  if (reliability.condemned) score -= 5000;

  const warnings = [];
  if (kind === 'Torrent' && sizeBytes > 30 * (1024 ** 3)) warnings.push('Large file; lower-ranked for faster startup');
  if (kind === 'Torrent' && seeders > 0 && seeders <= 5) warnings.push('Very low swarm health');
  if (pack) warnings.push('Bundled multi-title torrent; one file inside it can stall even with a healthy overall swarm');

  if (compatibility.level === 'low') warnings.push(compatibility.reason);
  return { score, quality, kind, release, camera, seeders, seedersReported, sizeBytes, reliability, compatibility, pack, warnings };
}


function streamPeerSources(stream = {}) {
  return (Array.isArray(stream.sources) ? stream.sources : [])
    .filter(value => typeof value === 'string')
    .map(value => value.trim())
    .filter(value => value.startsWith('tracker:') || value.startsWith('dht:'));
}

// Groups Stream Objects that refer to the same underlying torrent+file
// (same infoHash, compatible fileIdx) or the same direct URL, for DISPLAY
// purposes only -- so the picker doesn't show the identical source twice
// and failover doesn't retry the identical infoHash. This NEVER creates a
// synthetic Stream Object: every original, single-addon Stream Object is
// kept unmodified in `candidates`, and the representative returned for a
// group is one real candidate's own fields, untouched, plus a `_candidates`
// bookkeeping field and ignored by the transport layer. Nothing is ever
// unioned across addons -- no combined sources, no borrowed
// fileIdx/behaviorHints/filename. Streams are concatenated in addon order,
// never deduplicated; playback reads sources/fileIdx off exactly one Stream
// Object. A merged object here would silently defeat
// torrent-engine.mjs's fast path by inventing a non-empty `sources` array
// on a stream an add-on returned with none -- that's a proven, measured
// cost (see the Dana White S10E04 Torrentio object: fileIdx known, no
// sources -- eligible for the zero-`/create`-call fast path, until a merge
// invents sources from a different add-on's copy).
//
// Two torrent entries for the same infoHash fold into one group when their
// fileIdx either matches or is unspecified on one/both sides (an add-on
// omitting fileIdx is deferring to guessFileIdx, not naming a different
// file). Entries naming two DIFFERENT explicit fileIdx values for the same
// infoHash (e.g. two episodes inside one season-pack torrent) are genuinely
// different files and stay in separate groups. `streams` must already carry
// `_cocoa` (see analyzeStream/rankStreams below) -- the representative is
// whichever candidate in the group independently scores highest, i.e.
// ranking deciding among real candidates, never a synthesis of them.
export function groupDuplicateStreams(streams = []) {
  const torrentGroupsByHash = new Map();
  const otherGroupsByKey = new Map();
  const orderedGroups = [];
  let foldedDuplicates = 0;

  for (const stream of streams) {
    if (stream?.infoHash) {
      const hash = String(stream.infoHash).toLowerCase();
      const idx = Number.isInteger(stream.fileIdx) ? stream.fileIdx : null;
      if (!torrentGroupsByHash.has(hash)) torrentGroupsByHash.set(hash, []);
      const bucket = torrentGroupsByHash.get(hash);
      let group = bucket.length === 1 && (bucket[0].idx === null || idx === null)
        ? bucket[0]
        : bucket.find(g => g.idx !== null && g.idx === idx);
      if (group) {
        foldedDuplicates++;
        group.candidates.push(stream);
        if (group.idx === null && idx !== null) group.idx = idx;
      } else {
        group = { idx, candidates: [stream] };
        bucket.push(group);
        orderedGroups.push(group);
      }
    } else {
      const key = stream?.url ? `url:${String(stream.url)}`
        : stream?.externalUrl ? `external:${String(stream.externalUrl)}`
          : stream?.ytId ? `yt:${String(stream.ytId)}` : `other:${JSON.stringify(stream)}`;
      let group = otherGroupsByKey.get(key);
      if (group) { foldedDuplicates++; group.candidates.push(stream); }
      else { group = { idx: null, candidates: [stream] }; otherGroupsByKey.set(key, group); orderedGroups.push(group); }
    }
  }

  const representatives = orderedGroups.map(group => {
    const best = group.candidates.reduce((a, b) => (b._cocoa?.score ?? -Infinity) > (a._cocoa?.score ?? -Infinity) ? b : a);
    return { ...best, _candidates: group.candidates };
  });

  const trackers = representatives.reduce((sum, s) => sum + streamPeerSources(s).filter(v => v.startsWith('tracker:')).length, 0);
  const peerSources = representatives.reduce((sum, s) => sum + streamPeerSources(s).length, 0);
  return { streams: representatives, foldedDuplicates, trackers, peerSources };
}

// The identity of the thing a source actually plays from.
//
// Why this exists: two DIFFERENT Stream Objects from different add-ons very
// often name the same torrent (same infoHash + fileIdx). A real app log from a
// live session showed a dead swarm (0 peer sources, 0.04% progress) being
// retried immediately as its own fallback -- because failover handed it the
// failed stream's own `_candidates` siblings first, and those siblings ARE the
// identical swarm. That burns a full timeout per duplicate and can exhaust
// every candidate without ever playing. Failover must therefore dedupe on this
// identity, not on object identity.
export function swarmIdentity(stream = {}) {
  if (stream?.infoHash) {
    const hash = String(stream.infoHash).trim().toLowerCase();
    const idx = Number.isInteger(stream.fileIdx) ? stream.fileIdx : null;
    return `torrent:${hash}:${idx === null ? 'auto' : idx}`;
  }
  if (stream?.url) return `url:${String(stream.url)}`;
  if (stream?.externalUrl) return `external:${String(stream.externalUrl)}`;
  if (stream?.ytId) return `yt:${String(stream.ytId)}`;
  return '';
}

// Ranked failover list for a chosen source, excluding everything that has
// already been tried. `exclude` holds swarm identities (see swarmIdentity).
//
// `streams[index]`'s own `_candidates` siblings are deliberately NOT promoted
// ahead of the ranked list: they are by construction the same swarm, so
// leading with them is exactly the duplicate-retry bug this prevents. They are
// still eligible as a last resort, deduped like everything else.
export function failoverCandidates({ streams = [], index = 0, exclude = [], limit = 6 } = {}) {
  const tried = new Set((Array.isArray(exclude) ? exclude : []).filter(Boolean));
  const chosen = streams[index];
  if (chosen) tried.add(swarmIdentity(chosen));

  const ranked = streams.slice(index + 1);
  const siblings = Array.isArray(chosen?._candidates)
    ? chosen._candidates.filter(candidate => candidate !== chosen)
    : [];

  const output = [];
  for (const stream of [...ranked, ...siblings]) {
    const identity = swarmIdentity(stream);
    if (identity && tried.has(identity)) continue;
    if (identity) tried.add(identity);
    output.push(stream);
    if (output.length >= limit) break;
  }
  return output;
}

// The dead-stream check the picker and the player both ask before they trust a
// list. "Playable" only means the transport is understood; this is the second
// question -- is anything here actually going to deliver bytes? A title whose
// only candidates are zero-seed or from a provider that has never once played
// must report failure here, not quietly show a list of dead rows.
export function sourceVerdict(streams = []) {
  let deadSeeders = 0;
  let deadProvider = 0;
  const usable = [];
  for (const stream of streams) {
    const info = stream._cocoa || {};
    const zeroSeed = info.kind === 'Torrent' && info.seedersReported && !info.seeders;
    const condemned = Boolean(info.reliability?.condemned);
    if (zeroSeed) deadSeeders++;
    if (condemned) deadProvider++;
    if (zeroSeed || condemned) continue;
    usable.push(stream);
  }
  return {
    total: streams.length,
    usable: usable.length,
    deadSeeders,
    deadProvider,
    ok: usable.length > 0,
    reason: !streams.length ? 'all add-ons returned nothing'
      : (usable.length ? '' : `zero playable: ${deadSeeders} zero-seed, ${deadProvider} from a provider with no successful play`)
  };
}

export function usableSources(streams = []) {
  const verdict = sourceVerdict(streams);
  if (!verdict.deadSeeders && !verdict.deadProvider) return streams;
  return streams.filter(stream => {
    const info = stream._cocoa || {};
    if (info.reliability?.condemned) return false;
    if (info.kind === 'Torrent' && info.seedersReported && !info.seeders) return false;
    return true;
  });
}

export function rankStreams(streams = [], sourceStats = {}, { hideCamera = true } = {}) {
  let hiddenCameraCount = 0;
  let lowCompatibilityCount = 0;
  // Analyze every original candidate BEFORE grouping, so grouping can pick
  // the best-scoring real candidate as its representative instead of
  // needing its own separate (and inevitably field-inventing) tie-break.
  const analyzed = streams.map(stream => ({ ...stream, _cocoa: analyzeStream(stream, sourceStats) }));
  const group = groupDuplicateStreams(analyzed);
  const visible = group.streams.filter(stream => {
    if (hideCamera && stream._cocoa.camera) {
      hiddenCameraCount++;
      return false;
    }
    if (!stream._cocoa.compatibility?.playable) return false;
    if (stream._cocoa.compatibility?.level === 'low') lowCompatibilityCount++;
    return true;
  });
  visible.sort((a, b) => b._cocoa.score - a._cocoa.score);
  // Proof, not just intent: what the picker actually ended up with after
  // grouping, since a silent regression here (back to inventing merged
  // transport fields) would otherwise be invisible until a fast-path-
  // eligible source mysteriously stops being fast-path-eligible again.
  if (group.foldedDuplicates > 0) {
    console.info(`stream-group foldedDuplicates:${group.foldedDuplicates} groups:${group.streams.length}`);
  }
  return { streams: visible, hiddenCameraCount, hiddenTorrentCount: 0, lowCompatibilityCount, group };
}


export function posterFor(item = {}) {
  return item.poster || item.background || '';
}

export function safeYear(meta = {}) {
  const text = String(meta.releaseInfo || meta.year || '');
  const match = text.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : text;
}

export function recentHistory(history = []) {
  return [...history].sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
}

export function continueWatching(history = []) {
  const latestByMedia = new Map();
  for (const entry of recentHistory(history)) {
    const key = entry.item ? canonicalKey(entry.item) : entry.key;
    if (!latestByMedia.has(key)) latestByMedia.set(key, entry);
  }
  return [...latestByMedia.values()].filter(entry => {
    const duration = Number(entry.duration || 0);
    const position = Number(entry.position || 0);
    return duration > 120 && position > 30 && position / duration < .94 && duration - position > 60;
  });
}

export function mediaProgress(item, history = []) {
  const entries = recentHistory(history).filter(h => h.item && canonicalKey(h.item) === canonicalKey(item));
  const entry = entries[0];
  if (!entry?.duration) return 0;
  return Math.min(100, Math.max(0, (entry.position / entry.duration) * 100));
}

export function recommendationScore(item, history = []) {
  if (!item) return 0;
  const recent = recentHistory(history).slice(0, 12);
  const genreWeights = new Map();
  const typeWeights = new Map();
  recent.forEach((entry, idx) => {
    const weight = Math.max(1, 8 - idx * .45);
    for (const genre of normalizeGenres(entry.item?.genres)) {
      const key = genre.toLowerCase();
      genreWeights.set(key, (genreWeights.get(key) || 0) + weight);
    }
    const type = entry.item?.type;
    if (type) typeWeights.set(type, (typeWeights.get(type) || 0) + weight * .35);
  });
  let score = typeWeights.get(item.type) || 0;
  for (const genre of normalizeGenres(item.genres)) score += genreWeights.get(genre.toLowerCase()) || 0;
  return score;
}

export function findResumeFor(item, history = [], videoId = null) {
  return recentHistory(history).find(entry => {
    if (!entry.item || canonicalKey(entry.item) !== canonicalKey(item)) return false;
    if (videoId && entry.videoId !== videoId) return false;
    return true;
  }) || null;
}

export function episodeLabel(video = {}) {
  const season = video.season ?? video.seasonNumber;
  const episode = video.episode ?? video.episodeNumber;
  if (season != null && episode != null) return `S${season} E${episode}`;
  return video.name || video.title || 'Episode';
}

export function videoIdOf(video, item) {
  return video?.id || video?._id || item?.id;
}

export function toast(message, type = 'info', timeout = 3400) {
  const root = document.querySelector('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), timeout);
}

export function debounce(fn, wait = 350) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// --- Player "options menu" actions ----------------------------------------
// Copy Stream Link / Copy Magnet Link are pure derivations of a Stream
// Object, so they live here next to the other stream helpers and are
// unit-testable without a DOM.

// The stream's own playable URL. Upstream prefers the streaming URL and
// falls back to the external-player download deep link; add-ons in the wild
// supply `url`, so that is the primary source here too. Deliberately NOT
// behaviorHints.filename -- that is a display filename, not a link, and
// copying it as a URL would be wrong (same rule the rest of this file uses
// when it refuses to treat a filename hint as a real stream).
export function streamCopyUrl(stream = {}) {
  const candidates = [stream.url, stream.deepLinks?.externalPlayer?.download];
  for (const value of candidates) {
    const text = String(value || '').trim();
    if (/^https?:\/\//i.test(text)) return text;
  }
  return '';
}

// Real trackers to advertise in a magnet link. Mirrors torrent-engine.mjs's
// normalizedPeerSearchSources: normalize the add-on's raw sources to plain
// announce URLs. dht:/tracker: prefixes are stripped, not copied through,
// and the info-hash-derived dht entry is never faked in as a tracker.
export function streamTrackers(stream = {}) {
  const raw = (Array.isArray(stream.sources) ? stream.sources : [])
    .filter(value => typeof value === 'string')
    .map(value => value.trim().replace(/^tracker:/i, ''))
    .filter(value => /^(https?|udp|wss?):\/\//i.test(value));
  return [...new Set(raw)];
}

// Build a standard BitTorrent magnet URI for an infoHash-only stream, or
// honour an explicit upstream-provided magnet. Display name and trackers are
// optional extras; the xt=urn:btih: hash is the only required part, and a
// stream without a real 40-hex hash yields '' rather than a broken link.
export function magnetUriFor(stream = {}, name = '') {
  const provided = String(stream.deepLinks?.externalPlayer?.magnet || '').trim();
  if (/^magnet:\?/i.test(provided)) return provided;
  const hash = String(stream.infoHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(hash)) return '';
  const label = String(name || stream.behaviorHints?.filename || stream.title || '').trim();
  const parts = [`magnet:?xt=urn:btih:${hash}`];
  if (label) parts.push(`dn=${encodeURIComponent(label)}`);
  for (const tracker of streamTrackers(stream)) parts.push(`tr=${encodeURIComponent(tracker)}`);
  return parts.join('&');
}

// The options menu itself, modelled on upstream's order and gating: an
// option is present only when the underlying value genuinely exists, so the
// menu never shows a dead row (upstream does the same with `magnetUrl ? ... :
// null`). Returns plain data so player.js can ship it to the overlay and the
// overlay can render rows without knowing anything about Stream Objects.
export function optionsMenuModel(stream = {}, { subtitleUrl = '' } = {}) {
  const model = [];
  const copyUrl = streamCopyUrl(stream);
  if (copyUrl) model.push({ id: 'copy-stream', label: 'Copy Stream Link', icon: 'link' });
  const magnet = magnetUriFor(stream, stream.name || stream.title || '');
  if (magnet) model.push({ id: 'copy-magnet', label: 'Copy Magnet Link', icon: 'magnet-link' });
  if (String(subtitleUrl || '').trim()) model.push({ id: 'download-subs', label: 'Download Subtitles', icon: 'download' });
  return model;
}

export function icon(name) {
  const icons = {
    play: '▶', pause: '❚❚', back: '←', close: '×', search: '⌕', plus: '+', check: '✓',
    volume: '▰', mute: '▱', full: '⛶', list: '≡', next: '»', settings: '⚙'
  };
  return icons[name] || '';
}
