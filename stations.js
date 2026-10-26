// Curated lofi stations, each with its streams ordered best quality first.
// SPDX-License-Identifier: GPL-2.0-or-later
// The player starts with the first stream and only falls back to the next one
// if it cannot connect.
//
// `aliases` are other URLs of the same station, so the Radio Browser list
// does not offer it a second time.
//
// Every stream below was measured by decoding it with GStreamer (codec, real
// bitrate and sample rate), not just by trusting the server's icy headers.
// Two servers that advertise 192 kbps but actually send ~130 kbps were left out.

export const CURATED_STATIONS = [
    {
        id: 'isekoi-chill',
        name: 'ISEKOI Radio · Chill Zone',
        genre: 'Lo-fi · chill',
        // Ogg FLAC carries no ICY titles; AzuraCast's API has them.
        nowPlayingApi: 'https://public.isekoi-radio.com/api/nowplaying/chill',
        streams: [
            {url: 'https://public.isekoi-radio.com/listen/chill/radio.flac', codec: 'FLAC'},
            {url: 'https://public.isekoi-radio.com/listen/chill/radio.mp3', codec: 'MP3', bitrate: 320},
        ],
    },
    {
        id: 'reyfm-lofi',
        name: 'REYFM #lofi',
        genre: 'Lo-fi hip hop',
        streams: [
            {url: 'https://listen.reyfm.de/lofi_320kbps.mp3', codec: 'MP3', bitrate: 320},
            {url: 'https://listen.reyfm.de/lofi_192kbps.mp3', codec: 'MP3', bitrate: 192},
        ],
    },
    {
        id: 'fluxfm-chillhop',
        name: 'FluxFM ChillHop',
        genre: 'Chillhop',
        streams: [
            {url: 'https://streams.fluxfm.de/Chillhop/mp3-320/streams.fluxfm.de/', codec: 'MP3', bitrate: 320},
            {url: 'https://streams.fluxfm.de/Chillhop/mp3-128/streams.fluxfm.de/', codec: 'MP3', bitrate: 128},
        ],
    },
    {
        id: 'lofiradio-ru',
        name: 'LoFi Radio',
        genre: 'Lo-fi beats',
        streams: [
            {url: 'http://live.lofiradio.ru:8000/lofi_mp3_320', codec: 'MP3', bitrate: 320},
            {url: 'http://live.lofiradio.ru:8000/lofi_mp3_128', codec: 'MP3', bitrate: 128},
        ],
    },
    {
        id: 'nightride-chillsynth',
        name: 'Nightride FM · Chillsynth',
        genre: 'Chillsynth · chillwave',
        streams: [
            {url: 'https://stream.nightride.fm/chillsynth.mp3', codec: 'MP3', bitrate: 320},
            {url: 'https://stream.nightride.fm/chillsynth.ogg', codec: 'Opus'},
        ],
    },
    {
        id: 'nts-low-key',
        name: 'NTS · Low Key',
        genre: 'Lo-fi hip hop · R&B',
        streams: [
            {url: 'https://stream-mixtape-geo.ntslive.net/mixtape2', codec: 'MP3', bitrate: 256},
        ],
    },
    {
        id: 'somafm-groovesalad',
        name: 'SomaFM · Groove Salad',
        genre: 'Downtempo · chill beats',
        streams: [
            {url: 'https://ice1.somafm.com/groovesalad-256-mp3', codec: 'MP3', bitrate: 256},
            {url: 'https://ice2.somafm.com/groovesalad-256-mp3', codec: 'MP3', bitrate: 256},
            {url: 'https://ice1.somafm.com/groovesalad-128-aac', codec: 'AAC', bitrate: 128},
        ],
    },
    {
        id: 'ilove-chillhop',
        name: 'I♥Chillhop',
        genre: 'Chillhop',
        streams: [
            {url: 'https://streams.ilovemusic.de/iloveradio17.mp3', codec: 'MP3', bitrate: 192},
        ],
    },
    {
        id: 'kalizo-lofi',
        name: 'Chillofi · Kalizo Lo-Fi',
        genre: 'Lo-fi · study beats',
        streams: [
            {url: 'https://streams.dez.ovh/listen/chillofi/radio.mp3', codec: 'MP3', bitrate: 192},
        ],
        // Radio Browser lists this station twice under these URLs.
        aliases: [
            'http://streams.dez.ovh:8000/radio.mp3',
            'http://rdstream-0625.dez.ovh:8000/radio.mp3',
        ],
    },
    {
        id: '0nlineradio-lofi',
        name: '0nlineradio Lo-Fi',
        genre: 'Lo-fi · study',
        streams: [
            {url: 'https://stream.0nlineradio.com/lo-fi', codec: 'MP3', bitrate: 192},
        ],
        aliases: ['https://0nlineradio.radioho.st/0r-lo-fi'],
    },
    {
        id: 'epic-lounge-jazzhop',
        name: 'Epic Lounge · Jazzhop',
        genre: 'Jazzhop',
        streams: [
            {url: 'https://stream.epic-lounge.com/jazzhop-lounge', codec: 'MP3', bitrate: 192},
        ],
    },
    {
        id: 'radiotedu-lofi',
        name: 'RadioTEDU Lo-Fi',
        genre: 'Lo-fi · Ankara',
        streams: [
            {url: 'https://stream.radiotedu.com/lofi', codec: 'AAC', bitrate: 192},
        ],
    },
];

/**
 * Short quality badge for a stream, e.g. "FLAC" or "320k MP3".
 *
 * @param {{codec?: string, bitrate?: number}} stream
 * @returns {string}
 */
export function qualityBadge(stream) {
    if (!stream)
        return '';
    if (stream.codec === 'FLAC')
        return 'FLAC';
    if (stream.bitrate)
        return `${stream.bitrate}k ${stream.codec ?? ''}`.trim();
    return stream.codec ?? '';
}
