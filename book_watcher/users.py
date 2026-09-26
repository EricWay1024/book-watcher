"""Accounts: users.json holds every user; one admin creates the others.

users.json = {"users": {uid: {"name", "hash", "admin", "created", "seen"}}, "migrated": bool}
A user without a password hash is the implicit "local" user of a server run without accounts.
"""

import hashlib
import hmac
import json
import re
import secrets
import time
from pathlib import Path

NAME_RE = re.compile(r"[a-z0-9][a-z0-9_.-]{1,31}")
MIN_PASSWORD = 8
SCRYPT = {"n": 2**14, "r": 8, "p": 1}  # ~16 MB and a few tens of ms per hash


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, dklen=32, **SCRYPT)
    return f"scrypt${SCRYPT['n']}${SCRYPT['r']}${SCRYPT['p']}${salt.hex()}${digest.hex()}"


def check_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        _, n, r, p, salt, digest = stored.split("$")
        got = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), dklen=32, n=int(n), r=int(r), p=int(p))
        return hmac.compare_digest(got.hex(), digest)
    except ValueError:
        return False


def new_password() -> str:
    return secrets.token_urlsafe(9)  # 12 characters


class UserError(ValueError):
    pass


class Users:
    def __init__(self, root: Path):
        self.path = root / "users.json"
        try:
            self.data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            self.data = {"users": {}, "migrated": False}

    def save(self) -> None:
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=1))
        tmp.chmod(0o600)
        tmp.replace(self.path)

    @property
    def all(self) -> dict[str, dict]:
        return self.data["users"]

    def get(self, uid: str) -> dict | None:
        return self.all.get(uid)

    def by_name(self, name: str) -> tuple[str, dict] | None:
        name = name.strip().lower()
        return next(((uid, u) for uid, u in self.all.items() if u["name"] == name), None)

    @property
    def accounts_enabled(self) -> bool:
        return any(u.get("hash") for u in self.all.values())

    def _check_name(self, name: str, uid: str | None = None) -> str:
        name = name.strip().lower()
        if not NAME_RE.fullmatch(name):
            raise UserError("Usernames are 2–32 characters: letters, digits, dot, dash or underscore.")
        other = self.by_name(name)
        if other and other[0] != uid:
            raise UserError(f"“{name}” is already taken.")
        return name

    @staticmethod
    def _check_password(password: str) -> None:
        if len(password) < MIN_PASSWORD:
            raise UserError(f"Passwords need at least {MIN_PASSWORD} characters.")

    def create(self, name: str, password: str | None, admin: bool = False) -> str:
        name = self._check_name(name)
        if password is not None:
            self._check_password(password)
        uid = secrets.token_hex(6)
        self.all[uid] = {
            "name": name, "hash": hash_password(password) if password else None,
            "admin": admin, "created": int(time.time() * 1000),
        }
        self.save()
        return uid

    def set_password(self, uid: str, password: str) -> None:
        self._check_password(password)
        self.all[uid]["hash"] = hash_password(password)
        self.save()

    def rename(self, uid: str, name: str) -> None:
        self.all[uid]["name"] = self._check_name(name, uid)
        self.save()

    def delete(self, uid: str) -> None:
        self.all.pop(uid, None)
        self.save()

    def touch(self, uid: str) -> None:
        """Record activity, at most every 10 minutes per user (it rewrites users.json)."""
        u = self.all.get(uid)
        now = int(time.time() * 1000)
        if u and now - u.get("seen", 0) > 600_000:
            u["seen"] = now
            self.save()
