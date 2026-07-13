"""Run VPN probes on server via SSH; output JSON for portal."""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data" / "probes"
DASHBOARD_CFG = Path(__file__).resolve().parents[2] / "dashboard" / "config.json"

SERVERS = {
    "shm137": {"host": "89.125.59.150", "public_host": "89.125.59.150"},
    "evka": {"host": "78.17.4.178", "public_host": "78.17.4.178"},
}


def ssh_password(server_id: str) -> str:
    env_key = "SSH_PASS_SHM" if server_id == "shm137" else "SSH_PASS_EVKA"
    from_env = (os.environ.get(env_key) or "").strip()
    if from_env:
        return from_env
    if DASHBOARD_CFG.exists():
        cfg = json.loads(DASHBOARD_CFG.read_text(encoding="utf-8"))
        if server_id == "shm137" and cfg.get("ssh_password"):
            return cfg["ssh_password"]
    raise RuntimeError(f"Missing secret {env_key}")


def probe_server(server_id: str, email: str = "all", full: bool = True) -> dict:
    meta = SERVERS[server_id]
    script = f'''
import json, sqlite3, sys
sys.path.insert(0, "/opt/vpn-dashboard")
from vpn_probe import probe_client

email_filter = {json.dumps(email)}
tunnel_all = {json.dumps(full)}
public_host = {json.dumps(meta["public_host"])}

con = sqlite3.connect("/etc/x-ui/x-ui.db")
cur = con.cursor()
cur.execute("SELECT key, value FROM settings WHERE key IN ('subPort','subPath','subDomain')")
settings = dict(cur.fetchall())
sub_domain = settings.get("subDomain") or ""
sub_port = settings.get("subPort") or ""
sub_path = (settings.get("subPath") or "/").rstrip("/")
sub_base = f"https://{{sub_domain}}:{{sub_port}}{{sub_path}}" if sub_domain and sub_port else ""

cur.execute("SELECT email, sub_id FROM clients ORDER BY email")
rows = []
for em, sub_id in cur.fetchall():
    if not sub_id:
        continue
    if email_filter != "all" and em != email_filter:
        continue
    sub_url = f"{{sub_base}}/{{sub_id}}"
    try:
        result = probe_client(em, sub_url, public_host, tunnel_all=tunnel_all)
        rows.append({{
            "email": em,
            "ok": result.get("ok"),
            "summary": result.get("summary"),
            "tunnels_ok": result.get("tunnels_ok"),
            "tunnels_total": result.get("tunnels_total"),
            "issues": result.get("issues") or [],
            "tunnels": [
                {{
                    "port": t.get("port"),
                    "type": t.get("type"),
                    "tunnel_ok": t.get("tunnel_ok"),
                    "latency_ms": t.get("latency_ms"),
                    "detail": t.get("detail"),
                }}
                for t in (result.get("tunnels") or [])
            ],
        }})
    except Exception as exc:
        rows.append({{"email": em, "ok": False, "issues": [str(exc)], "tunnels": []}})
con.close()
print(json.dumps({{"results": rows}}, ensure_ascii=False))
'''
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        meta["host"], 22, "root", ssh_password(server_id),
        timeout=25, allow_agent=False, look_for_keys=False,
    )
    _, stdout, stderr = client.exec_command(f"python3 - <<'PY'\n{script}\nPY", timeout=600 if email == "all" else 120)
    raw = stdout.read().decode("utf-8", "replace").strip()
    err = stderr.read().decode("utf-8", "replace").strip()
    rc = stdout.channel.recv_exit_status()
    client.close()
    if rc != 0 or not raw:
        raise RuntimeError(err or raw or f"probe failed rc={rc}")
    lines = [ln for ln in raw.splitlines() if ln.strip().startswith("{")]
    payload = json.loads(lines[-1])
    payload["serverId"] = server_id
    payload["probedAt"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    payload["emailFilter"] = email
    payload["fullTunnel"] = full
    return payload


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    server_id = sys.argv[1] if len(sys.argv) > 1 else "shm137"
    email = sys.argv[2] if len(sys.argv) > 2 else "all"
    full = sys.argv[3] != "0" if len(sys.argv) > 3 else True
    if server_id == "all":
        targets = list(SERVERS.keys())
    else:
        targets = [server_id]
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for sid in targets:
        print(f"Probing {sid} ({email})...", file=sys.stderr)
        data = probe_server(sid, email, full)
        out = DATA_DIR / f"{sid}.json"
        out.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        ok = sum(1 for r in data.get("results", []) if r.get("ok"))
        total = len(data.get("results", []))
        print(f"  -> {out} ({ok}/{total} OK)", file=sys.stderr)
    print(json.dumps({"servers": targets, "email": email}, ensure_ascii=False))


if __name__ == "__main__":
    main()
