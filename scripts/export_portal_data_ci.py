"""CI wrapper: export using GitHub Actions secrets."""
import os
import sys
from pathlib import Path

# Patch passwords from env before import
sys.path.insert(0, str(Path(__file__).resolve().parent))
import export_portal_data as exp  # noqa: E402

if os.environ.get("SSH_PASS_SHM"):
    orig = exp.ssh_password

    def ssh_password(server_id: str, dashboard_cfg: dict) -> str:
        if server_id == "shm137":
            return os.environ["SSH_PASS_SHM"]
        if server_id == "evka":
            return os.environ.get("SSH_PASS_EVKA", "")
        return orig(server_id, dashboard_cfg)

    exp.ssh_password = ssh_password

if __name__ == "__main__":
    exp.main()
