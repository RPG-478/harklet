"""One Quicksand VM per Harklet browser session. stdout is a small JSON protocol."""

import asyncio
import json
import logging
import os
import shutil
import sys
import uuid
from pathlib import Path

# stderr is captured by startVm and surfaced on failure; stdout is the protocol.
logging.basicConfig(
    level=logging.DEBUG if os.environ.get("HARKLET_DEBUG") else logging.INFO,
    stream=sys.stderr,
)

from quicksand import NetworkMode, PortForward
from quicksand_cua import CuaSandbox


async def main():
    name, port, data_dir = sys.argv[1], int(sys.argv[2]), Path(sys.argv[3])
    viewer_port = int(sys.argv[4]) if len(sys.argv) > 4 else None
    viewer_interactive = len(sys.argv) > 5 and sys.argv[5] == "1"
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
        memory=os.environ.get("HARKLET_VM_MEMORY", "2G"),
        cpus=2,
        network_mode=NetworkMode.FULL,
        port_forwards=[PortForward(host=port, guest=9223)] +
            ([PortForward(host=viewer_port, guest=6081)] if viewer_port else []),
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
        # Kiosk mode pins the viewport to the X display size, so screenshot,
        # element coordinates, mouse clicks and the noVNC view all share one
        # coordinate space. A windowed browser drifts (e.g. 1050x861 vs the
        # 1280x800 the code assumed) and every offset breaks click aiming.
        result = await vm.execute("DISPLAY=:0 setsid /usr/local/bin/chromium --no-sandbox "
            "--disable-gpu --no-first-run --kiosk --force-device-scale-factor=1 "
            "--hide-crash-restore-bubble --password-store=basic --remote-debugging-address=0.0.0.0 "
            "--remote-debugging-port=9222 --remote-allow-origins=* "
            "--user-data-dir=/root/.config/harklet-browser about:blank "
            ">/tmp/harklet-chromium.log 2>&1 </dev/null &")
        if result.exit_code != 0:
            raise RuntimeError(f"Chromium failed to start: {result.stderr}")
        relay = await vm.execute("setsid socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork "
            "TCP:127.0.0.1:9222 >/tmp/harklet-cdp-relay.log 2>&1 </dev/null &")
        if relay.exit_code != 0:
            raise RuntimeError(f"CDP relay failed: {relay.stderr}")
        viewer_ready = False
        if viewer_port:
            # The bundled noVNC has no authentication. Pin the service flags and
            # expose it only through QEMU's loopback host forward. Interactive
            # mode lets the owner solve captchas from the viewer.
            mode_flag = "" if viewer_interactive else " -viewonly"
            override = await vm.execute("mkdir -p /run/systemd/system/x11vnc.service.d && "
                "printf '[Service]\\nExecStart=\\nExecStart=/usr/bin/x11vnc -display :0 "
                "-rfbport 5901 -forever -shared -nopw -localhost" + mode_flag + "\\n' "
                "> /run/systemd/system/x11vnc.service.d/harklet.conf && "
                "systemctl daemon-reload && systemctl restart x11vnc.service novnc.service")
            if override.exit_code == 0:
                bridge = await vm.execute("setsid socat TCP-LISTEN:6081,bind=0.0.0.0,reuseaddr,fork "
                    "TCP:127.0.0.1:6080 >/tmp/harklet-novnc-relay.log 2>&1 </dev/null &")
                if bridge.exit_code == 0:
                    for _ in range(40):
                        probe = await vm.execute("curl -fsS --max-time 2 http://127.0.0.1:6080/vnc.html >/dev/null")
                        vnc = await vm.execute("ss -ltn | grep -q ':5901 ' && "
                            "ps -C x11vnc -o args= | grep -q -- '" +
                            ("-rfbport 5901" if viewer_interactive else "-viewonly") + "'")
                        if probe.exit_code == 0 and vnc.exit_code == 0:
                            viewer_ready = True
                            break
                        await asyncio.sleep(0.5)
        for _ in range(40):
            probe = await vm.execute("curl -fsS --max-time 4 http://127.0.0.1:9222/json/version")
            if probe.exit_code == 0:
                break
            await asyncio.sleep(0.5)
        else:
            log = await vm.execute("tail -30 /tmp/harklet-chromium.log")
            raise RuntimeError(f"Chromium CDP did not start: {probe.stderr}; {log.stdout}")
        listen = await vm.execute("ss -ltnp | grep -E '9222|9223' || true")
        print(json.dumps({"ready": True, "port": port, "listen": listen.stdout.strip(),
            "viewer_ready": viewer_ready}), flush=True)
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
        # Drop the superseded save so overlays do not fill the disk.
        # The base image lives in site-packages and is never under `saves`.
        if current != name and (saved / "manifest.json").exists():
            await asyncio.to_thread(shutil.rmtree, saved, True)
    finally:
        await vm.stop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(json.dumps({"error": str(exc)}), flush=True)
        sys.exit(1)
