"""One Quicksand VM per Harklet browser session. stdout is a small JSON protocol."""

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

from quicksand import NetworkMode, PortForward
from quicksand_cua import CuaSandbox


async def main():
    name, port, data_dir = sys.argv[1], int(sys.argv[2]), Path(sys.argv[3])
    saves = data_dir / "quicksand" / "sandboxes"
    saves.mkdir(parents=True, exist_ok=True)
    pointers = data_dir / "quicksand" / "users"
    pointers.mkdir(parents=True, exist_ok=True)
    pointer = pointers / f"{name}.json"
    current = json.loads(pointer.read_text(encoding="utf-8"))["save"] if pointer.exists() else name
    saved = saves / current
    image = str(saved) if (saved / "manifest.json").exists() else "quicksand-cua"
    vm = CuaSandbox(
        image=image,
        memory="2G",
        cpus=2,
        network_mode=NetworkMode.FULL,
        port_forwards=[PortForward(host=port, guest=9223)],
    )
    await vm.start()
    try:
        for _ in range(30):
            display = await vm.execute("test -S /tmp/.X11-unix/X0")
            if display.exit_code == 0:
                break
            await asyncio.sleep(1)
        else:
            status = await vm.execute("systemctl status xvfb.service --no-pager; journalctl -u xvfb.service -n 20 --no-pager")
            raise RuntimeError(f"VM display did not start: {status.stdout} {status.stderr}")
        # The bundled service has no CDP port. Replace it with a browser whose
        # profile lives on the guest disk and is included in Quicksand saves.
        prep = await vm.execute("systemctl stop chromium.service && mkdir -p /root/.config/harklet-browser")
        if prep.exit_code != 0:
            raise RuntimeError(f"Chromium preparation failed: {prep.stderr}")
        result = await vm.execute("DISPLAY=:0 setsid /usr/local/bin/chromium --no-sandbox "
            "--disable-gpu --no-first-run --password-store=basic --remote-debugging-address=0.0.0.0 "
            "--remote-debugging-port=9222 --remote-allow-origins=* "
            "--user-data-dir=/root/.config/harklet-browser about:blank "
            ">/tmp/harklet-chromium.log 2>&1 </dev/null &")
        if result.exit_code != 0:
            raise RuntimeError(f"Chromium failed to start: {result.stderr}")
        relay = await vm.execute("setsid socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork "
            "TCP:127.0.0.1:9222 >/tmp/harklet-cdp-relay.log 2>&1 </dev/null &")
        if relay.exit_code != 0:
            raise RuntimeError(f"CDP relay failed: {relay.stderr}")
        for _ in range(20):
            probe = await vm.execute("curl -fsS --max-time 2 http://127.0.0.1:9222/json/version")
            if probe.exit_code == 0:
                break
            await asyncio.sleep(0.5)
        else:
            log = await vm.execute("tail -30 /tmp/harklet-chromium.log")
            raise RuntimeError(f"Chromium CDP did not start: {probe.stderr}; {log.stdout}")
        listen = await vm.execute("ss -ltnp | grep -E '9222|9223' || true")
        print(json.dumps({"ready": True, "port": port, "listen": listen.stdout.strip()}), flush=True)
        await asyncio.to_thread(sys.stdin.readline)
        for _ in range(30):
            remaining = await vm.execute("pgrep -x chrome >/dev/null")
            if remaining.exit_code != 0:
                break
            await asyncio.sleep(0.5)
        else:
            await vm.execute("pkill -TERM -o -x chrome || true")
            await asyncio.sleep(2)
            remaining = await vm.execute("pgrep -x chrome >/dev/null")
            if remaining.exit_code == 0:
                raise RuntimeError("Chromium did not stop cleanly; VM was not saved")
        await vm.execute("sync")
        # Fail visibly if persistence fails; never claim the login is saved.
        next_name = f"{name}-{uuid.uuid4().hex[:12]}"
        await vm.save(next_name, workspace=saves)
        pending = pointer.with_suffix(".tmp")
        pending.write_text(json.dumps({"save": next_name}), encoding="utf-8")
        os.replace(pending, pointer)
    finally:
        await vm.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), flush=True)
        sys.exit(1)
