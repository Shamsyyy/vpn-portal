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


def build_remote_script(changes_json: str) -> str:
    return f'''
import json, requests, uuid as uuidlib
requests.packages.urllib3.disable_warnings()

payload = json.loads({json.dumps(changes_json)})
clients = payload.get("clients") or {{}}
creates = payload.get("create") or []
resets = payload.get("resetTraffic") or []
deletes = payload.get("delete") or []

cfg = json.load(open("/opt/vpn-dashboard/config.json", encoding="utf-8"))
base = cfg["panel_url"].rstrip("/")
s = requests.Session()
s.verify = False
csrf = s.get(f"{{base}}/csrf-token", timeout=15).json()["obj"]
headers = {{"X-CSRF-TOKEN": csrf}}
login = s.post(
    f"{{base}}/login",
    json={{"username": cfg["panel_user"], "password": cfg["panel_password"]}},
    headers=headers, timeout=15,
).json()
if not login.get("success"):
    raise SystemExit(login.get("msg") or "login failed")

def get_client(email):
    r = s.get(f"{{base}}/panel/api/clients/get/{{email}}", headers=headers, timeout=20).json()
    return (r.get("obj") or {{}}).get("client") or {{}}

def update_client(email, patch):
    c = get_client(email)
    if not c:
        raise SystemExit(f"client not found: {{email}}")
    body = {{
        "email": c["email"],
        "enable": bool(patch.get("enable", c.get("enable", True))),
        "totalGB": int(patch.get("totalGB", c.get("totalGB") or 0)),
        "expiryTime": int(patch.get("expiryTime", c.get("expiryTime") or 0)),
        "limitIp": int(patch.get("limitIp", c.get("limitIp") or 0)),
        "tgId": int(c.get("tgId") or 0),
        "reset": int(c.get("reset") or 0),
    }}
    u = s.post(f"{{base}}/panel/api/clients/update/{{email}}", json=body, headers=headers, timeout=20).json()
    if not u.get("success"):
        raise SystemExit(u.get("msg") or email)

for email, patch in clients.items():
  if patch:
    update_client(email, patch)
    print("UPDATE", email)

for email in resets:
    u = s.post(f"{{base}}/panel/api/clients/{{email}}/resetTraffic", headers=headers, timeout=20).json()
    if not u.get("success"):
        raise SystemExit(u.get("msg") or email)
    print("RESET", email)

for email in deletes:
    u = s.post(f"{{base}}/panel/api/clients/del/{{email}}", headers=headers, timeout=20).json()
    if not u.get("success"):
        raise SystemExit(u.get("msg") or email)
    print("DELETE", email)

inbounds = s.get(f"{{base}}/panel/api/inbounds/list", headers=headers, timeout=20).json().get("obj") or []
ib_id = next((ib["id"] for ib in inbounds if ib.get("enable")), None)
if not ib_id and inbounds:
    ib_id = inbounds[0]["id"]

for item in creates:
    email = item.get("email") if isinstance(item, dict) else item
    if not email or not ib_id:
        continue
    body = {{
        "id": ib_id,
        "settings": json.dumps({{
            "clients": [{{
                "id": str(uuidlib.uuid4()),
                "email": email,
                "enable": True,
                "expiryTime": 0,
                "totalGB": 0,
                "limitIp": 0,
                "subId": str(uuidlib.uuid4()),
                "tgId": "",
                "reset": 0,
            }}]
        }}),
    }}
    u = s.post(f"{{base}}/panel/api/inbounds/addClient", json=body, headers=headers, timeout=20).json()
    if not u.get("success"):
        raise SystemExit(u.get("msg") or email)
    print("CREATE", email)

print("DONE")
'''


def ssh_password(server_id: str) -> str:
    env_key = "SSH_PASS_SHM" if server_id == "shm137" else "SSH_PASS_EVKA"
    from_env = os.environ.get(env_key)
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


def apply_server(server_id: str, server_payload: dict) -> None:
    meta = SERVERS[server_id]
    changes_json = json.dumps(server_payload, ensure_ascii=False)
    script = build_remote_script(changes_json)
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        meta["host"], 22, "root", ssh_password(server_id),
        timeout=25, allow_agent=False, look_for_keys=False,
    )
    _, stdout, stderr = client.exec_command(f"python3 - <<'PY'\n{script}\nPY", timeout=240)
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
    for server_id, server_payload in (data.get("servers") or {}).items():
        if server_id not in SERVERS or not server_payload:
            continue
        has_work = any(
            server_payload.get(k)
            for k in ("clients", "create", "resetTraffic", "delete")
        )
        if not has_work:
            continue
        print(f"Applying on {server_id}...")
        apply_server(server_id, server_payload)
    print("All done.")


if __name__ == "__main__":
    main()
