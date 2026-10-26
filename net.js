// Small libsoup 3 wrapper: one session, one cancellable, JSON GETs.
// SPDX-License-Identifier: GPL-2.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

Gio._promisify(Soup.Session.prototype, 'send_async');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async');
Gio._promisify(Gio.InputStream.prototype, 'close_async');

export const USER_AGENT = 'LofiBar/1.0 (GNOME Shell extension)';

// Responses are parsed on the shell's main thread; refuse anything that is
// far larger than a real API answer (a 300-station search is ~100 kB).
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;

export class HttpClient {
    constructor() {
        this._session = new Soup.Session({user_agent: USER_AGENT, timeout: 15});
        this._cancellable = new Gio.Cancellable();
    }

    /**
     * @param {string} url
     * @returns {Promise<any>} the parsed JSON body
     */
    async getJson(url) {
        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new Error(`Invalid URL: ${url}`);
        message.request_headers.append('Accept', 'application/json');

        const stream = await this._session.send_async(
            message, GLib.PRIORITY_DEFAULT, this._cancellable);
        try {
            const status = message.get_status();
            if (status !== Soup.Status.OK)
                throw new Error(`HTTP ${status} from ${message.get_uri().get_host()}`);
            if (message.response_headers.get_content_length() > MAX_BODY_BYTES)
                throw new Error('Response too large');

            const chunks = [];
            let total = 0;
            for (;;) {
                const bytes = await stream.read_bytes_async(
                    CHUNK_BYTES, GLib.PRIORITY_DEFAULT, this._cancellable);
                const size = bytes.get_size();
                if (size === 0)
                    break;
                total += size;
                if (total > MAX_BODY_BYTES)
                    throw new Error('Response too large');
                chunks.push(bytes.toArray());
            }

            const body = new Uint8Array(total);
            let offset = 0;
            for (const chunk of chunks) {
                body.set(chunk, offset);
                offset += chunk.length;
            }
            return JSON.parse(new TextDecoder().decode(body));
        } finally {
            stream.close_async(GLib.PRIORITY_DEFAULT, null).catch(() => {});
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._session.abort();
        this._session = null;
    }
}

/**
 * @param {Error} error
 * @returns {boolean} whether the error only means we cancelled the request
 */
export function isCancelled(error) {
    return error instanceof GLib.Error &&
        error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}
