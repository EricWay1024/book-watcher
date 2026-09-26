"""Web server: per-user libraries of EPUBs, reading state, stats, and edge-tts speech.

Layout under the data directory:
  books/<book>/        book.epub + parsed book.json, shared by everyone who has the book
  users/<uid>/         library.json (which books), state/<book>.json (position, marks), stats.json, settings.json
  users.json, secret   accounts and the cookie-signing key
  tts/                 speech cache, shared
"""

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
from .users import UserError, Users, new_password

STATIC = Path(__file__).parent / "static"
TTS_SLOTS = asyncio.Semaphore(6)  # concurrent requests to the speech service
_tts_locks: dict[str, asyncio.Lock] = {}
_voices: list[dict] | None = None


class Store:
    """Everything shared: book files, the speech cache, and the users' directories."""

    def __init__(self, root: Path):
        self.root = root
        self.books = root / "books"
        self.tts = root / "tts"
        self.users_dir = root / "users"
        for d in (self.books, self.tts, self.users_dir):
            d.mkdir(parents=True, exist_ok=True)

    def add_file(self, data: bytes) -> str:
        book_id = hashlib.sha1(data).hexdigest()[:12]
        d = self.books / book_id
        if not (d / "book.epub").exists():
            d.mkdir(exist_ok=True)
            (d / "book.epub").write_bytes(data)
            try:
                self.parsed(book_id)
            except Exception:
                shutil.rmtree(d)
                raise
        return book_id

    def parsed(self, book_id: str) -> dict:
        d = self.books / book_id
        cached = _read(d / "book.json", None)
        if cached and cached.get("v") == PARSER_VERSION:
            return cached
        book = parse_epub(str(d / "book.epub"))
        if not book["paras"]:
            raise ValueError("no readable text found in this EPUB")
        book["id"] = book_id
        (d / "book.json").write_text(json.dumps(book, ensure_ascii=False))
        return book

    def lib(self, uid: str) -> "Library":
        return Library(self, uid)

    def collect_garbage(self) -> None:
        """Delete book files that no user has in their library any more."""
        wanted = set()
        for u in self.users_dir.iterdir():
            wanted |= set(_read(u / "library.json", {}))
        for d in self.books.iterdir():
            if d.is_dir() and d.name not in wanted:
                shutil.rmtree(d)

    def migrate_legacy(self, uid: str) -> None:
        """Before accounts, books/<id>/ held one person's state and stats sat at the top level.
        Move all of that into this user's directory. Safe to re-run."""
        u = self.users_dir / uid
        (u / "state").mkdir(parents=True, exist_ok=True)
        library = _read(u / "library.json", {})
        for d in self.books.iterdir():
            if not (d / "book.epub").exists():
                continue
            meta = _read(d / "meta.json", {})
            library.setdefault(d.name, {"added": meta.get("added", time.time()), "filename": meta.get("filename", "")})
            if (d / "state.json").exists() and not (u / "state" / f"{d.name}.json").exists():
                (d / "state.json").replace(u / "state" / f"{d.name}.json")
        _write(u / "library.json", library)
        for name in ("stats.json", "settings.json"):
            if (self.root / name).exists() and not (u / name).exists():
                (self.root / name).replace(u / name)


def _read(path: Path, default):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return default


def _write(path: Path, data) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(path)


class Library:
    """One user's view: their books, positions, marks, reading stats and settings."""

    def __init__(self, store: Store, uid: str):
        self.store = store
        self.uid = uid
        self.root = store.users_dir / uid
        (self.root / "state").mkdir(parents=True, exist_ok=True)

    def entries(self) -> dict:
        return _read(self.root / "library.json", {})

    def dir(self, book_id: str) -> Path:
        """The book's files, if it is in this user's library (anything else is a 404)."""
        if not re.fullmatch(r"[0-9a-f]{12}", book_id) or book_id not in self.entries():
            raise web.HTTPNotFound()
        return self.store.books / book_id

    def add(self, data: bytes, filename: str) -> str:
        book_id = self.store.add_file(data)
        library = self.entries()
        library.setdefault(book_id, {"added": time.time(), "filename": filename})
        _write(self.root / "library.json", library)
        return book_id

    def remove(self, book_id: str) -> None:
        self.dir(book_id)
        library = self.entries()
        library.pop(book_id, None)
        _write(self.root / "library.json", library)
        (self.root / "state" / f"{book_id}.json").unlink(missing_ok=True)
        self.store.collect_garbage()

    def book(self, book_id: str) -> dict:
        self.dir(book_id)
        return self.store.parsed(book_id)

    def state(self, book_id: str) -> dict:
        self.dir(book_id)
        state = _read(self.root / "state" / f"{book_id}.json", {})
        return {"pos": 0, "marks": {}, **state}

    def save_state(self, book_id: str, state: dict) -> None:
        self.dir(book_id)
        _write(self.root / "state" / f"{book_id}.json", state)

    # State changes are read-modify-write with no await in between, so on the single event
    # loop they can't interleave: two devices editing marks never lose each other's changes.
    def set_pos(self, book_id: str, pos: int) -> None:
        state = self.state(book_id)
        state.update(pos=max(0, int(pos)), opened=time.time())
        self.save_state(book_id, state)

    def edit_marks(self, book_id: str, add: dict, remove: list) -> dict:
        state = self.state(book_id)
        marks = state["marks"]
        for k, v in add.items():
            if str(k).isdigit() and isinstance(v, dict):
                marks[str(k)] = {"t": str(v.get("t", ""))[:2000], "at": v.get("at") or int(time.time() * 1000)}
        for k in remove:
            marks.pop(str(k), None)
        self.save_state(book_id, state)
        return marks

    def mark_finished(self, book_id: str) -> None:
        state = self.state(book_id)
        state.setdefault("finished", int(time.time() * 1000))
        self.save_state(book_id, state)

    # ---- reading time: stats.json = {"days": {"YYYY-MM-DD": {"s": secs, "n": sentences, "b": {book: secs}}}}
    def stats(self) -> dict:
        return _read(self.root / "stats.json", {"days": {}})

    def add_reading(self, book_id: str, day: str, seconds: float, sentences: int) -> None:
        stats = self.stats()
        d = stats["days"].setdefault(day, {"s": 0, "n": 0, "b": {}})
        d["s"] = round(d["s"] + seconds, 1)
        d["n"] += sentences
        d["b"][book_id] = round(d["b"].get(book_id, 0) + seconds, 1)
        _write(self.root / "stats.json", stats)

    def settings(self) -> dict:
        return _read(self.root / "settings.json", {})

    def save_settings(self, body: dict) -> None:
        if body.get("updated", 0) >= self.settings().get("updated", 0):  # newest change wins
            _write(self.root / "settings.json", body)

    def chapter_titles(self, book: dict) -> list[str]:
        """Chapter title for every sentence index."""
        starts = {c["p"]: c["title"] for c in book["chapters"]}
        out, title = [], ""
        for i, para in enumerate(book["paras"]):
            title = starts.get(i, title)
            out += [title] * len(para["s"])
        return out

    def highlights(self) -> list[dict]:
        out = []
        for b in self.list():
            marks = self.state(b["id"])["marks"]
            if not marks:
                continue
            book = self.book(b["id"])
            chapters = self.chapter_titles(book)
            para_of = [pi for pi, para in enumerate(book["paras"]) for _ in para["s"]]
            items = sorted(
                ({"i": int(k), "t": v.get("t", ""), "at": v.get("at", 0),
                  "ch": chapters[int(k)] if int(k) < len(chapters) else "",
                  "p": para_of[int(k)] if int(k) < len(para_of) else -1} for k, v in marks.items()),
                key=lambda m: m["i"],
            )
            out.append({"id": b["id"], "title": b["title"], "author": b["author"], "marks": items})
        return out

    def list(self) -> list[dict]:
        out = []
        for book_id, entry in self.entries().items():
            try:
                b = self.book(book_id)
            except Exception:
                continue
            st = self.state(book_id)
            out.append({
                "id": book_id, "title": b["title"], "author": b["author"], "sentences": b["sentences"],
                "pos": st.get("pos", 0), "marks": len(st.get("marks", {})),
                "opened": st.get("opened", entry.get("added", 0)), "finished": st.get("finished"),
            })
        return sorted(out, key=lambda b: -b["opened"])


async def synthesize(lib: Store, voice: str, text: str) -> Path | None:
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


def make_app(store: Store, users: Users, cache_mb: int = 0) -> web.Application:
    routes = web.RouteTableDef()
    auth = Auth(users, store.root)
    lib_of = lambda request: store.lib(request["uid"])  # noqa: E731

    def admin_only(request) -> None:
        if not users.get(request["uid"]).get("admin"):
            raise web.HTTPForbidden()

    def user_error(e: Exception) -> web.Response:
        return web.json_response({"error": str(e)}, status=400)

    # ---- the signed-in user
    @routes.get("/api/me")
    async def me(request):
        u = users.get(request["uid"])
        return web.json_response({"id": request["uid"], "name": u["name"], "admin": bool(u.get("admin")),
                                  "accounts": users.accounts_enabled})

    @routes.post("/api/me/password")
    async def change_password(request):
        body = await request.json()
        uid = request["uid"]
        from .users import check_password
        if not await asyncio.to_thread(check_password, str(body.get("current", "")), users.get(uid).get("hash")):
            return web.json_response({"error": "Your current password is not right."}, status=400)
        try:
            await asyncio.to_thread(users.set_password, uid, str(body.get("password", "")))
        except UserError as e:
            return user_error(e)
        resp = web.json_response({"ok": True})
        auth.set_cookie(request, resp, uid)  # other devices are signed out; this one stays in
        return resp

    # ---- admin: accounts
    def user_row(uid: str, u: dict) -> dict:
        return {"id": uid, "name": u["name"], "admin": bool(u.get("admin")), "created": u.get("created"),
                "seen": u.get("seen"), "books": len(store.lib(uid).entries())}

    @routes.get("/api/admin/users")
    async def list_users(request):
        admin_only(request)
        rows = [user_row(uid, u) for uid, u in users.all.items()]
        return web.json_response(sorted(rows, key=lambda r: (not r["admin"], r["name"])))

    @routes.post("/api/admin/users")
    async def create_user(request):
        admin_only(request)
        body = await request.json()
        password = str(body.get("password") or "") or new_password()
        try:
            uid = await asyncio.to_thread(users.create, str(body.get("name", "")), password)
        except UserError as e:
            return user_error(e)
        store.lib(uid)
        return web.json_response({**user_row(uid, users.get(uid)), "password": password})

    @routes.patch("/api/admin/users/{uid}")
    async def update_user(request):
        admin_only(request)
        uid = request.match_info["uid"]
        if not users.get(uid):
            raise web.HTTPNotFound()
        body = await request.json()
        out = {}
        try:
            if "name" in body:
                users.rename(uid, str(body["name"]))
            if body.get("reset_password"):
                out["password"] = str(body.get("password") or "") or new_password()
                await asyncio.to_thread(users.set_password, uid, out["password"])
        except UserError as e:
            return user_error(e)
        resp = web.json_response({**user_row(uid, users.get(uid)), **out})
        if uid == request["uid"] and "password" in out:
            auth.set_cookie(request, resp, uid)
        return resp

    @routes.delete("/api/admin/users/{uid}")
    async def delete_user(request):
        admin_only(request)
        uid = request.match_info["uid"]
        if uid == request["uid"]:
            return web.json_response({"error": "You can't delete your own account."}, status=400)
        if not users.get(uid):
            raise web.HTTPNotFound()
        users.delete(uid)
        shutil.rmtree(store.users_dir / uid, ignore_errors=True)
        await asyncio.to_thread(store.collect_garbage)
        return web.json_response({"ok": True})

    # Asset URLs carry a content hash, so a deploy can never leave a browser on stale JS.
    version = hashlib.sha1(b"".join(f.read_bytes() for f in sorted(STATIC.iterdir()) if f.is_file())).hexdigest()[:10]
    index_html = (STATIC / "index.html").read_text().replace("__V__", version)

    @routes.get("/manifest.webmanifest")
    async def manifest(_):
        return web.FileResponse(STATIC / "manifest.webmanifest", headers={"Content-Type": "application/manifest+json"})

    @routes.get("/sw.js")  # served from the root so it can control the whole site
    async def service_worker(_):
        return web.FileResponse(STATIC / "sw.js", headers={"Content-Type": "text/javascript", "Cache-Control": "no-cache"})

    @routes.get("/")
    async def index(_):
        return web.Response(text=index_html, content_type="text/html", headers={"Cache-Control": "no-cache"})

    @routes.get("/api/books")
    async def books(request):
        return web.json_response(await asyncio.to_thread(lib_of(request).list))

    @routes.post("/api/books")
    async def upload(request):
        data = await request.read()
        name = unquote(request.headers.get("X-Filename", "book.epub"))
        try:
            book_id = await asyncio.to_thread(lib_of(request).add, data, name)
        except Exception as e:
            return web.json_response({"error": f"Could not read {name}: {e}"}, status=400)
        return web.json_response({"id": book_id})

    @routes.get("/api/books/{id}")
    async def book(request):
        return web.json_response(await asyncio.to_thread(lib_of(request).book, request.match_info["id"]))

    @routes.delete("/api/books/{id}")
    async def delete(request):
        await asyncio.to_thread(lib_of(request).remove, request.match_info["id"])
        return web.json_response({"ok": True})

    @routes.get("/api/books/{id}/state")
    async def get_state(request):
        return web.json_response(lib_of(request).state(request.match_info["id"]))

    @routes.put("/api/books/{id}/state")
    @routes.post("/api/books/{id}/state")  # navigator.sendBeacon on page close
    async def put_state(request):
        # Position only. Marks go through /marks as changes, so a stale tab can't overwrite them
        # (older pages still send "marks" here; it is ignored).
        body = json.loads(await request.text())
        lib_of(request).set_pos(request.match_info["id"], body.get("pos", 0))
        return web.json_response({"ok": True})

    @routes.post("/api/books/{id}/marks")
    async def marks(request):
        body = await request.json()
        marks = lib_of(request).edit_marks(request.match_info["id"], body.get("add") or {}, body.get("remove") or [])
        return web.json_response({"marks": marks})

    @routes.post("/api/read")
    async def read(request):
        body = json.loads(await request.text())  # also sent by sendBeacon
        book_id, day = str(body.get("book", "")), str(body.get("day", ""))
        lib = lib_of(request)
        lib.dir(book_id)
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
            return web.json_response({"error": "bad day"}, status=400)
        seconds = min(max(float(body.get("seconds", 0)), 0), 900)  # a flush covers at most ~30 s
        sentences = min(max(int(body.get("sentences", 0)), 0), 2000)
        if seconds or sentences:
            lib.add_reading(book_id, day, seconds, sentences)
        if body.get("finished"):
            lib.mark_finished(book_id)
        return web.json_response({"ok": True})

    @routes.get("/api/settings")
    async def get_settings(request):
        return web.json_response(lib_of(request).settings())

    @routes.put("/api/settings")
    @routes.post("/api/settings")  # sendBeacon when the page is hidden
    async def put_settings(request):
        text = await request.text()
        body = json.loads(text)
        if not isinstance(body, dict) or len(text) > 20000:
            return web.json_response({"error": "bad settings"}, status=400)
        lib_of(request).save_settings(body)
        return web.json_response({"ok": True})

    @routes.get("/api/stats")
    async def stats(request):
        lib = lib_of(request)
        books = await asyncio.to_thread(lib.list)
        for b in books:
            b["markTimes"] = [m.get("at", 0) for m in lib.state(b["id"])["marks"].values()]
        return web.json_response({"days": lib.stats()["days"], "books": books})

    @routes.get("/api/highlights")
    async def highlights(request):
        return web.json_response(await asyncio.to_thread(lib_of(request).highlights))

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
            path = await synthesize(store, voice, text[:1000])
        except Exception as e:
            return web.json_response({"error": f"speech service failed: {e}"}, status=502)
        if path is None:
            return web.Response(status=204)
        return web.FileResponse(path, headers={"Content-Type": "audio/mpeg", "Cache-Control": "max-age=31536000"})

    routes.static("/static", STATIC)
    app = web.Application(client_max_size=100 * 1024 * 1024, middlewares=[auth.middleware])
    app.add_routes(routes)
    app.add_routes(auth.routes())
    if cache_mb:
        async def start_pruner(app):
            app["pruner"] = asyncio.create_task(prune_forever(store.tts, cache_mb))
        app.on_startup.append(start_pruner)
    return app


def bootstrap(store: Store, password: str, admin_name: str) -> Users:
    """First start: create the first user and give them the existing library.

    With BW_PASSWORD set that user is an admin who signs in with it (BW_ADMIN names them, "admin" by
    default); otherwise it is a sign-in-free local user. Afterwards users.json is the source of truth
    and BW_PASSWORD is ignored (except to turn an existing local user into a real account)."""
    users = Users(store.root)
    if not users.all:
        uid = users.create(admin_name if password else "local", password or None, admin=True)
        print(f"created {'admin account ' + repr(admin_name) if password else 'local user'}", flush=True)
    elif password and not users.accounts_enabled:
        uid = next(iter(users.all))
        users.rename(uid, admin_name)
        users.set_password(uid, password)
    if not users.data.get("migrated"):
        admin = next(uid for uid, u in users.all.items() if u.get("admin"))
        store.migrate_legacy(admin)
        users.data["migrated"] = True
        users.save()
    return users


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

    store = Store(args.data)
    users = bootstrap(store, password, env("BW_ADMIN", "admin"))
    lib = store.lib(next(uid for uid, u in users.all.items() if u.get("admin")))
    opened = None
    for f in args.epub:
        p = Path(f)
        opened = lib.add(p.read_bytes(), p.name)
        print(f"added {p.name}")

    url = f"http://{args.host}:{args.port}/" + (f"#/book/{opened}" if opened else "")
    print(f"Book Watcher on {url}" + (" (sign-in required)" if users.accounts_enabled else ""), flush=True)
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    web.run_app(make_app(store, users, cache_mb), host=args.host, port=args.port, print=None)


if __name__ == "__main__":
    main()
