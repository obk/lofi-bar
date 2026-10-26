// Pulls more lofi stations from the community Radio Browser directory
// SPDX-License-Identifier: GPL-2.0-or-later
// (https://www.radio-browser.info) and keeps the best-quality stream of each.
//
// Radio Browser often lists one station several times, once per format
// (e.g. 64k AAC+, 128k MP3, 320k MP3). We group those entries by station and
// order the streams best first, so the player starts on the highest-quality
// one and only falls back when it cannot connect.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {isCancelled} from './net.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_bytes_async', 'replace_contents_finish');

const SERVER_LIST_URL = 'https://all.api.radio-browser.info/json/servers';
const FALLBACK_SERVERS = [
    'de1.api.radio-browser.info',
    'de2.api.radio-browser.info',
    'fi1.api.radio-browser.info',
];
const TAGS = ['lofi', 'lo-fi', 'chillhop'];
const PER_TAG_LIMIT = 300;
const MAX_STATIONS = 40;
const MAX_STREAMS_PER_STATION = 3;
const MIN_BITRATE = 128;
const CACHE_TTL_S = 24 * 60 * 60;
const CACHE_VERSION = 2;
const MAX_CACHE_BYTES = 1024 * 1024;
const MAX_NAME_LENGTH = 80;

// How much quality a codec delivers per kbps, relative to MP3.
const CODEC_EFFICIENCY = {
    MP3: 1,
    AAC: 1.25,
    'AAC+': 1, // HE-AAC: built for low bitrates, no gain at high ones
    OGG: 1.2,
    OPUS: 1.5,
};
const LOSSLESS_SCORE = 10000;

function codecOf(entry) {
    const codec = (entry.codec ?? '').toUpperCase();
    const url = (entry.url_resolved || entry.url || '').toLowerCase();
    // Radio Browser reports Ogg FLAC as "OGG"; the mount name is reliable.
    if (codec === 'FLAC' || /\.flac(\?|$)/.test(url))
        return 'FLAC';
    return codec;
}

function displayCodec(codec) {
    switch (codec) {
    case 'AAC+':
        return 'AAC';
    case 'OGG':
        return 'Ogg';
    case 'OPUS':
        return 'Opus';
    case 'UNKNOWN':
    case '':
        return '';
    default:
        return codec;
    }
}

function qualityScore(codec, bitrate) {
    if (codec === 'FLAC')
        return LOSSLESS_SCORE;
    return (bitrate || 0) * (CODEC_EFFICIENCY[codec] ?? 0.8);
}

function qualityTier(score) {
    if (score >= LOSSLESS_SCORE)
        return 4;
    if (score >= 256)
        return 3;
    if (score >= 192)
        return 2;
    return 1;
}

const FORMAT_TOKEN = String.raw`\d+\s?k(?:bps)?|mp3|aac\+?|ogg|opus|flac|hq|hd|lq`;
// Inside brackets a bare standard bitrate counts too: "[MP3 128]". Other
// numbers such as "(101)" are channel names and must keep stations apart.
const BRACKET_TOKEN = String.raw`${FORMAT_TOKEN}|(?:32|48|56|64|96|112|128|160|192|256|320)(?!\d)`;

// "ISEKOI Radio | Chill Zone (FLAC)" and "... 320k" should match their other
// format variants. Only format tokens are removed: "(Tokyo)" and "(Berlin)"
// are different stations, and so are "[2]" and "[3]" mirrors' channels.
function groupKey(name) {
    return name.toLowerCase()
        .replace(new RegExp(String.raw`[\[(]\s*(?:${BRACKET_TOKEN})(?:\s*[/,|-]?\s*(?:${BRACKET_TOKEN}))*\s*[\])]`, 'gu'), ' ')
        .replace(new RegExp(String.raw`(?<![\p{L}\p{N}])(?:${FORMAT_TOKEN})(?![\p{L}\p{N}])`, 'gu'), ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

function cleanName(name) {
    const clean = String(name ?? '').replace(/\s+/g, ' ').trim();
    // Count code points, so an emoji is never cut in half.
    const chars = [...clean];
    return chars.length > MAX_NAME_LENGTH ? `${chars.slice(0, MAX_NAME_LENGTH - 1).join('')}…` : clean;
}

function splitUrl(url) {
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?/i.exec(url ?? '');
    if (!match)
        return null;
    // Scheme and host are case-insensitive; the path and query are not.
    return {
        host: match[2].toLowerCase().replace(/:(80|443)$/, ''),
        path: match[3].replace(/\/+$/, ''),
        query: match[4] ?? '',
    };
}

/**
 * Identity of a station's stream for "do we already offer this?" checks:
 * host and path, ignoring scheme, query (tracking parameters) and trailing
 * slashes.
 *
 * @param {string} url
 * @returns {string}
 */
export function urlKey(url) {
    const parts = splitUrl(url);
    return parts ? `${parts.host}${parts.path}` : '';
}

// Exact stream identity, query included, for de-duplicating variants.
function streamKey(url) {
    const parts = splitUrl(url);
    return parts ? `${parts.host}${parts.path}${parts.query}` : '';
}

function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url);
}

function genreOf(entry) {
    const ignored = new Set(['lofi', 'lo-fi', 'lo fi', 'radio', 'music', 'internet radio', 'online']);
    const tags = (entry.tags ?? '').split(',')
        .map(t => t.trim())
        .filter(t => t && t.length <= 20 && !ignored.has(t.toLowerCase()));
    return tags.slice(0, 2).join(' · ');
}

/**
 * Turns raw Radio Browser entries into stations with their streams ordered
 * best quality first.
 *
 * @param {object[]} entries - raw /json/stations/search results
 * @param {Set<string>} excludeUrls - urlKey()s of streams we already offer
 * @returns {object[]} stations
 */
export function buildStations(entries, excludeUrls = new Set()) {
    const groups = new Map();
    const seenUuids = new Set();

    for (const entry of entries) {
        if (!entry?.stationuuid || seenUuids.has(entry.stationuuid))
            continue;
        seenUuids.add(entry.stationuuid);

        const url = entry.url_resolved || entry.url;
        if (!isHttpUrl(url) || entry.lastcheckok !== 1)
            continue;
        if (/\.m3u8(\?|$)/i.test(url) || entry.hls === 1)
            continue;
        const name = cleanName(entry.name ?? '');
        if (!name)
            continue;

        const key = groupKey(name) || name.toLowerCase();
        let group = groups.get(key);
        if (!group) {
            group = {name, entries: [], excluded: false};
            groups.set(key, group);
        }
        if (excludeUrls.has(urlKey(entry.url)) || excludeUrls.has(urlKey(entry.url_resolved)))
            group.excluded = true;

        const codec = codecOf(entry);
        group.entries.push({
            entry,
            url,
            codec,
            bitrate: entry.bitrate || 0,
            score: qualityScore(codec, entry.bitrate),
        });
    }

    const stations = [];
    for (const group of groups.values()) {
        if (group.excluded)
            continue;

        group.entries.sort((a, b) => b.score - a.score || b.entry.votes - a.entry.votes);
        const best = group.entries[0];
        if (best.codec !== 'FLAC' && best.bitrate < MIN_BITRATE)
            continue;

        const streams = [];
        const urls = new Set();
        for (const variant of group.entries) {
            if (urls.has(streamKey(variant.url)))
                continue;
            urls.add(streamKey(variant.url));
            const stream = {url: variant.url, codec: displayCodec(variant.codec)};
            if (variant.codec !== 'FLAC' && variant.bitrate)
                stream.bitrate = variant.bitrate;
            streams.push(stream);
            if (streams.length === MAX_STREAMS_PER_STATION)
                break;
        }

        stations.push({
            id: `rb:${best.entry.stationuuid}`,
            rbUuid: best.entry.stationuuid,
            name: cleanName(best.entry.name),
            genre: genreOf(best.entry),
            country: best.entry.countrycode ?? '',
            votes: Math.max(...group.entries.map(v => v.entry.votes || 0)),
            tier: qualityTier(best.score),
            score: best.score,
            streams,
        });
    }

    // Highest quality tier first, then the community's favourites.
    stations.sort((a, b) => b.tier - a.tier || b.votes - a.votes || b.score - a.score);
    return stations.slice(0, MAX_STATIONS);
}

export class RadioBrowser {
    /**
     * @param {import('./net.js').HttpClient} http
     * @param {Set<string>} excludeUrls - urlKey()s of the curated streams
     */
    constructor(http, excludeUrls) {
        this._http = http;
        this._excludeUrls = excludeUrls;
        this._server = null;
        this._cacheFile = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'lofi-bar', 'radio-browser.json',
        ]));
    }

    /**
     * Returns the lofi station list, from a fresh cache when possible.
     *
     * @param {object} params
     * @param {boolean} params.force - skip the cache and ask the server
     * @returns {Promise<{stations: object[], fetchedAt: number, stale: boolean}>}
     */
    async load({force = false} = {}) {
        const cached = await this._readCache();
        const now = GLib.get_real_time() / 1e6;
        if (!force && cached && now - cached.fetchedAt < CACHE_TTL_S)
            return {...cached, stale: false};

        try {
            const stations = await this._fetch();
            const result = {stations, fetchedAt: now};
            await this._writeCache(result);
            return {...result, stale: false};
        } catch (e) {
            // Offline or the directory is down: an old list beats no list.
            if (cached)
                return {...cached, stale: true, error: e};
            throw e;
        }
    }

    /**
     * Tells Radio Browser a station was played. The directory asks clients
     * to do this; it drives its popularity ranking.
     *
     * @param {string} uuid
     */
    countClick(uuid) {
        this._getServer()
            .then(server => this._http.getJson(
                `https://${server}/json/url/${encodeURIComponent(uuid)}`))
            .catch(() => {});
    }

    async _fetch() {
        const server = await this._getServer();
        const results = await Promise.allSettled(TAGS.map(tag => {
            const query = `tag=${encodeURIComponent(tag)}&hidebroken=true` +
                `&order=votes&reverse=true&limit=${PER_TAG_LIMIT}`;
            return this._http.getJson(`https://${server}/json/stations/search?${query}`);
        }));

        const entries = results
            .filter(r => r.status === 'fulfilled' && Array.isArray(r.value))
            .flatMap(r => r.value);
        if (entries.length === 0) {
            this._server = null; // try another mirror next time
            const failure = results.find(r => r.status === 'rejected');
            throw failure?.reason ?? new Error('Radio Browser returned no stations');
        }
        return buildStations(entries, this._excludeUrls);
    }

    async _getServer() {
        if (this._server)
            return this._server;

        let names = [];
        try {
            const servers = await this._http.getJson(SERVER_LIST_URL);
            names = [...new Set(servers.map(s => s.name).filter(Boolean))];
        } catch (e) {
            if (isCancelled(e))
                throw e;
        }
        if (names.length === 0)
            names = FALLBACK_SERVERS;
        // The directory asks clients to spread load across its mirrors.
        this._server = names[Math.floor(Math.random() * names.length)];
        return this._server;
    }

    async _readCache() {
        try {
            const info = this._cacheFile.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_size() > MAX_CACHE_BYTES)
                return null;
            const [contents] = await this._cacheFile.load_contents_async(null);
            const data = JSON.parse(new TextDecoder().decode(contents));
            // A timestamp from the future (clock was wrong) counts as stale.
            const now = GLib.get_real_time() / 1e6;
            if (data?.version !== CACHE_VERSION || !Array.isArray(data.stations) ||
                typeof data.fetchedAt !== 'number' || data.fetchedAt > now + 3600)
                return null;
            // The cache is a user-writable file; only keep well-formed stations.
            const stations = data.stations.filter(s =>
                typeof s?.id === 'string' && typeof s.name === 'string' &&
                Array.isArray(s.streams) && s.streams.length > 0 &&
                s.streams.every(stream => isHttpUrl(stream?.url)))
                .map(s => ({...s, name: cleanName(s.name)}));
            return {stations, fetchedAt: data.fetchedAt};
        } catch {
            return null;
        }
    }

    async _writeCache({stations, fetchedAt}) {
        try {
            const dir = this._cacheFile.get_parent();
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            const json = JSON.stringify({version: CACHE_VERSION, fetchedAt, stations});
            await this._cacheFile.replace_contents_bytes_async(
                new GLib.Bytes(new TextEncoder().encode(json)),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            console.warn(`Lofi Bar: could not cache Radio Browser stations: ${e.message}`);
        }
    }
}
