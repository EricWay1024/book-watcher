# Book Watcher

Turn an EPUB into something you *watch*: each sentence is read aloud by a neural voice
and shown big on screen like a subtitle. Chinese (Mandarin) and English, even mixed in
one book: the voice is chosen per sentence.

```sh
uv run book-watcher                 # open the library at http://127.0.0.1:8765
uv run book-watcher path/to/book.epub   # add a book and open it straight away
```

Then drop more EPUBs onto the library page.

- **Play / pause** with the big button or <kbd>Space</kbd>. <kbd>←</kbd>/<kbd>→</kbd> sentence, <kbd>↑</kbd>/<kbd>↓</kbd> paragraph.
- **Full screen** (<kbd>F</kbd>, or the ⛶ button): only the sentence being read. Tap the left third of the
  screen for the previous sentence, the middle to pause/resume, the right third for the next one
  (the zones are invisible). <kbd>Space</kbd> also pauses. A faint
  bookmark in the corner marks the sentence. <kbd>Esc</kbd> or <kbd>F</kbd> leaves.
- **Settings follow you across devices**: font, size, theme, speed, volume, pauses, engine and voices are
  kept on the server (newest change wins). Sidebar layout stays per device.
- **Highlights** page (from the library): every marked sentence across your books, grouped by book and
  chapter or newest first, with search, "open in book", and export to Markdown or CSV (opens in Excel).
- **Reading stats** page, in the spirit of WeChat Read (微信读书): listening time per week, month, year or
  all time with a daily chart, daily average and change vs the previous period, days read, streaks,
  books read and finished, highlights made, and time per book. Time counts while a book is playing.
- Marks sync as individual changes, so reading on two devices at once never loses a mark.
- **Speed, volume, font, size, theme, voices, pauses**: the sliders under the play button and the settings panel (<kbd>,</kbd>).
- **Outline** tab (<kbd>O</kbd>): the book's table of contents as a foldable tree, with the section you're in
  highlighted and a filter box. Click any entry to jump there. If the EPUB's own TOC is sparse (only
  "Part 1…5", say), chapter headings found in the text are slotted in underneath.
- **Context sidebar** (<kbd>S</kbd> to fold): the paragraphs around the current sentence, following along as it plays.
  Click sentences to select them (Shift+click for a range, or drag across the text), then **Mark**.
  Double-click a sentence to play from there.
- **Marks** tab: every marked sentence by chapter. Click one to jump to it, or export them all as Markdown.
  <kbd>M</kbd> marks the sentence being read.

Speech comes from Microsoft's online neural voices via [edge-tts](https://github.com/rany2/edge-tts)
(free, needs internet). Clips are cached in `data/tts/`, so anything already heard replays offline.
Settings → Engine → *Browser built-in* uses your browser's own voices instead, with no network needed.

Reading position and marks are saved per book in `data/books/<id>/state.json`.

## Running it online

Set `BW_PASSWORD` to require a password (a login page; sessions last 180 days, and changing the
password signs everyone out). Other settings: `BW_HOST`, `BW_PORT`, `BW_DATA`, and `BW_TTS_CACHE_MB`
(prune the speech cache, least recently used first, to this size).

### Deploying to a server

`deploy/` has everything for a Debian-style box with nginx and certbot: a systemd unit (runs as its
own system user, memory-capped), an nginx site, and `install.sh`, which sets them up and generates a
password on first run.

```sh
HOST=myserver DOMAIN=books.example.com ./deploy.sh   # or put HOST=/DOMAIN= in a git-ignored deploy.local
ssh myserver sudo certbot --nginx -d books.example.com   # once DNS points at the server
```

Re-running `./deploy.sh` updates the code and restarts; the library and password are left alone.

- Service: `systemctl status book-watcher`; logs: `journalctl -u book-watcher`
- Password: `/etc/book-watcher.env` (`BW_PASSWORD=…`); edit it, then `sudo systemctl restart book-watcher`
- Library and speech cache: `/var/lib/book-watcher`
