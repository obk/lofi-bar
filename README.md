# Lofi Bar

Lofi radio in the GNOME Shell top bar, always on the best stream a station offers.

- **Curated stations, measured.** Twelve lofi and chill stations whose streams were checked by decoding them, not by trusting server headers. ISEKOI Chill Zone plays lossless FLAC (16-bit / 48 kHz). The rest are 320, 256 or 192 kbps.
- **Best format first, automatic fallback.** Each station lists its streams best first. If the best one can't connect, the player moves to the next one. Dropped connections retry with backoff, starting again from the best stream.
- **More stations from Radio Browser.** "More lofi stations" pulls lofi, lo-fi and chillhop stations from the community [Radio Browser](https://www.radio-browser.info) directory. Duplicate listings of one station are merged, and its streams are ordered by quality. The list is cached for 24 hours.
- **Live quality readout.** The menu shows the real codec, bitrate, sample rate and, for FLAC, bit depth of what is playing.
- **Small touches.** Scroll on the icon to change the volume. You can show the track title in the top bar. Music keeps playing while the screen is locked, and the indicator hides on the lock screen.

## Requirements

- GNOME Shell 50
- GStreamer 1.x with the good plugins (souphttpsrc, mpg123 or libav for MP3, flac, an AAC decoder)

These come with a standard Fedora Workstation install.

## Install

```sh
make install
```

On Wayland, GNOME Shell only notices a newly installed extension after you log out and back in. Then enable it:

```sh
gnome-extensions enable lofi-bar@obk.github.io
```

`make pack` builds `lofi-bar@obk.github.io.shell-extension.zip`, which is what extensions.gnome.org accepts.

## How it works

| File | Role |
| --- | --- |
| `extension.js` | Top bar button, menu, playback state, settings |
| `player.js` | The audio player. It runs as its own `gjs` process, so a stuck stream or a decoder crash can't freeze or kill GNOME Shell. |
| `playerProcess.js` | Starts and stops the player and talks to it over stdin and stdout with JSON lines |
| `stations.js` | The curated station list and quality badges |
| `radioBrowser.js` | Radio Browser fetching, grouping and best-stream ranking |
| `net.js` | Small libsoup helper with a response size cap |

Settings are stored under `org.gnome.shell.extensions.lofi-bar`: volume, last station, and whether to show the track in the top bar.

## Privacy

The extension only makes network requests when you play a station or open the Radio Browser list. Requests go to the station you play, to Radio Browser, and to ISEKOI's public now-playing API while ISEKOI is playing. Radio Browser asks clients to report plays so its popularity ranking stays useful. Lofi Bar does that for stations you pick from that list. No account and no identifier is sent.

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
