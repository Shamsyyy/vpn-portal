"""Apply portal overrides to 3x-ui via panel API over SSH."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
OVERRIDES_PATH = ROOT / "data" / "overrides.json"
DASHBOARD_CFG = Path(__file__).resolve().parents[2] / "dashboard" / "config.json"

SERVERS = {
    "shm137": {"host": "89.125.59.150"},
    "evka": {"host": "78.17.4.178"},
}

INLINE_REMOTE = r'''
import json, requests
requests.packages.urllib3.disable_warnings()

changes = json.loads(CHANGES_JSON)
cfg = json.load(open("/opt/vpn-dashboard/config.json", encoding="utf-8"))
base = cfg["panel_url"].rstrip("/")
s = requests.Session()
s.verify = False
csrf = s.get(f"{base}/csrf-token", timeout=15).json()["obj"]
headers = {"X-CSRF-TOKEN": csrf}
login = s.post(
    f"{base}/login",
    json={"username": cfg["panel_user"], "password": cfg["panel_password"]},
    headers=headers,
    timeout=15,
).json()
if not login.get("success"):
    raise SystemExit(login.get("msg") or "login failed")

for email, patch in changes.items():
    resp = s.get(f"{base}/panel/api/clients/get/{email}", headers=headers, timeout=20).json()
    client = (resp.get("obj") or {}).get("client") or {}
    if not client:
        raise SystemExit(f"client not found: {email}")
    body = {
        "email": client["email"],
        "enable": bool(patch.get("enable", client.get("enable", True))),
        "totalGB": int(patch.get("totalGB", client.get("totalGB") or 0)),
        "expiryTime": int(patch.get("expiryTime", client.get("expiryTime") or 0)),
        "limitIp": int(client.get("limitIp") or 0),
        "tgId": int(client.get("tgId") or 0),
        "reset": int(client.get("reset") or 0),
    }
    result = s.post(
        f"{base}/panel/api/clients/update/{email}",
        json=body,
        headers=headers,
        timeout=20,
    ).json()
    if not result.get("success"):
        raise SystemExit(result.get("msg") or f"update failed: {email}")
    print("OK", email)
print("DONE", len(changes))
'''


def ssh_password(server_id: str) -> str:
    env_key = f"SSH_PASS_{server_id.upper()}" if server_id != "shm137" else "SSH_PASS_SHM"
    from_env = os.environ.get(env_key) or os.environ.get("SSH_PASS_SHM137")
    if from_env:
        return from_env
    dashboard_cfg = {}
    if DASHBOARD_CFG.exists():
        dashboard_cfg = json.loads(DASHBOARD_CFG.read_text(encoding="utf-8"))
    if server_id == "shm137":
        return dashboard_cfg.get("ssh_password") or r"#m=C}Dv)f3Qc^f:fMhh5e94QbiWjJh:g"
    if server_id == "evka":
        return "y4M4NQbaR8ork55BJ8"
    raise ValueError(server_id)


def apply_server(server_id: str, changes: dict) -> None:
    meta = SERVERS[server_id]
    changes_json = json.dumps(changes, ensure_ascii=False)
    script = INLINE_REMOTE.replace("CHANGES_JSON", repr(changes_json))
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        meta["host"], 22, "root", ssh_password(server_id),
        timeout=25, allow_agent=False, look_for_keys=False,
    )
    _, stdout, stderr = client.exec_command(f"python3 - <<'PY'\n{script}\nPY", timeout=180)
    out = stdout.read().decode("utf-8", "replace")
    err = stderr.read().decode("utf-8", "replace")
    rc = stdout.channel.recv_exit_status()
    client.close()
    print(out)
    if rc != 0:
        raise RuntimeError(err or out or f"exit {rc}")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else OVERRIDES_PATH
    if not path.exists():
        print("No overrides file:", path)
        return
    data = json.loads(path.read_text(encoding="utf-8"))
    for server_id, changes in (data.get("servers") or {}).items():
        if server_id not in SERVERS or not changes:
            continue
        print(f"Applying {len(changes)} changes to {server_id}...")
        apply_server(server_id, changes)
    print("All done.")


if __name__ == "__main__":
    main()
