"""Single shared password -> signed session cookie. Off unless a password is configured."""

import asyncio
import hashlib
import hmac
import html
import secrets
import time
from pathlib import Path

from aiohttp import web

COOKIE = "bw_session"
SESSION_DAYS = 180
OPEN_PATHS = {"/login", "/logout", "/favicon.ico", "/manifest.webmanifest", "/sw.js"}
OPEN_PREFIXES = ("/static/icons/",)  # the manifest's icons are fetched without cookies
MAX_FAILS, FAIL_WINDOW = 8, 600  # per client address


class Auth:
    def __init__(self, password: str, data_dir: Path):
        self.password = password
        secret_file = data_dir / "secret"
        if not secret_file.exists():
            secret_file.write_text(secrets.token_hex(32))
            secret_file.chmod(0o600)
        # Keyed on the password too, so changing it signs everyone out.
        self.key = hashlib.sha256(secret_file.read_text().encode() + b"\0" + password.encode()).digest()
        self.fails: dict[str, list[float]] = {}

    def _sign(self, expiry: int) -> str:
        return hmac.new(self.key, str(expiry).encode(), hashlib.sha256).hexdigest()

    def token(self) -> str:
        expiry = int(time.time()) + SESSION_DAYS * 86400
        return f"{expiry}.{self._sign(expiry)}"

    def valid(self, token: str | None) -> bool:
        try:
            expiry, sig = token.split(".", 1)
            return int(expiry) > time.time() and hmac.compare_digest(sig, self._sign(int(expiry)))
        except (AttributeError, ValueError):
            return False

    def client(self, request: web.Request) -> str:
        # Behind nginx the peer is 127.0.0.1; X-Real-IP is set by our own proxy config.
        return request.headers.get("X-Real-IP") or request.remote or "?"

    def locked_out(self, who: str) -> bool:
        now = time.time()
        recent = self.fails[who] = [t for t in self.fails.get(who, []) if now - t < FAIL_WINDOW]
        return len(recent) >= MAX_FAILS

    @web.middleware
    async def middleware(self, request: web.Request, handler):
        if request.path in OPEN_PATHS or request.path.startswith(OPEN_PREFIXES) or self.valid(request.cookies.get(COOKIE)):
            return await handler(request)
        if request.path.startswith("/api/"):
            return web.json_response({"error": "not signed in"}, status=401)
        raise web.HTTPFound("/login")

    def routes(self) -> list[web.RouteDef]:
        async def login_page(request):
            return page()

        async def login(request):
            who = self.client(request)
            if self.locked_out(who):
                return page("Too many attempts. Try again in a few minutes.", status=429)
            form = await request.post()
            if hmac.compare_digest(str(form.get("password", "")).encode(), self.password.encode()):
                self.fails.pop(who, None)
                resp = web.HTTPFound("/")
                secure = request.secure or request.headers.get("X-Forwarded-Proto") == "https"
                resp.set_cookie(COOKIE, self.token(), max_age=SESSION_DAYS * 86400,
                                httponly=True, secure=secure, samesite="Lax")
                return resp
            self.fails[who].append(time.time())
            await asyncio.sleep(1)
            return page("Wrong password.", status=401)

        async def logout(request):
            resp = web.HTTPFound("/login")
            resp.del_cookie(COOKIE)
            return resp

        return [web.get("/login", login_page), web.post("/login", login), web.get("/logout", logout)]


def page(error: str = "", status: int = 200) -> web.Response:
    msg = f'<p class="err" role="alert">{html.escape(error)}</p>' if error else ""
    return web.Response(status=status, content_type="text/html", text=f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Book Watcher</title>
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
  <p>Enter the password to continue.</p>
  {msg}
  <input type="password" name="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required autofocus>
  <button type="submit">Sign in</button>
</form></body></html>""")
