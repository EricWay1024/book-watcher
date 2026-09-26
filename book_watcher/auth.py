"""Sign-in: username + password -> signed session cookie naming the user.

Without accounts (a local run, no password configured) every request is the single local user.
"""

import asyncio
import hashlib
import hmac
import html
import secrets
import time
from pathlib import Path

from aiohttp import web

from .users import Users, check_password

COOKIE = "bw_session"
SESSION_DAYS = 180
OPEN_PATHS = {"/login", "/logout", "/favicon.ico", "/manifest.webmanifest", "/sw.js"}
OPEN_PREFIXES = ("/static/icons/",)  # the manifest's icons are fetched without cookies
MAX_FAILS, FAIL_WINDOW = 8, 600  # per client address
_DUMMY_HASH = None  # compared against when the username doesn't exist, so timing doesn't reveal it


class Auth:
    def __init__(self, users: Users, data_dir: Path):
        self.users = users
        secret_file = data_dir / "secret"
        if not secret_file.exists():
            secret_file.write_text(secrets.token_hex(32))
            secret_file.chmod(0o600)
        self.secret = secret_file.read_text().encode()
        self.fails: dict[str, list[float]] = {}

    # A session is "uid.expiry.sig"; the signature covers the user's password hash, so changing
    # (or resetting) a password signs that user out everywhere, and deleting a user ends it too.
    def _sign(self, uid: str, expiry: int) -> str:
        user = self.users.get(uid) or {}
        msg = f"{uid}.{expiry}.{(user.get('hash') or '')[-24:]}".encode()
        return hmac.new(self.secret, msg, hashlib.sha256).hexdigest()

    def token(self, uid: str) -> str:
        expiry = int(time.time()) + SESSION_DAYS * 86400
        return f"{uid}.{expiry}.{self._sign(uid, expiry)}"

    def session_user(self, token: str | None) -> str | None:
        try:
            uid, expiry, sig = token.split(".")
        except (AttributeError, ValueError):
            return None
        if not self.users.get(uid) or not expiry.isdigit() or int(expiry) < time.time():
            return None
        return uid if hmac.compare_digest(sig, self._sign(uid, int(expiry))) else None

    def set_cookie(self, request: web.Request, resp: web.StreamResponse, uid: str) -> None:
        secure = request.secure or request.headers.get("X-Forwarded-Proto") == "https"
        resp.set_cookie(COOKIE, self.token(uid), max_age=SESSION_DAYS * 86400,
                        httponly=True, secure=secure, samesite="Lax")

    def client(self, request: web.Request) -> str:
        # Behind nginx the peer is 127.0.0.1; X-Real-IP is set by our own proxy config.
        return request.headers.get("X-Real-IP") or request.remote or "?"

    def locked_out(self, who: str) -> bool:
        now = time.time()
        recent = self.fails[who] = [t for t in self.fails.get(who, []) if now - t < FAIL_WINDOW]
        return len(recent) >= MAX_FAILS

    @web.middleware
    async def middleware(self, request: web.Request, handler):
        if not self.users.accounts_enabled:  # local run: the one local user, no sign-in
            request["uid"] = next(iter(self.users.all))
            return await handler(request)
        uid = self.session_user(request.cookies.get(COOKIE))
        if uid:
            request["uid"] = uid
            self.users.touch(uid)
            return await handler(request)
        if request.path in OPEN_PATHS or request.path.startswith(OPEN_PREFIXES):
            return await handler(request)
        if request.path.startswith("/api/"):
            return web.json_response({"error": "not signed in"}, status=401)
        raise web.HTTPFound("/login")

    def routes(self) -> list[web.RouteDef]:
        async def login_page(request):
            if not self.users.accounts_enabled:
                raise web.HTTPFound("/")
            return page()

        async def login(request):
            global _DUMMY_HASH
            who = self.client(request)
            if self.locked_out(who):
                return page("Too many attempts. Try again in a few minutes.", status=429)
            form = await request.post()
            name, password = str(form.get("username", "")), str(form.get("password", ""))
            found = self.users.by_name(name)
            if _DUMMY_HASH is None:
                from .users import hash_password
                _DUMMY_HASH = await asyncio.to_thread(hash_password, secrets.token_hex(8))
            ok = await asyncio.to_thread(check_password, password, found[1].get("hash") if found else _DUMMY_HASH)
            if found and ok:
                self.fails.pop(who, None)
                resp = web.HTTPFound("/")
                self.set_cookie(request, resp, found[0])
                return resp
            self.fails[who].append(time.time())
            await asyncio.sleep(1)
            return page("Wrong username or password.", status=401, name=name)

        async def logout(request):
            resp = web.HTTPFound("/login")
            resp.del_cookie(COOKIE)
            return resp

        return [web.get("/login", login_page), web.post("/login", login), web.get("/logout", logout)]


def page(error: str = "", status: int = 200, name: str = "") -> web.Response:
    msg = f'<p class="err" role="alert">{html.escape(error)}</p>' if error else ""
    return web.Response(status=status, content_type="text/html", text=f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book Watcher</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="apple-touch-icon" href="/static/icons/apple-touch-icon.png">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%23f2b544'/><path d='M12 9l12 7-12 7z' fill='%23111'/></svg>">
<style>
:root {{ --bg:#0d0e11; --panel:#15171b; --line:#2a2e36; --text:#eeede8; --muted:#8d919a; --accent:#f2b544; --ink:#1a1405; --err:#ff8a7a; color-scheme: dark; }}
@media (prefers-color-scheme: light) {{ :root {{ --bg:#f4f3ef; --panel:#fff; --line:#e2e0d9; --text:#1b1c1f; --muted:#6b6e75; --accent:#c7861a; --ink:#fff; --err:#c0392b; color-scheme: light; }} }}
* {{ box-sizing: border-box; }}
body {{ margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--text);
       font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }}
form {{ width:min(340px,100%); padding:28px 24px; border:1px solid var(--line); border-radius:16px; background:var(--panel); }}
h1 {{ margin:0 0 4px; font: 700 24px/1.2 Georgia, serif; }}
p {{ margin:0 0 20px; color:var(--muted); }}
input, button {{ width:100%; font:inherit; border-radius:10px; padding:10px 12px; }}
input {{ border:1px solid var(--line); background:var(--bg); color:var(--text); margin-bottom:12px; }}
input:focus-visible, button:focus-visible {{ outline:2px solid var(--accent); outline-offset:2px; }}
button {{ border:0; background:var(--accent); color:var(--ink); font-weight:600; cursor:pointer; }}
.err {{ color:var(--err); margin:0 0 12px; }}
</style></head><body>
<form method="post" action="/login">
  <h1>Book Watcher</h1>
  <p>Sign in to your library.</p>
  {msg}
  <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" aria-label="Username" placeholder="Username" value="{html.escape(name)}" required{'' if name else ' autofocus'}>
  <input type="password" name="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required{' autofocus' if name else ''}>
  <button type="submit">Sign in</button>
</form></body></html>""")
