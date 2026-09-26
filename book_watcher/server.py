"""Local web server: library of EPUBs, per-book reading state, and edge-tts speech."""

import argparse
import asyncio
import hashlib
import json
import os
import re
import shutil
import time
import webbrowser
from pathlib import Path
from urllib.parse import unquote

import edge_tts
from aiohttp import web

from .auth import Auth
from .epub import PARSER_VERSION, parse_epub

STATIC = Path(__file__).parent / "static"
TTS_SLOTS = asyncio.Semaphore(6)  # concurrent requests to the speech service
_tts_locks: dict[str, asyncio.Lock] = {}
_voices: list[dict] | None = None


class Library:
    def __init__(self, root: Path):
        self.root = root
        self.books = root / "books"
        self.tts = root / "tts"
        self.books.mkdir(parents=True, exist_ok=True)
        self.tts.mkdir(parents=True, exist_ok=True)

    def dir(self, book_id: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{12}", book_id):
            raise web.HTTPNotFound()
        d = self.books / book_id
        if not d.is_dir():
            raise web.HTTPNotFound()
        return d

    def add(self, data: bytes, filename: str) -> str:
        book_id = hashlib.sha1(data).hexdigest()[:12]
        d = self.books / book_id
        d.mkdir(exist_ok=True)
        (d / "book.epub").write_bytes(data)
        try:
            self.book(book_id)
        except Exception:
            shutil.rmtree(d)
            raise
        meta = self._read(d / "meta.json", {})
        meta.setdefault("filename", filename)
        meta.setdefault("added", time.time())
        (d / "meta.json").write_text(json.dumps(meta))
        return book_id

    def book(self, book_id: str) -> dict:
        d = self.books / book_id
        cached = self._read(d / "book.json", None)
        if cached and cached.get("v") == PARSER_VERSION:
            return cached
        book = parse_epub(str(d / "book.epub"))
        if not book["paras"]:
            raise ValueError("no readable text found in this EPUB")
        book["id"] = book_id
        (d / "book.json").write_text(json.dumps(book, ensure_ascii=False))
        return book

    def state(self, book_id: str) -> dict:
        return self._read(self.dir(book_id) / "state.json", {"pos": 0, "marks": {}})

    def save_state(self, book_id: str, state: dict) -> None:
        path = self.dir(book_id) / "state.json"
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False))
        tmp.replace(path)

    def list(self) -> list[dict]:
        out = []
        for d in self.books.iterdir():
            if not (d / "book.epub").exists():
                continue
            try:
                b = self.book(d.name)
            except Exception:
                continue
            st, meta = self.state(d.name), self._read(d / "meta.json", {})
            out.append({
                "id": d.name, "title": b["title"], "author": b["author"], "sentences": b["sentences"],
                "pos": st.get("pos", 0), "marks": len(st.get("marks", {})),
                "opened": st.get("opened", meta.get("added", 0)),
            })
        return sorted(out, key=lambda b: -b["opened"])

    @staticmethod
    def _read(path: Path, default):
        try:
            return json.loads(path.read_text())
        except (OSError, ValueError):
            return default


async def synthesize(lib: Library, voice: str, text: str) -> Path | None:
    key = hashlib.sha1(f"{voice}\n{text}".encode()).hexdigest()
    path = lib.tts / key[:2] / f"{key}.mp3"
    if path.exists():
        path.touch()  # mtime = last use, for cache pruning
        return path
    lock = _tts_locks.setdefault(key, asyncio.Lock())
    try:
        async with lock:
            if path.exists():
                return path
            path.parent.mkdir(exist_ok=True)
            tmp = path.with_suffix(".part")
            async with TTS_SLOTS:
                for attempt in range(3):
                    try:
                        await edge_tts.Communicate(text, voice).save(str(tmp))
                        break
                    except edge_tts.exceptions.NoAudioReceived:
                        return None  # nothing speakable (e.g. "***")
                    except Exception:
                        if attempt == 2:
                            raise
                        await asyncio.sleep(0.5 * (attempt + 1))
            tmp.replace(path)
            return path
    finally:
        if not lock.locked():
            _tts_locks.pop(key, None)


def prune_cache(root: Path, limit_mb: int) -> None:
    """Delete least-recently-used clips until the speech cache is under the limit."""
    files = [(f.stat().st_mtime, f.stat().st_size, f) for f in root.glob("*/*.mp3")]
    total, limit = sum(size for _, size, _ in files), limit_mb * 1024 * 1024
    for _, size, f in sorted(files):
        if total <= limit:
            break
        f.unlink(missing_ok=True)
        total -= size


async def prune_forever(root: Path, limit_mb: int) -> None:
    while True:
        await asyncio.to_thread(prune_cache, root, limit_mb)
        await asyncio.sleep(3600)


def make_app(lib: Library, password: str = "", cache_mb: int = 0) -> web.Application:
    routes = web.RouteTableDef()
    auth = Auth(password, lib.root) if password else None

    @routes.get("/api/config")
    async def config(_):
        return web.json_response({"auth": auth is not None})

    @routes.get("/")
    async def index(_):
        return web.FileResponse(STATIC / "index.html", headers={"Cache-Control": "no-cache"})

    @routes.get("/api/books")
    async def books(_):
        return web.json_response(await asyncio.to_thread(lib.list))

    @routes.post("/api/books")
    async def upload(request):
        data = await request.read()
        name = unquote(request.headers.get("X-Filename", "book.epub"))
        try:
            book_id = await asyncio.to_thread(lib.add, data, name)
        except Exception as e:
            return web.json_response({"error": f"Could not read {name}: {e}"}, status=400)
        return web.json_response({"id": book_id})

    @routes.get("/api/books/{id}")
    async def book(request):
        lib.dir(request.match_info["id"])
        return web.json_response(await asyncio.to_thread(lib.book, request.match_info["id"]))

    @routes.delete("/api/books/{id}")
    async def delete(request):
        shutil.rmtree(lib.dir(request.match_info["id"]))
        return web.json_response({"ok": True})

    @routes.get("/api/books/{id}/state")
    async def get_state(request):
        return web.json_response(lib.state(request.match_info["id"]))

    @routes.put("/api/books/{id}/state")
    @routes.post("/api/books/{id}/state")  # navigator.sendBeacon on page close
    async def put_state(request):
        state = json.loads(await request.text())
        state["opened"] = time.time()
        lib.save_state(request.match_info["id"], state)
        return web.json_response({"ok": True})

    @routes.get("/api/voices")
    async def voices(_):
        global _voices
        if _voices is None:
            all_voices = await edge_tts.list_voices()
            _voices = [
                {"id": v["ShortName"], "locale": v["Locale"], "gender": v["Gender"]}
                for v in all_voices
                if v["Locale"].startswith(("zh-", "en-"))
            ]
        return web.json_response(_voices)

    @routes.post("/api/tts")
    async def tts(request):
        body = await request.json()
        voice, text = body.get("voice", ""), (body.get("text") or "").strip()
        if not re.fullmatch(r"[a-z]{2,3}-[A-Za-z]{2,4}(-[a-z]+)?-\w+Neural", voice) or not text:
            return web.json_response({"error": "bad voice or text"}, status=400)
        try:
            path = await synthesize(lib, voice, text[:1000])
        except Exception as e:
            return web.json_response({"error": f"speech service failed: {e}"}, status=502)
        if path is None:
            return web.Response(status=204)
        return web.FileResponse(path, headers={"Content-Type": "audio/mpeg", "Cache-Control": "max-age=31536000"})

    routes.static("/static", STATIC)
    app = web.Application(client_max_size=100 * 1024 * 1024, middlewares=[auth.middleware] if auth else [])
    app.add_routes(routes)
    if auth:
        app.add_routes(auth.routes())
    if cache_mb:
        async def start_pruner(app):
            app["pruner"] = asyncio.create_task(prune_forever(lib.tts, cache_mb))
        app.on_startup.append(start_pruner)
    return app


def main() -> None:
    ap = argparse.ArgumentParser(description="Watch an EPUB: sentence-by-sentence subtitles with neural TTS.")
    ap.add_argument("epub", nargs="*", help="EPUB files to add to the library")
    env = os.environ.get
    ap.add_argument("--port", type=int, default=int(env("BW_PORT", 8765)))
    ap.add_argument("--host", default=env("BW_HOST", "127.0.0.1"))
    ap.add_argument("--data", type=Path, default=Path(env("BW_DATA") or Path(__file__).resolve().parent.parent / "data"),
                    help="library + audio cache directory")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    # Secrets come from the environment only (BW_PASSWORD), never the command line.
    password = env("BW_PASSWORD", "")
    cache_mb = int(env("BW_TTS_CACHE_MB", 0))

    lib = Library(args.data)
    opened = None
    for f in args.epub:
        p = Path(f)
        opened = lib.add(p.read_bytes(), p.name)
        print(f"added {p.name}")

    url = f"http://{args.host}:{args.port}/" + (f"#/book/{opened}" if opened else "")
    print(f"Book Watcher on {url}" + (" (password required)" if password else ""), flush=True)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    web.run_app(make_app(lib, password, cache_mb), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
