"""Local HTTP bridge from harklet to a Cua sandbox.

Two ways to act on the guest desktop:
  * coordinates: screenshot-based clicks through sb.mouse (always available)
  * elements: Cua Driver accessibility tree; clicks use the element token from the
    latest /elements read. /elements returns 503 when the driver cannot connect.

Listens on 127.0.0.1 only and requires the token from HARKLET_CUA_TOKEN on every
request except /health. Request bodies (which can contain typed text) are never logged.
"""
import asyncio
import base64
import hmac
import os
import uuid

from aiohttp import web

TOKEN_HEADER = "X-Harklet-Token"
MAX_TEXT = 500
MAX_KEYS = 4
MAX_ELEMENTS = 120
ALLOWED_BUTTONS = {"left", "right", "middle"}


async def default_factory():
    from cua_sandbox import Image, Sandbox

    return await Sandbox.create(Image.linux(kind="container"), local=True, runtime="docker")


def _int(body, key, lo, hi):
    v = body.get(key)
    if isinstance(v, bool) or not isinstance(v, int):
        raise ValueError(f"{key} must be an integer")
    if not lo <= v <= hi:
        raise ValueError(f"{key} out of range")
    return v


def _str(body, key, max_len):
    v = body.get(key)
    if not isinstance(v, str) or not v:
        raise ValueError(f"{key} must be a non-empty string")
    if len(v) > max_len:
        raise ValueError(f"{key} too long")
    return v


async def _driver(entry):
    """Connect the Cua Driver once per session and keep the connection open."""
    if entry["driver"] is None:
        cm = entry["sb"].driver.connect()
        entry["driver"] = await cm.__aenter__()
        entry["driver_cm"] = cm
    return entry["driver"]


async def _read_elements(entry):
    from cua_driver._native_contract import GetWindowStateInput, ListWindowsInput

    driver = await _driver(entry)
    listing = await driver.list_windows(ListWindowsInput(pid=None, on_screen_only=True))
    win = next((w for w in listing.windows if w.pid is not None and w.title), None)
    if win is None:
        raise LookupError("no visible window with a title")
    state = await driver.get_window_state(GetWindowStateInput(
        pid=win.pid,
        window_id=win.window_id,
        include_accessibility_tree=True,
        include_screenshot=False,
        max_elements=MAX_ELEMENTS,
        session=None,
        query=None,
        screenshot_out_file=None,
        max_depth=None,
        max_dimension=None,
        max_image_dimension=None,
    ))
    tokens = {}
    items = []
    for el in state.elements or []:
        if not el.element_token:
            continue
        tokens[el.element_index] = el.element_token
        item = {"index": el.element_index, "role": el.role, "label": (el.label or "")[:80]}
        if el.frame is not None:
            item["x"] = round(el.frame.x + el.frame.w / 2)
            item["y"] = round(el.frame.y + el.frame.h / 2)
        items.append(item)
    entry["tokens"] = tokens
    entry["window"] = {"pid": win.pid, "window_id": win.window_id}
    return {"window": {"app": win.app_name, "title": win.title}, "elements": items}


async def _click_element(entry, index):
    from cua_driver._native_contract import (
        ActionTarget, ClickButton, ClickInput, ClickPosition, InputDeliveryMode,
    )

    token = entry["tokens"].get(index)
    win = entry["window"]
    if token is None or win is None:
        raise ValueError("unknown element index; read /elements first")
    driver = await _driver(entry)
    result = await driver.click(ClickInput(
        target=ActionTarget.WINDOW(pid=win["pid"], window_id=win["window_id"]),
        position=ClickPosition.ELEMENT(token),
        delivery_mode=InputDeliveryMode.FOREGROUND,
        session=None,
        button=ClickButton.LEFT,
        count=1,
    ))
    if getattr(result, "error", None) is not None:
        raise RuntimeError("driver click returned an error")


async def _apply(entry, body):
    sb = entry["sb"]
    kind = body.get("type")
    if kind in ("click", "double_click", "right_click", "move"):
        x = _int(body, "x", 0, 10000)
        y = _int(body, "y", 0, 10000)
        if kind == "click":
            button = body.get("button", "left")
            if button not in ALLOWED_BUTTONS:
                raise ValueError("bad button")
            await sb.mouse.click(x, y, button=button)
        elif kind == "double_click":
            await sb.mouse.double_click(x, y)
        elif kind == "right_click":
            await sb.mouse.right_click(x, y)
        else:
            await sb.mouse.move(x, y)
    elif kind == "click_element":
        await _click_element(entry, _int(body, "index", 0, 100000))
    elif kind == "scroll":
        x = _int(body, "x", 0, 10000)
        y = _int(body, "y", 0, 10000)
        dy = _int(body, "dy", -20, 20)
        await sb.mouse.scroll(x, y, scroll_x=0, scroll_y=dy)
    elif kind == "type":
        await sb.keyboard.type(_str(body, "text", MAX_TEXT))
    elif kind == "key":
        keys = body.get("keys")
        if isinstance(keys, str):
            keys = [keys]
        if not isinstance(keys, list) or not 1 <= len(keys) <= MAX_KEYS:
            raise ValueError("keys must be a list of 1-4 names")
        for k in keys:
            if not isinstance(k, str) or not k or len(k) > 20:
                raise ValueError("bad key name")
        await sb.keyboard.keypress(keys)
    elif kind == "wait":
        seconds = body.get("seconds", 1)
        if isinstance(seconds, bool) or not isinstance(seconds, (int, float)):
            raise ValueError("seconds must be a number")
        await asyncio.sleep(min(max(float(seconds), 0.0), 10.0))
    else:
        raise ValueError(f"unknown action type: {kind!r}")


def make_app(token, factory=default_factory):
    sessions = {}

    @web.middleware
    async def auth(request, handler):
        if request.path == "/health":
            return await handler(request)
        got = request.headers.get(TOKEN_HEADER, "")
        if not hmac.compare_digest(got, token):
            return web.json_response({"error": "unauthorized"}, status=401)
        return await handler(request)

    def lookup(request):
        entry = sessions.get(request.match_info["sid"])
        if entry is None:
            raise web.HTTPNotFound(text='{"error": "no such session"}', content_type="application/json")
        return entry

    async def health(_request):
        return web.json_response({"ok": True})

    async def create(_request):
        sb = await factory()
        sid = uuid.uuid4().hex
        width, height = await sb.get_dimensions()
        sessions[sid] = {
            "sb": sb, "lock": asyncio.Lock(), "width": width, "height": height,
            "driver": None, "driver_cm": None, "tokens": {}, "window": None,
        }
        return web.json_response({"id": sid, "width": width, "height": height})

    async def destroy(request):
        entry = sessions.pop(request.match_info["sid"], None)
        if entry is not None:
            cm = entry.get("driver_cm")
            if cm is not None:
                try:
                    await cm.__aexit__(None, None, None)
                except Exception:
                    pass
            try:
                await entry["sb"].destroy()
            except Exception:
                pass
        return web.json_response({"ok": True})

    async def screenshot(request):
        entry = lookup(request)
        async with entry["lock"]:
            png = await entry["sb"].screen.screenshot()
        return web.json_response({
            "png_base64": base64.b64encode(png).decode("ascii"),
            "width": entry["width"],
            "height": entry["height"],
        })

    async def elements(request):
        entry = lookup(request)
        try:
            async with entry["lock"]:
                data = await _read_elements(entry)
        except LookupError as exc:
            return web.json_response({"error": str(exc)}, status=409)
        except Exception as exc:
            # Log only the exception type: messages can echo request data.
            return web.json_response({"error": "element access unavailable (" + type(exc).__name__ + ")"}, status=503)
        return web.json_response(data)

    async def act(request):
        entry = lookup(request)
        try:
            body = await request.json()
        except ValueError:
            return web.json_response({"error": "body must be JSON"}, status=400)
        if not isinstance(body, dict):
            return web.json_response({"error": "body must be an object"}, status=400)
        try:
            async with entry["lock"]:
                await _apply(entry, body)
        except ValueError as exc:
            return web.json_response({"error": str(exc)}, status=400)
        except Exception as exc:
            return web.json_response({"error": "action failed (" + type(exc).__name__ + ")"}, status=502)
        return web.json_response({"ok": True})

    async def viewer(request):
        entry = lookup(request)
        url = await entry["sb"].viewer_url()
        return web.json_response({"url": url})

    app = web.Application(middlewares=[auth], client_max_size=64 * 1024)
    app.router.add_get("/health", health)
    app.router.add_post("/sessions", create)
    app.router.add_delete("/sessions/{sid}", destroy)
    app.router.add_get("/sessions/{sid}/screenshot", screenshot)
    app.router.add_get("/sessions/{sid}/elements", elements)
    app.router.add_post("/sessions/{sid}/actions", act)
    app.router.add_post("/sessions/{sid}/viewer", viewer)
    return app


def main():
    token = os.environ.get("HARKLET_CUA_TOKEN", "")
    if len(token) < 16:
        raise SystemExit("HARKLET_CUA_TOKEN must be set (16+ chars)")
    port = int(os.environ.get("HARKLET_CUA_PORT", "7791"))
    web.run_app(make_app(token), host="127.0.0.1", port=port, access_log=None, print=None)


if __name__ == "__main__":
    main()
