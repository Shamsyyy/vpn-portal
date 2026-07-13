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
import json, requests
requests.packages.urllib3.disable_warnings()

payload = json.loads({json.dumps(changes_json)})
clients = payload.get("clients") or {{}}
creates = payload.get("create") or []
resets = payload.get("resetTraffic") or []
deletes = payload.get("delete") or []
inbounds_patch = payload.get("inbounds") or {{}}

cfg = json.load(open("/opt/vpn-dashboard/config.json", encoding="utf-8"))
base = cfg["panel_url"].rstrip("/")
s = requests.Session()
s.verify = False

def api_json(resp, label):
    if not resp.text.strip():
        raise SystemExit(f"{{label}}: empty HTTP {{resp.status_code}}")
    try:
        return resp.json()
    except Exception:
        raise SystemExit(f"{{label}}: HTTP {{resp.status_code}} {{resp.text[:300]}}")

csrf = api_json(s.get(f"{{base}}/csrf-token", timeout=15), "csrf")["obj"]
headers = {{"X-CSRF-TOKEN": csrf}}
login = api_json(s.post(
    f"{{base}}/login",
    json={{"username": cfg["panel_user"], "password": cfg["panel_password"]}},
    headers=headers, timeout=15,
), "login")
if not login.get("success"):
    raise SystemExit(login.get("msg") or "login failed")

def get_client(email):
    data = api_json(s.get(f"{{base}}/panel/api/clients/get/{{email}}", headers=headers, timeout=20), f"get {{email}}")
    return (data.get("obj") or {{}}).get("client") or {{}}

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
    result = api_json(s.post(
        f"{{base}}/panel/api/clients/update/{{email}}",
        json=body, headers=headers, timeout=20,
    ), f"update {{email}}")
    if not result.get("success"):
        raise SystemExit(result.get("msg") or f"update failed: {{email}}")

for email, patch in clients.items():
    if not patch:
        continue
    server_patch = {{k: v for k, v in patch.items() if k in ("enable", "totalGB", "expiryTime", "limitIp")}}
    if server_patch:
        update_client(email, server_patch)
        print("UPDATE", email)

for email in resets:
    result = api_json(s.post(
        f"{{base}}/panel/api/clients/resetTraffic/{{email}}",
        headers=headers, timeout=20,
    ), f"reset {{email}}")
    if not result.get("success"):
        raise SystemExit(result.get("msg") or f"reset failed: {{email}}")
    print("RESET", email)

for email in deletes:
    result = api_json(s.post(
        f"{{base}}/panel/api/clients/del/{{email}}",
        headers=headers, timeout=20,
    ), f"delete {{email}}")
    if not result.get("success"):
        raise SystemExit(result.get("msg") or f"delete failed: {{email}}")
    print("DELETE", email)

if creates:
    inbounds = api_json(s.get(f"{{base}}/panel/api/inbounds/list", headers=headers, timeout=20), "inbounds").get("obj") or []
    inbound_ids = [ib["id"] for ib in inbounds if ib.get("enable")]
    if not inbound_ids:
        raise SystemExit("no enabled inbounds")
    for item in creates:
        email = (item.get("email") if isinstance(item, dict) else item) or ""
        email = str(email).strip()
        if not email:
            continue
        result = api_json(s.post(
            f"{{base}}/panel/api/clients/add",
            json={{
                "client": {{
                    "email": email,
                    "enable": True,
                    "expiryTime": 0,
                    "totalGB": 0,
                    "limitIp": 0,
                    "tgId": 0,
                    "reset": 0,
                }},
                "inboundIds": inbound_ids,
            }},
            headers=headers, timeout=20,
        ), f"create {{email}}")
        if not result.get("success"):
            raise SystemExit(result.get("msg") or f"create failed: {{email}}")
        print("CREATE", email)

if inbounds_patch:
    listed = api_json(s.get(f"{{base}}/panel/api/inbounds/list", headers=headers, timeout=20), "inbounds").get("obj") or []
    by_id = {{str(ib.get("id")): ib for ib in listed}}
    for ib_id, patch in inbounds_patch.items():
        ib = by_id.get(str(ib_id))
        if not ib:
            raise SystemExit(f"inbound not found: {{ib_id}}")
        body = {{
            "enable": bool(patch.get("enable", ib.get("enable", True))),
            "remark": patch.get("remark", ib.get("remark")),
            "listen": ib.get("listen", ""),
            "port": ib.get("port"),
            "protocol": ib.get("protocol", "vless"),
            "settings": ib.get("settings") or {{}},
            "streamSettings": ib.get("streamSettings") or ib.get("stream_settings") or {{}},
            "sniffing": ib.get("sniffing") or {{"enabled": True, "destOverride": ["http", "tls", "quic", "fakedns"]}},
            "tag": ib.get("tag"),
        }}
        result = api_json(s.post(
            f"{{base}}/panel/api/inbounds/update/{{ib_id}}",
            json=body, headers=headers, timeout=20,
        ), f"inbound {{ib_id}}")
        if not result.get("success"):
            raise SystemExit(result.get("msg") or f"inbound update failed: {{ib_id}}")
        print("INBOUND", ib_id)

print("DONE")
'''


def ssh_password(server_id: str) -> str:
    env_key = "SSH_PASS_SHM" if server_id == "shm137" else "SSH_PASS_EVKA"
    from_env = (os.environ.get(env_key) or "").strip()
    if from_env:
        return from_env
    if DASHBOARD_CFG.exists():
        dashboard_cfg = json.loads(DASHBOARD_CFG.read_text(encoding="utf-8"))
        local = (dashboard_cfg.get("ssh_password") or "").strip()
        if server_id == "shm137" and local:
            return local
    raise RuntimeError(
        f"SSH password missing for {server_id}. "
        f"Add GitHub secret {env_key} in repo Settings → Secrets."
    )


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
            for k in ("clients", "create", "resetTraffic", "delete", "inbounds")
        )
        if not has_work:
            continue
        print(f"Applying on {server_id}...")
        apply_server(server_id, server_payload)
    print("All done.")


if __name__ == "__main__":
    main()
