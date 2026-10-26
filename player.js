// Lofi Bar audio player.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// playerProcess.js imports PLAYER_PATH from this module and runs it as a
// subprocess (`gjs -m player.js`). Importing it has no side effects: all
// work, including loading GStreamer, happens in main(), which only runs when
// this file is the program being executed. GStreamer therefore never loads
// inside the gnome-shell process.
//
// Runs as a separate `gjs -m` process so that a misbehaving decoder or a
// network stall can never take GNOME Shell down with it. The extension talks
// to it with newline-delimited JSON: commands on stdin, events on stdout.
//
// Commands:
//   {"cmd": "play", "seq": 1, "streams": [{"url": "..."}, ...], "volume": 0.5}
//   {"cmd": "volume", "value": 0.5}
//   {"cmd": "stop"}
//
// Events (each carries the "seq" of the play command it belongs to):
//   {"event": "state", "state": "connecting" | "buffering" | "playing" | "reconnecting" | "stopped", ...}
//   {"event": "tags", "title": "...", "organization": "...", "codec": "MP3", "bitrate": 320}
//   {"event": "format", "rate": 48000, "channels": 2, "format": "S16LE"}
//   {"event": "error", "message": "...", "fatal": true}
//
// The process exits when stdin is closed.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

/** Absolute path of this script, for spawning it as the player process. */
export const PLAYER_PATH = GLib.filename_from_uri(import.meta.url)[0];

// Loaded in main(), only inside the player process.
let Gst = null;

const USER_AGENT = 'LofiBar/1.0 (GNOME Shell extension; GStreamer)';

// Give up on a stream if it has not started playing within this time.
const START_TIMEOUT_S = 20;
// Treat a mid-stream stall (buffering that never recovers) as a failure.
const STALL_TIMEOUT_S = 30;
// Playing this long without trouble resets the retry counter.
const STABLE_AFTER_S = 30;
// Delay before each full retry round over all streams.
const BACKOFF_S = [2, 4, 8, 15, 30];
// Forward at most one track title per this interval; some servers flap.
const TITLE_INTERVAL_US = 1000 * 1000;

// GstPlayFlags: audio + soft-volume. No video, subtitles or visualisations.
const PLAY_FLAGS = 0x2 | 0x10;

// Sequence number of the current play command; echoed on every event so
// the extension can drop lines written for a previous station.
let currentSeq;

function emit(obj) {
    print(JSON.stringify(currentSeq === undefined ? obj : {...obj, seq: currentSeq}));
}

function isHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url);
}

function shortCodec(codec) {
    if (!codec)
        return null;
    const c = codec.toLowerCase();
    if (c.includes('flac'))
        return 'FLAC';
    if (c.includes('opus'))
        return 'Opus';
    if (c.includes('vorbis'))
        return 'Vorbis';
    if (c.includes('aac'))
        return 'AAC';
    if (c.includes('layer 3') || c.includes('mp3'))
        return 'MP3';
    return codec;
}

class Player {
    constructor(loop) {
        this._loop = loop;
        this._streams = [];
        this._index = 0;
        this._attempt = 0;
        this._volume = 0.5;
        this._wanted = false; // whether the user wants audio right now
        this._everPlayed = false; // whether the current stream reached PLAYING
        this._buffering = false;
        this._timers = new Map();
        this._lastTags = {};
        this._lastTitleTime = 0;
        this._sentTitle = null;

        this._pipeline = Gst.ElementFactory.make('playbin3', 'lofi-bar') ??
            Gst.ElementFactory.make('playbin', 'lofi-bar');
        if (!this._pipeline) {
            emit({event: 'error', message: 'GStreamer playbin is not available', fatal: true});
            System.exit(1);
        }
        this._pipeline.flags = PLAY_FLAGS;
        // A pass-through element after the decoder lets us read the decoded
        // sample format (bit depth / sample rate) for the quality display.
        this._probe = Gst.ElementFactory.make('identity', 'format-probe');
        if (this._probe)
            this._pipeline.audio_filter = this._probe;

        this._pipeline.connect('source-setup', (_pb, source) => {
            if ('user_agent' in source)
                source.user_agent = USER_AGENT;
            if ('timeout' in source)
                source.timeout = 15;
            if ('iradio_mode' in source)
                source.iradio_mode = true;
        });

        this._bus = this._pipeline.get_bus();
        this._bus.add_signal_watch();
        this._bus.connect('message', (_bus, msg) => this._onMessage(msg));
    }

    play(streams, volume, seq) {
        currentSeq = seq;
        streams = Array.isArray(streams) ? streams.filter(s => isHttpUrl(s?.url)) : [];
        if (streams.length === 0) {
            this._wanted = false;
            this._clearTimers();
            this._reset();
            emit({event: 'error', message: 'No playable http(s) stream URL', fatal: true});
            return;
        }
        this._streams = streams;
        this._attempt = 0;
        this._wanted = true;
        if (typeof volume === 'number')
            this.setVolume(volume);
        this._start(0);
    }

    stop() {
        this._wanted = false;
        this._clearTimers();
        this._reset();
        emit({event: 'state', state: 'stopped'});
    }

    setVolume(value) {
        this._volume = Math.min(1, Math.max(0, value));
        // The slider is perceptual (cubic); playbin's soft volume is linear.
        this._pipeline.volume = this._volume ** 3;
    }

    shutdown() {
        this._wanted = false;
        this._clearTimers();
        this._reset();
        this._loop.quit();
    }

    // Stops the pipeline and drops bus messages still queued for the old
    // stream, so a late error or tag is not taken for the next one.
    _reset() {
        this._bus.set_flushing(true);
        this._pipeline.set_state(Gst.State.NULL);
        this._bus.set_flushing(false);
    }

    _start(index, extra = {}) {
        this._clearTimers();
        this._reset();

        this._index = index;
        this._everPlayed = false;
        this._buffering = false;
        this._lastTags = {};
        this._lastTitleTime = 0;
        this._sentTitle = null;

        const stream = this._streams[index];
        emit({event: 'state', state: 'connecting', stream: index, url: stream.url, ...extra});

        this._pipeline.uri = stream.url;
        this.setVolume(this._volume);
        const ret = this._pipeline.set_state(Gst.State.PLAYING);
        if (ret === Gst.StateChangeReturn.FAILURE) {
            this._fail('Could not start the stream');
            return;
        }
        this._setTimer('watchdog', START_TIMEOUT_S, () =>
            this._fail('Timed out while connecting'));
    }

    _fail(message) {
        if (!this._wanted)
            return;
        this._clearTimers();
        this._reset();

        // Never got going on this stream: fall back to the next-best format.
        if (!this._everPlayed && this._index + 1 < this._streams.length) {
            this._start(this._index + 1, {fallback: true, reason: message});
            return;
        }

        if (this._attempt >= BACKOFF_S.length) {
            this._wanted = false;
            emit({event: 'error', message, fatal: true});
            emit({event: 'state', state: 'stopped'});
            return;
        }

        const delay = BACKOFF_S[this._attempt];
        this._attempt++;
        emit({event: 'state', state: 'reconnecting', delay, attempt: this._attempt, reason: message});
        // Always come back to the best-quality stream first.
        this._setTimer('retry', delay, () => this._start(0));
    }

    _onMessage(msg) {
        switch (msg.type) {
        case Gst.MessageType.ERROR: {
            const [error] = msg.parse_error();
            printerr(`lofi-bar player: ${error.message} (${this._pipeline.uri})`);
            this._fail(error.message);
            break;
        }
        case Gst.MessageType.EOS:
            // A radio stream should never end; the server dropped us.
            this._fail('Stream ended');
            break;
        case Gst.MessageType.BUFFERING:
            this._onBuffering(msg.parse_buffering());
            break;
        case Gst.MessageType.STATE_CHANGED:
            if (msg.src === this._pipeline) {
                const [, newState] = msg.parse_state_changed();
                if (newState === Gst.State.PLAYING)
                    this._onPlaying();
            }
            break;
        case Gst.MessageType.TAG:
            this._onTags(msg.parse_tag());
            break;
        }
    }

    _onBuffering(percent) {
        if (!this._wanted)
            return;
        if (percent < 100) {
            if (!this._buffering) {
                this._buffering = true;
                this._pipeline.set_state(Gst.State.PAUSED);
                if (this._everPlayed) {
                    this._setTimer('watchdog', STALL_TIMEOUT_S, () =>
                        this._fail('Stream stalled'));
                }
            }
            emit({event: 'state', state: 'buffering', percent});
        } else if (this._buffering) {
            this._buffering = false;
            this._pipeline.set_state(Gst.State.PLAYING);
        }
    }

    _onPlaying() {
        if (!this._wanted || this._buffering)
            return;
        this._clearTimer('watchdog');
        this._everPlayed = true;
        emit({event: 'state', state: 'playing', stream: this._index});
        this._emitFormat();
        this._setTimer('stable', STABLE_AFTER_S, () => {
            this._attempt = 0;
        });
    }

    _emitFormat() {
        const caps = this._probe?.get_static_pad('src')?.get_current_caps();
        if (!caps || caps.get_size() === 0)
            return;
        const s = caps.get_structure(0);
        const [, rate] = s.get_int('rate');
        const [, channels] = s.get_int('channels');
        emit({event: 'format', rate, channels, format: s.get_string('format')});
    }

    _onTags(tags) {
        if (!this._wanted)
            return;
        const out = {};
        const str = key => {
            const [ok, value] = tags.get_string(key);
            return ok ? value : null;
        };
        const uint = key => {
            const [ok, value] = tags.get_uint(key);
            return ok ? value : null;
        };

        const title = str(Gst.TAG_TITLE);
        const artist = str(Gst.TAG_ARTIST);
        if (title !== null)
            out.title = artist && !title.includes(artist) ? `${artist} - ${title}` : title;

        const organization = str(Gst.TAG_ORGANIZATION);
        if (organization !== null)
            out.organization = organization;

        const codec = shortCodec(str(Gst.TAG_AUDIO_CODEC));
        if (codec)
            out.codec = codec;

        // Lossless streams have a meaningless, constantly changing bitrate.
        const lossless = (codec ?? this._lastTags.codec) === 'FLAC';
        const bitrate = uint(Gst.TAG_NOMINAL_BITRATE) ?? uint(Gst.TAG_BITRATE);
        if (bitrate && !lossless) {
            const kbps = Math.round(bitrate / 1000);
            const last = this._lastTags.bitrate;
            // Ignore the small jitter of measured (non-nominal) bitrates.
            if (!last || Math.abs(kbps - last) / last > 0.08)
                out.bitrate = kbps;
        }

        // Only forward what changed; streams re-send the same tags a lot.
        const changed = Object.keys(out).filter(k => this._lastTags[k] !== out[k]);
        if (changed.length === 0)
            return;
        Object.assign(this._lastTags, out);
        const delta = {event: 'tags'};
        for (const k of changed)
            delta[k] = out[k];

        if ('title' in delta) {
            const now = GLib.get_monotonic_time();
            if (delta.title === this._sentTitle) {
                // Flapped back to what the extension already shows.
                delete delta.title;
                this._clearTimer('title');
            } else if (now - this._lastTitleTime < TITLE_INTERVAL_US) {
                // Too soon: send the latest title once the interval is over.
                delete delta.title;
                this._setTimer('title', 1, () => this._flushTitle());
            } else {
                this._lastTitleTime = now;
                this._sentTitle = delta.title;
                this._clearTimer('title');
            }
        }
        if (Object.keys(delta).length > 1)
            emit(delta);
    }

    _flushTitle() {
        const title = this._lastTags.title;
        if (title === this._sentTitle)
            return; // flapped back to what the extension already shows
        this._lastTitleTime = GLib.get_monotonic_time();
        this._sentTitle = title;
        emit({event: 'tags', title});
    }

    _setTimer(name, seconds, callback) {
        this._clearTimer(name);
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timers.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.set(name, id);
    }

    _clearTimer(name) {
        const id = this._timers.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timers.delete(name);
        }
    }

    _clearTimers() {
        for (const name of [...this._timers.keys()])
            this._clearTimer(name);
    }
}

async function openStdin() {
    // GLib 2.80 moved the Unix streams to GioUnix; keep older GLib working.
    let GioUnix = null;
    try {
        ({default: GioUnix} = await import('gi://GioUnix'));
    } catch {}
    const base = GioUnix?.InputStream
        ? new GioUnix.InputStream({fd: 0, close_fd: false})
        : new Gio.UnixInputStream({fd: 0, close_fd: false});
    return new Gio.DataInputStream({base_stream: base});
}

function handle(player, line) {
    let msg;
    try {
        msg = JSON.parse(line);
    } catch {
        printerr(`lofi-bar player: ignoring malformed command: ${line}`);
        return;
    }
    switch (msg.cmd) {
    case 'play':
        player.play(msg.streams, msg.volume, msg.seq);
        break;
    case 'volume':
        player.setVolume(Number(msg.value));
        break;
    case 'stop':
        player.stop();
        break;
    case 'quit':
        player.shutdown();
        break;
    }
}

function readNext(player, stdin) {
    stdin.read_line_async(GLib.PRIORITY_DEFAULT, null, (stream, res) => {
        let line;
        try {
            [line] = stream.read_line_finish_utf8(res);
        } catch (e) {
            printerr(`lofi-bar player: stdin error: ${e.message}`);
            player.shutdown();
            return;
        }
        if (line === null) {
            // The extension went away (disabled, shell restarted, ...).
            player.shutdown();
            return;
        }
        if (line.trim())
            handle(player, line);
        readNext(player, stdin);
    });
}

async function main() {
    GLib.set_prgname('lofi-bar');
    GLib.set_application_name('Lofi Bar');
    ({default: Gst} = await import('gi://Gst?version=1.0'));
    Gst.init(null);

    // Radio streams are plain HTTP. Adaptive-streaming demuxers (HLS, DASH,
    // Smooth Streaming) fetch the URIs listed in a playlist on their own,
    // file:// included, so a hostile "station" could make us read local
    // files. Rank NONE keeps them out of autoplugging.
    for (const name of ['hlsdemux', 'hlsdemux2', 'dashdemux', 'dashdemux2', 'mssdemux', 'mssdemux2'])
        Gst.Registry.get().lookup_feature(name)?.set_rank(Gst.Rank.NONE);

    const loop = new GLib.MainLoop(null, false);
    const player = new Player(loop);
    const stdin = await openStdin();
    readNext(player, stdin);
    loop.run();
    System.exit(0);
}

if (System.programPath === PLAYER_PATH)
    await main();
