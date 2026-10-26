// Runs player.js in its own gjs process and speaks its JSON-lines protocol.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Keeping GStreamer out of the gnome-shell process means a crashing decoder
// or a hung network read cannot freeze or kill the desktop session.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// How long a stopped player gets to exit on its own before we kill it.
const EXIT_GRACE_S = 3;

export class PlayerProcess {
    /**
     * @param {string} playerPath - absolute path of player.js
     * @param {object} handlers
     * @param {(event: object) => void} handlers.onEvent - a parsed player event
     * @param {(message?: string) => void} handlers.onCrash - the player died
     *   (or could not start) without being asked to stop
     */
    constructor(playerPath, {onEvent, onCrash}) {
        this._playerPath = playerPath;
        this._onEvent = onEvent;
        this._onCrash = onCrash;
        this._proc = null;
        this._stdin = null;
        this._cancellable = null;
        this._queue = [];
        this._writing = false;
        this._closeAfterWrite = new Set();
        this._killTimers = new Map();
    }

    get running() {
        return this._proc !== null;
    }

    /**
     * Sends a command, starting the player process first if needed.
     *
     * @param {object} command
     */
    send(command) {
        if (!this._proc && !this._spawn())
            return;
        // Slider drags produce many volume changes; only the last one matters.
        if (command.cmd === 'volume')
            this._queue = this._queue.filter(c => c.cmd !== 'volume');
        this._queue.push(command);
        this._pump();
    }

    /** Sends a command only if the player is already running. */
    sendIfRunning(command) {
        if (this._proc)
            this.send(command);
    }

    /** Stops playback by ending the player process. */
    stop() {
        const proc = this._proc;
        if (!proc)
            return;
        this._detach();

        // Closing stdin makes the player shut down cleanly; kill it if not.
        const id = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, EXIT_GRACE_S, () => {
            this._killTimers.delete(proc);
            proc.force_exit();
            return GLib.SOURCE_REMOVE;
        });
        this._killTimers.set(proc, id);
        proc.wait_async(null, () => {
            const timer = this._killTimers.get(proc);
            if (timer) {
                GLib.source_remove(timer);
                this._killTimers.delete(proc);
            }
        });
    }

    destroy() {
        const proc = this._proc;
        this._detach();
        proc?.force_exit();
        for (const [pending, id] of this._killTimers) {
            GLib.source_remove(id);
            pending.force_exit();
        }
        this._killTimers.clear();
    }

    /** @returns {boolean} whether the player process started */
    _spawn() {
        const gjs = GLib.find_program_in_path('gjs') ?? '/usr/bin/gjs';
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE,
        });
        // Lets PulseAudio/PipeWire classify the stream as music.
        launcher.setenv('PULSE_PROP', 'media.role=music application.icon_name=audio-headphones', true);

        let proc;
        try {
            proc = launcher.spawnv([gjs, '-m', this._playerPath]);
        } catch (e) {
            console.warn(`Lofi Bar: could not start the player: ${e.message}`);
            this._onCrash('Could not start the audio player (is gjs installed?)');
            return false;
        }
        const cancellable = new Gio.Cancellable();
        this._proc = proc;
        this._stdin = proc.get_stdin_pipe();
        this._cancellable = cancellable;
        this._queue = [];
        this._writing = false;

        const stdout = new Gio.DataInputStream({
            base_stream: proc.get_stdout_pipe(),
            close_base_stream: true,
        });
        this._readLine(stdout, cancellable);

        proc.wait_async(null, () => {
            if (this._proc !== proc)
                return; // we stopped it on purpose
            this._detach();
            this._onCrash();
        });
        return true;
    }

    _detach() {
        // Stops the stdout reader. Writes use no cancellable: cancelling one
        // in flight would leave stdin unclosable ("outstanding operation").
        this._cancellable?.cancel();
        const stdin = this._stdin;
        if (stdin) {
            // Closing stdin is what tells the player to quit. A pending write
            // blocks close(), so close right after it finishes instead.
            if (this._writing)
                this._closeAfterWrite.add(stdin);
            else
                closeQuietly(stdin);
        }
        this._proc = null;
        this._stdin = null;
        this._cancellable = null;
        this._queue = [];
        this._writing = false;
    }

    _readLine(stdout, cancellable) {
        stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, res) => {
            let line;
            try {
                [line] = stream.read_line_finish_utf8(res);
            } catch {
                return; // cancelled, or the pipe broke because the player exited
            }
            if (line === null || cancellable.is_cancelled())
                return;

            let event = null;
            try {
                event = JSON.parse(line);
            } catch {
                console.warn(`Lofi Bar: unexpected player output: ${line}`);
            }
            if (event)
                this._onEvent(event);
            this._readLine(stream, cancellable);
        });
    }

    _pump() {
        if (this._writing || !this._stdin || this._queue.length === 0)
            return;

        const stdin = this._stdin;
        const line = `${JSON.stringify(this._queue.shift())}\n`;
        this._writing = true;
        stdin.write_bytes_async(new GLib.Bytes(new TextEncoder().encode(line)),
            GLib.PRIORITY_DEFAULT, null, (stream, res) => {
                try {
                    stream.write_bytes_finish(res);
                } catch {}
                if (this._closeAfterWrite.delete(stream)) {
                    closeQuietly(stream);
                    return;
                }
                if (this._stdin !== stdin)
                    return; // the process was stopped or replaced meanwhile
                this._writing = false;
                this._pump();
            });
    }
}

function closeQuietly(stream) {
    try {
        stream.close(null);
    } catch (e) {
        console.warn(`Lofi Bar: could not close the player pipe: ${e.message}`);
    }
}
