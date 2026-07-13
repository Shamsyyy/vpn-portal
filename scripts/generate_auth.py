"""Generate auth.json with PBKDF2 password hash for the portal."""
from __future__ import annotations

import base64
import hashlib
import json
import secrets
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "auth.json"


def hash_password(password: str, salt: bytes | None = None, iterations: int = 120_000) -> dict:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return {
        "algorithm": "PBKDF2-SHA256",
        "iterations": iterations,
        "salt": base64.b64encode(salt).decode("ascii"),
        "hash": base64.b64encode(digest).decode("ascii"),
    }


def main() -> None:
    password = sys.argv[1] if len(sys.argv) > 1 else "vpn-portal-2026"
    payload = hash_password(password)
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote {OUT}")
    print(f"Password: {password}")


if __name__ == "__main__":
    main()
