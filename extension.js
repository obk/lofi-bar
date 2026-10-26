// Lofi Bar: lofi radio in the GNOME Shell top bar.
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

import {CURATED_STATIONS, qualityBadge} from './stations.js';
import {HttpClient, isCancelled} from './net.js';
import {RadioBrowser, urlKey} from './radioBrowser.js';
import {PlayerProcess} from './playerProcess.js';

const VOLUME_SAVE_DELAY_MS = 400;
const SCROLL_VOLUME_STEP = 0.05;
const NOW_PLAYING_MIN_S = 10;
const NOW_PLAYING_MAX_S = 60;

// Opacity for secondary text; works with both the light and dark shell style.
const DIM = 165;

// Titles some stations send instead of a track name.
const PLACEHOLDER_TITLES = new Set(['', 'no name', 'unknown', 'radio', 'live', '-']);

/** Formats a sample rate like "44.1 kHz". */
function formatRate(rate) {
    if (!rate)
        return '';
    const khz = rate / 1000;
    return `${Number.isInteger(khz) ? khz : khz.toFixed(1)} kHz`;
}

/** Bit depth of a decoded PCM format such as "S16LE", if meaningful. */
function bitDepth(format) {
    const match = /^S(\d+)/.exec(format ?? '');
    if (!match)
        return null;
    return match[1] === '24_32' ? 24 : Number(match[1]);
}

function timeAgo(seconds) {
    const minutes = Math.round(seconds / 60);
    if (minutes < 1)
        return 'just now';
    if (minutes < 60)
        return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48)
        return `${hours} h ago`;
    return `${Math.round(hours / 24)} days ago`;
}

/** Turns a GStreamer/player error into something a listener understands. */
function friendlyError(message) {
    const m = message ?? '';
    if (/not found|\b404\b/i.test(m))
        return 'Stream not found';
    if (/forbidden|\b40[13]\b|unauthori/i.test(m))
        return 'The station refused the connection';
    if (/resolv/i.test(m))
        return 'Could not reach the station · check your connection';
    if (/timed? ?out/i.test(m))
        return 'The station did not respond';
    if (/internal data stream|could not (connect|establish)|connection refused|stream ended|stalled/i.test(m))
        return 'Could not connect to the station';
    if (/plug-?in|no decoder|codec/i.test(m))
        return 'This stream format is not supported';
    return m || 'Playback failed';
}

function ellipsize(label) {
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

const StationItem = GObject.registerClass(
class LofiBarStationItem extends PopupMenu.PopupBaseMenuItem {
    _init(station, onSelect) {
        super._init({style_class: 'lofi-bar-station-item'});
        this.station = station;
        this._onSelect = onSelect;

        const text = new St.BoxLayout({
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'lofi-bar-station-text',
        });
        const name = ellipsize(new St.Label({
            text: station.name,
            style_class: 'lofi-bar-station-name',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        text.add_child(name);
        if (station.genre) {
            text.add_child(ellipsize(new St.Label({
                text: station.genre,
                style_class: 'lofi-bar-station-genre',
                y_align: Clutter.ActorAlign.CENTER,
                opacity: DIM,
            })));
        }
        this.add_child(text);
        this.label_actor = name;

        const best = station.streams[0];
        const badge = new St.Label({
            text: qualityBadge(best),
            style_class: 'lofi-bar-badge',
            y_align: Clutter.ActorAlign.CENTER,
        });
        if (best?.codec === 'FLAC')
            badge.add_style_class_name('lofi-bar-badge-lossless');
        this.add_child(badge);

        this.setOrnament(PopupMenu.Ornament.NO_DOT);
    }

    // Keep the menu open so the listener sees the station connect.
    activate(_event) {
        this._onSelect(this.station);
    }
});

const RefreshItem = GObject.registerClass(
class LofiBarRefreshItem extends PopupMenu.PopupImageMenuItem {
    _init(onRefresh) {
        super._init('Refresh list', 'view-refresh-symbolic');
        this._onRefresh = onRefresh;
        this.label.x_expand = true;
        this.status = ellipsize(new St.Label({
            style_class: 'lofi-bar-refresh-status',
            y_align: Clutter.ActorAlign.CENTER,
            opacity: DIM,
        }));
        this.add_child(this.status);
    }

    activate(_event) {
        this._onRefresh();
    }
});

const LofiIndicator = GObject.registerClass(
class LofiBarIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Lofi Bar');

        this._settings = extension.getSettings();
        this._http = new HttpClient();
        this._radioBrowser = new RadioBrowser(this._http, new Set(
            CURATED_STATIONS.flatMap(s => [...s.streams.map(stream => stream.url), ...s.aliases ?? []])
                .map(urlKey)));
        this._player = new PlayerProcess({
            onEvent: event => this._onPlayerEvent(event),
            onCrash: message => this._onPlayerCrash(message),
        });

        this._station = this._loadLastStation();
        this._status = 'stopped';
        this._statusDetail = '';
        this._title = null;
        this._live = {};
        this._timers = new Map();
        this._playSeq = 0;
        this._destroyed = false;
        this._stationItems = [];
        this._discoverLoaded = false;
        this._discoverLoading = false;
        this._volume = this._settings.get_double('volume');

        this._buildPanelButton(extension.path);
        this._buildMenu();

        this._settings.connectObject(
            'changed::show-title', () => this._sync(),
            'changed::volume', () => this._onVolumeSetting(),
            this);
        this.connect('scroll-event', (_actor, event) => this._onScroll(event));

        this._sync();
    }

    // ---- UI construction ------------------------------------------------

    _buildPanelButton(path) {
        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                GLib.build_filenamev([path, 'icons', 'lofi-bar-symbolic.svg'])),
            style_class: 'system-status-icon',
        });
        this._panelLabel = ellipsize(new St.Label({
            style_class: 'lofi-bar-panel-label',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        }));
        box.add_child(this._icon);
        box.add_child(this._panelLabel);
        this.add_child(box);
    }

    _buildMenu() {
        this.menu.box.add_style_class_name('lofi-bar-menu');

        // The header rows are plain actors, not menu items: GNOME styles
        // non-activatable menu items as insensitive (greyed out). The date
        // menu adds its custom rows to menu.box the same way. They must be
        // reactive too, or St gives them the :insensitive pseudo class.

        // Now playing: station, track, stream quality and a play/stop button.
        const nowRow = new St.BoxLayout({
            style_class: 'popup-menu-item lofi-bar-now-playing',
            reactive: true,
        });
        const text = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._stationLabel = ellipsize(new St.Label({style_class: 'lofi-bar-now-station'}));
        this._titleLabel = ellipsize(new St.Label({style_class: 'lofi-bar-now-title'}));
        this._statusLabel = ellipsize(new St.Label({style_class: 'lofi-bar-now-status'}));
        text.add_child(this._stationLabel);
        text.add_child(this._titleLabel);
        text.add_child(this._statusLabel);
        nowRow.add_child(text);

        this._playIcon = new St.Icon({icon_name: 'media-playback-start-symbolic'});
        this._playButton = new St.Button({
            style_class: 'icon-button lofi-bar-play-button',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            child: this._playIcon,
            accessible_name: 'Play',
        });
        this._playButton.connectObject('clicked', () => this._togglePlayback(), this);
        nowRow.add_child(this._playButton);
        this.menu.box.add_child(nowRow);

        // Volume
        const volumeRow = new St.BoxLayout({
            style_class: 'popup-menu-item lofi-bar-volume',
            reactive: true,
        });
        this._volumeIcon = new St.Icon({
            style_class: 'popup-menu-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._slider = new Slider(this._volume);
        this._slider.accessible_name = 'Volume';
        this._slider.connectObject('notify::value', () => this._onSliderChanged(), this);
        volumeRow.add_child(this._volumeIcon);
        volumeRow.add_child(this._slider);
        this.menu.box.add_child(volumeRow);
        this._syncVolumeIcon();

        // Curated, measured best-quality stations
        this._curatedSection = new PopupMenu.PopupMenuSection();
        this._curatedSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem('Best quality'));
        for (const station of CURATED_STATIONS)
            this._addStationItem(this._curatedSection, station);
        this.menu.addMenuItem(this._curatedSection);

        // More lofi stations from Radio Browser, fetched on demand
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._discoverItem = new PopupMenu.PopupSubMenuMenuItem('More lofi stations', true);
        this._discoverItem.icon.icon_name = 'system-search-symbolic';
        this._discoverItem.menu.connect('open-state-changed', (_menu, open) => {
            // Accordion: give the Radio Browser list the curated list's room,
            // otherwise it only gets a row or two on small screens.
            this._curatedSection.actor.visible = !open;
            if (open)
                this._loadDiscover(false);
        });
        this._refreshItem = new RefreshItem(() => this._loadDiscover(true));
        this._refreshItem.status.text = 'Radio Browser';
        this._discoverItem.menu.addMenuItem(this._refreshItem);
        this._discoverSection = new PopupMenu.PopupMenuSection();
        this._discoverItem.menu.addMenuItem(this._discoverSection);
        this.menu.addMenuItem(this._discoverItem);

        // Preferences
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const showTitle = new PopupMenu.PopupSwitchMenuItem('Show track in top bar',
            this._settings.get_boolean('show-title'));
        this._settings.bind('show-title', showTitle, 'state', Gio.SettingsBindFlags.DEFAULT);
        this.menu.addMenuItem(showTitle);
    }

    _addStationItem(menu, station) {
        const item = new StationItem(station, s => this._select(s));
        menu.addMenuItem(item);
        this._stationItems.push(item);
        return item;
    }

    // ---- Playback -------------------------------------------------------

    _select(station) {
        if (this._isActive() && this._station?.id === station.id)
            return;
        this._play(station);
    }

    _play(station) {
        this._station = station;
        this._saveLastStation(station);
        this._title = null;
        this._live = {};
        this._setStatus('connecting');

        // The player echoes this number on every event, so lines it wrote
        // for the previous station are ignored.
        this._playSeq++;
        this._player.send({
            cmd: 'play',
            seq: this._playSeq,
            streams: station.streams.map(s => ({url: s.url})),
            volume: this._volume,
        });
        if (!this._isActive())
            return; // the player could not start
        if (station.rbUuid)
            this._radioBrowser.countClick(station.rbUuid);
        this._scheduleNowPlaying(0);
    }

    _stop() {
        this._player.stop();
        this._clearTimer('now-playing');
        this._title = null;
        this._live = {};
        this._setStatus('stopped');
    }

    _togglePlayback() {
        if (this._isActive())
            this._stop();
        else
            this._play(this._station ?? CURATED_STATIONS[0]);
    }

    _isActive() {
        return this._status !== 'stopped' && this._status !== 'error';
    }

    _setStatus(status, detail = '') {
        this._status = status;
        this._statusDetail = detail;
        this._sync();
    }

    _onPlayerEvent(event) {
        if (event.seq !== undefined && event.seq !== this._playSeq)
            return;
        // Stopped meanwhile: late lines from the old stream. Fatal errors
        // still pass, the 'error' case below checks the state itself.
        if (!this._isActive() && event.event !== 'error')
            return;

        switch (event.event) {
        case 'state':
            this._onPlayerState(event);
            break;
        case 'tags':
            // Record the station name first: the title filter compares to it.
            if (event.organization)
                this._live.organization = event.organization;
            if ('title' in event)
                this._onStreamTitle(event.title);
            if (event.codec)
                this._live.codec = event.codec;
            if (event.bitrate)
                this._live.bitrate = event.bitrate;
            this._sync();
            break;
        case 'format':
            this._live.rate = event.rate;
            this._live.format = event.format;
            this._sync();
            break;
        case 'error':
            if (event.fatal && this._isActive()) {
                this._player.stop();
                this._clearTimer('now-playing');
                this._setStatus('error', friendlyError(event.message));
            }
            break;
        }
    }

    _onPlayerState(event) {
        switch (event.state) {
        case 'connecting':
            this._live = {stream: event.stream ?? 0};
            this._setStatus('connecting', event.fallback ? 'trying a fallback stream' : '');
            break;
        case 'buffering':
            this._setStatus('buffering', `${event.percent ?? 0}%`);
            break;
        case 'playing':
            this._live.stream = event.stream ?? 0;
            this._setStatus('playing');
            break;
        case 'reconnecting':
            this._setStatus('reconnecting', `retrying in ${event.delay} s`);
            break;
        case 'stopped':
            if (this._status !== 'error')
                this._setStatus('stopped');
            break;
        }
    }

    _onPlayerCrash(message) {
        this._clearTimer('now-playing');
        if (this._isActive())
            this._setStatus('error', message ?? 'The player stopped unexpectedly');
    }

    _onStreamTitle(title) {
        // Stations with a now-playing API get their titles from there.
        if (this._station?.nowPlayingApi)
            return;
        const clean = (title ?? '').trim();
        const lower = clean.toLowerCase();
        if (PLACEHOLDER_TITLES.has(lower) ||
            lower === this._station?.name.toLowerCase() ||
            lower === this._live.organization?.toLowerCase())
            return;
        this._title = clean;
    }

    // AzuraCast stations (the FLAC one) publish titles over HTTP instead of
    // in the stream. Poll just after each track is due to change.
    _scheduleNowPlaying(seconds) {
        this._clearTimer('now-playing');
        if (!this._station?.nowPlayingApi)
            return;
        this._setTimer('now-playing', seconds * 1000, () => this._pollNowPlaying());
    }

    async _pollNowPlaying() {
        const station = this._station;
        let next = NOW_PLAYING_MAX_S;
        try {
            const data = await this._http.getJson(station.nowPlayingApi);
            if (this._destroyed || this._station !== station || !this._isActive())
                return;
            const song = data?.now_playing?.song;
            const title = song?.text || [song?.artist, song?.title].filter(Boolean).join(' - ');
            this._title = title || null;
            const remaining = Number(data?.now_playing?.remaining);
            if (remaining > 0)
                next = Math.min(NOW_PLAYING_MAX_S, Math.max(NOW_PLAYING_MIN_S, remaining + 2));
            this._sync();
        } catch (e) {
            if (isCancelled(e) || this._destroyed)
                return;
        }
        if (!this._destroyed && this._station === station && this._isActive())
            this._scheduleNowPlaying(next);
    }

    // ---- Volume ---------------------------------------------------------

    _onSliderChanged() {
        this._volume = this._slider.value;
        this._player.sendIfRunning({cmd: 'volume', value: this._volume});
        this._syncVolumeIcon();
        this._setTimer('volume-save', VOLUME_SAVE_DELAY_MS, () => {
            if (this._settings.get_double('volume') !== this._volume)
                this._settings.set_double('volume', this._volume);
        });
    }

    _onVolumeSetting() {
        const value = this._settings.get_double('volume');
        if (Math.abs(value - this._slider.value) > 0.001) {
            this._slider.value = value; // triggers _onSliderChanged
            // Slider.step() (its own wheel and arrow keys) continues from a
            // cached position that a programmatic change does not reset.
            if ('_unsnappedValue' in this._slider)
                this._slider._unsnappedValue = null;
        }
    }

    _onScroll(event) {
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_PROPAGATE;

        let steps = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            steps = 1;
            break;
        case Clutter.ScrollDirection.DOWN:
            steps = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [, dy] = event.get_scroll_delta();
            steps = -dy;
            if (event.get_scroll_flags() & Clutter.ScrollFlags.INVERTED)
                steps *= -1;
            break;
        }
        }
        if (steps === 0)
            return Clutter.EVENT_STOP;

        // Not Slider.step(): it works from a cached value that goes stale when
        // the volume setting is changed from outside.
        this._slider.value = Math.min(1, Math.max(0,
            this._slider.value + steps * SCROLL_VOLUME_STEP));
        if (!this.menu.isOpen) {
            Main.osdWindowManager.showAll(this._volumeIcon.gicon, 'Lofi Bar',
                this._slider.value, 1);
        }
        return Clutter.EVENT_STOP;
    }

    _syncVolumeIcon() {
        const v = this._slider.value;
        let name = 'audio-volume-muted-symbolic';
        if (v >= 0.66)
            name = 'audio-volume-high-symbolic';
        else if (v >= 0.33)
            name = 'audio-volume-medium-symbolic';
        else if (v > 0)
            name = 'audio-volume-low-symbolic';
        this._volumeIcon.gicon = Gio.ThemedIcon.new(name);
    }

    // ---- Radio Browser --------------------------------------------------

    async _loadDiscover(force) {
        if (this._discoverLoading || (this._discoverLoaded && !force))
            return;
        this._discoverLoading = true;
        this._refreshItem.status.text = 'Loading…';

        try {
            const {stations, fetchedAt, stale} = await this._radioBrowser.load({force});
            if (!this._refreshItem)
                return; // destroyed meanwhile
            this._fillDiscover(stations);
            this._discoverLoaded = true;
            const age = timeAgo(GLib.get_real_time() / 1e6 - fetchedAt);
            this._refreshItem.status.text = stale
                ? `Offline · list from ${age}`
                : `${stations.length} stations · ${age}`;
        } catch (e) {
            if (isCancelled(e) || !this._refreshItem)
                return;
            console.warn(`Lofi Bar: Radio Browser failed: ${e.message}`);
            this._refreshItem.status.text = 'Couldn’t reach Radio Browser';
        } finally {
            this._discoverLoading = false;
        }
    }

    _fillDiscover(stations) {
        // removeAll() destroys the old Radio Browser items.
        this._stationItems = this._stationItems.filter(item => !item.station.rbUuid);
        this._discoverSection.removeAll();
        for (const station of stations)
            this._addStationItem(this._discoverSection, station);
        // The submenu picks its scrollbar policy when it opens, before this
        // asynchronous list arrives; let it scroll now that it may be tall.
        this._discoverItem.menu.actor.vscrollbar_policy = St.PolicyType.AUTOMATIC;
        this._sync();
    }

    // ---- State persistence ----------------------------------------------

    _loadLastStation() {
        try {
            const saved = JSON.parse(this._settings.get_string('last-station') || 'null');
            if (!saved)
                return null;
            const curated = CURATED_STATIONS.find(s => s.id === saved.id);
            if (curated)
                return curated;
            const valid = typeof saved.name === 'string' && Array.isArray(saved.streams) &&
                saved.streams.length > 0 &&
                saved.streams.every(s => typeof s?.url === 'string' && /^https?:\/\//i.test(s.url));
            return valid ? saved : null;
        } catch {
            return null;
        }
    }

    _saveLastStation(station) {
        const saved = CURATED_STATIONS.includes(station)
            ? {id: station.id}
            : {
                id: station.id,
                rbUuid: station.rbUuid,
                name: station.name,
                genre: station.genre,
                streams: station.streams,
            };
        this._settings.set_string('last-station', JSON.stringify(saved));
    }

    // ---- Rendering ------------------------------------------------------

    _qualityText() {
        const live = this._live;
        const planned = this._station?.streams[live.stream ?? 0];
        const codec = live.codec ?? planned?.codec;
        const parts = [];
        if (codec === 'FLAC') {
            const depth = bitDepth(live.format);
            const rate = formatRate(live.rate);
            parts.push('FLAC lossless');
            if (depth && rate)
                parts.push(`${depth}-bit / ${rate}`);
            else if (rate)
                parts.push(rate);
        } else {
            const bitrate = live.bitrate ?? planned?.bitrate;
            if (codec)
                parts.push(codec);
            if (bitrate)
                parts.push(`${bitrate} kbps`);
            if (live.rate)
                parts.push(formatRate(live.rate));
        }
        if ((live.stream ?? 0) > 0)
            parts.push('fallback stream');
        return parts.join(' · ');
    }

    _statusText() {
        const detail = this._statusDetail;
        switch (this._status) {
        case 'connecting':
            return detail ? `Connecting… ${detail}` : 'Connecting…';
        case 'buffering':
            return `Buffering ${detail}`;
        case 'reconnecting':
            return `Connection lost · ${detail}`;
        case 'playing':
            return this._qualityText();
        case 'error':
            return detail;
        default:
            return this._station ? `Stopped · ${qualityBadge(this._station.streams[0])}` : 'Pick a station';
        }
    }

    _sync() {
        const active = this._isActive();
        const station = this._station;

        this._stationLabel.text = station?.name ?? 'Lofi Bar';
        const subtitle = active && this._title ? this._title : station?.genre ?? '';
        this._titleLabel.text = subtitle;
        this._titleLabel.visible = subtitle !== '';
        this._statusLabel.text = this._statusText();
        if (this._status === 'error') {
            this._statusLabel.add_style_class_name('lofi-bar-error');
            this._statusLabel.opacity = 255;
        } else {
            this._statusLabel.remove_style_class_name('lofi-bar-error');
            this._statusLabel.opacity = DIM;
        }

        this._playIcon.icon_name = active
            ? 'media-playback-stop-symbolic'
            : 'media-playback-start-symbolic';
        this._playButton.accessible_name = active ? 'Stop' : 'Play';

        // Radio-button style: the dot marks what the play button plays.
        for (const item of this._stationItems) {
            item.setOrnament(item.station.id === station?.id
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NO_DOT);
        }

        this._icon.opacity = this._status === 'playing' ? 255 : active ? 200 : 150;
        const showLabel = active && this._settings.get_boolean('show-title');
        this._panelLabel.text = this._title ?? station?.name ?? '';
        this._panelLabel.visible = showLabel && this._panelLabel.text !== '';
    }

    // ---- Timers & teardown ----------------------------------------------

    _setTimer(name, ms, callback) {
        this._clearTimer(name);
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
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

    destroy() {
        this._destroyed = true;
        // Save a pending volume change before the timer goes away.
        if (this._timers.has('volume-save'))
            this._settings.set_double('volume', this._volume);
        for (const name of [...this._timers.keys()])
            this._clearTimer(name);

        this._settings.disconnectObject(this);
        this._playButton.disconnectObject(this);
        this._slider.disconnectObject(this);
        this._player.destroy();
        this._http.destroy();

        // Children would go with the indicator anyway; destroy them
        // explicitly, leaves first, so every object has a clear owner.
        this._playIcon.destroy();
        this._playButton.destroy();
        this._volumeIcon.destroy();
        this._discoverSection.destroy();
        this._discoverItem.destroy();
        this._curatedSection.destroy();

        this._playIcon = null;
        this._playButton = null;
        this._volumeIcon = null;
        this._slider = null;
        this._discoverSection = null;
        this._discoverItem = null;
        this._curatedSection = null;
        this._refreshItem = null;
        this._stationItems = [];
        this._player = null;
        this._http = null;
        this._radioBrowser = null;
        this._settings = null;
        super.destroy();
    }
});

export default class LofiBarExtension extends Extension {
    enable() {
        this._indicator = new LofiIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        // The extension also runs on the lock screen so music keeps playing
        // while locked; the indicator itself is hidden there.
        Main.sessionMode.connectObject('updated', () => this._syncSessionMode(), this);
        this._syncSessionMode();
    }

    disable() {
        // This extension declares the "unlock-dialog" session mode so that
        // music keeps playing while the screen is locked: disable() is not
        // called on lock, and the player process keeps running. While locked
        // the indicator is hidden (see _syncSessionMode), so nothing can be
        // controlled and no track info is shown on the lock screen. disable()
        // runs when the user turns the extension off or logs out, and then
        // stops playback and removes everything.
        Main.sessionMode.disconnectObject(this);
        this._indicator?.destroy();
        this._indicator = null;
    }

    _syncSessionMode() {
        const locked = Main.sessionMode.isLocked;
        if (locked)
            this._indicator.menu.close();
        this._indicator.container.visible = !locked;
    }
}
