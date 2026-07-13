"""Export sanitized VPN portal data from shm137 and evka."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DASHBOARD_CFG = Path(__file__).resolve().parents[2] / "dashboard" / "config.json"

SERVERS = [
    {
        "id": "shm137",
        "name": "shm137",
        "host": "89.125.59.150",
        "label": "shm137",
    },
    {
        "id": "evka",
        "name": "evka",
        "host": "78.17.4.178",
        "label": "evka",
    },
]

REMOTE = r'''
import json, sqlite3, subprocess, time

def fmt_bytes(n):
    n = int(n or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024:
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024
    return f"{n:.1f} PB"

now_ms = int(time.time() * 1000)
online_threshold = now_ms - 5 * 60 * 1000

con = sqlite3.connect("/etc/x-ui/x-ui.db")
cur = con.cursor()
cur.execute("SELECT key, value FROM settings WHERE key IN ('subPort','subPath','subDomain','subEnable','remarkModel')")
settings = dict(cur.fetchall())
sub_domain = settings.get("subDomain") or ""
sub_port = settings.get("subPort") or ""
sub_path = (settings.get("subPath") or "/").rstrip("/")
sub_base = f"https://{sub_domain}:{sub_port}{sub_path}" if sub_domain and sub_port else ""

cur.execute("SELECT id, remark, enable, port, protocol, tag, stream_settings FROM inbounds ORDER BY port")
inbounds = []
for r in cur.fetchall():
    stream = json.loads(r[6] or "{}")
    rs = stream.get("realitySettings") or {}
    xh = stream.get("xhttpSettings") or {}
    snames = rs.get("serverNames") or []
    inbounds.append({
        "id": r[0], "remark": r[1], "enable": bool(r[2]), "port": r[3],
        "protocol": r[4], "tag": r[5],
        "network": stream.get("network") or "tcp",
        "security": stream.get("security") or "",
        "sni": snames[0] if snames else "",
        "dest": rs.get("target") or "",
        "xhttpPath": xh.get("path") or "",
        "xhttpMode": xh.get("mode") or "",
    })

cur.execute("""
    SELECT c.email, c.enable, c.expiry_time, c.total_gb, c.limit_ip, c.sub_id, c.id,
           COALESCE(t.up, 0), COALESCE(t.down, 0), COALESCE(t.last_online, 0)
    FROM clients c
    LEFT JOIN client_traffics t ON t.email = c.email
    ORDER BY c.email
""")
clients = []
total_up = total_down = 0
online_count = 0
for row in cur.fetchall():
    email, enable, expiry, total_gb, limit_ip, sub_id, uuid, up, down, last_online = row
    up, down, last_online = int(up or 0), int(down or 0), int(last_online or 0)
    total_up += up
    total_down += down
    is_online = last_online >= online_threshold
    if is_online:
        online_count += 1
    clients.append({
        "email": email,
        "enable": bool(enable),
        "expiryTime": int(expiry or 0),
        "totalGB": int(total_gb or 0),
        "limitIp": int(limit_ip or 0),
        "subId": sub_id or "",
        "uuid": str(uuid or ""),
        "subUrl": f"{sub_base}/{sub_id}" if sub_id and sub_base else "",
        "up": up, "down": down,
        "upHuman": fmt_bytes(up),
        "downHuman": fmt_bytes(down),
        "lastOnline": last_online,
        "online": is_online,
    })

cur.execute("SELECT client_id, inbound_id, flow_override FROM client_inbounds ORDER BY client_id, inbound_id")
client_inbounds = [
    {"clientId": r[0], "inboundId": r[1], "flowOverride": r[2] or ""}
    for r in cur.fetchall()
]
con.close()

xui_state = subprocess.getoutput("systemctl is-active x-ui").strip()
uptime = subprocess.getoutput("cut -d. -f1 /proc/uptime").strip()
loads = subprocess.getoutput("cat /proc/loadavg").split()[:3]
mem = subprocess.getoutput("free -m | awk 'NR==2{print $3,$2}'").split()
cpu_line = subprocess.getoutput("top -bn1 | grep 'Cpu(s)' | head -1")

print(json.dumps({
    "exportedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    "remarkModel": settings.get("remarkModel"),
    "subBase": sub_base,
    "inbounds": inbounds,
    "clients": clients,
    "clientInbounds": client_inbounds,
    "totals": {
        "up": total_up, "down": total_down,
        "upHuman": fmt_bytes(total_up),
        "downHuman": fmt_bytes(total_down),
        "online": online_count,
        "enabled": sum(1 for c in clients if c["enable"]),
    },
    "status": {
        "xui": xui_state,
        "uptimeSec": int(uptime) if uptime.isdigit() else 0,
        "load": loads,
        "memUsedMb": int(mem[0]) if len(mem) > 0 else 0,
        "memTotalMb": int(mem[1]) if len(mem) > 1 else 0,
        "cpuHint": cpu_line[:80],
    },
}, ensure_ascii=False))
'''


def ssh_password(server_id: str, dashboard_cfg: dict) -> str:
    if server_id == "shm137":
        return dashboard_cfg.get("ssh_password") or r"#m=C}Dv)f3Qc^f:fMhh5e94QbiWjJh:g"
    if server_id == "evka":
        return "y4M4NQbaR8ork55BJ8"
    raise ValueError(server_id)


def export_server(meta: dict, password: str) -> dict:
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(meta["host"], 22, "root", password, timeout=25, allow_agent=False, look_for_keys=False)
    _, stdout, stderr = client.exec_command(f"python3 - <<'PY'\n{REMOTE}\nPY", timeout=120)
    raw = stdout.read().decode("utf-8", "replace").strip()
    err = stderr.read().decode("utf-8", "replace").strip()
    client.close()
    if not raw:
        raise RuntimeError(f"{meta['id']}: empty export ({err[:200]})")
    payload = json.loads(raw)
    payload["id"] = meta["id"]
    payload["name"] = meta["name"]
    payload["host"] = meta["host"]
    payload["label"] = meta["label"]
    return payload


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    dashboard_cfg = {}
    if DASHBOARD_CFG.exists():
        dashboard_cfg = json.loads(DASHBOARD_CFG.read_text(encoding="utf-8"))

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    manifest = {
        "updatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "servers": [],
    }

    for meta in SERVERS:
        print(f"Exporting {meta['id']}...", file=sys.stderr)
        data = export_server(meta, ssh_password(meta["id"], dashboard_cfg))
        out_path = DATA_DIR / f"{meta['id']}.json"
        out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        manifest["servers"].append(
            {
                "id": meta["id"],
                "label": meta["label"],
                "host": meta["host"],
                "clients": len(data.get("clients") or []),
                "inbounds": len(data.get("inbounds") or []),
                "exportedAt": data.get("exportedAt"),
            }
        )
        print(f"  -> {out_path} ({len(data.get('clients') or [])} clients)", file=sys.stderr)

    (DATA_DIR / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
