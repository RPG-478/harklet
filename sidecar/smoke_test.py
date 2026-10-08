"""Manual smoke test for the real Docker guest. Not run by unittest.

Usage (Docker running):
    python smoke_test.py             # screenshot, window list, element list
    python smoke_test.py --click 3   # also click element index 3 from that list

It writes the screenshot to the temp folder and destroys the sandbox at the end.
"""
import argparse
import asyncio
import os
import tempfile

from server import _click_element, _read_elements, default_factory


async def main(click_index):
    sb = await default_factory()
    entry = {
        "sb": sb, "lock": asyncio.Lock(), "width": 0, "height": 0,
        "driver": None, "driver_cm": None, "tokens": {}, "window": None,
    }
    try:
        width, height = await sb.get_dimensions()
        png = await sb.screen.screenshot()
        out = os.path.join(tempfile.gettempdir(), "harklet-smoke.png")
        with open(out, "wb") as f:
            f.write(png)
        print(f"screen {width}x{height}, screenshot {len(png)} bytes -> {out}")

        try:
            data = await _read_elements(entry)
        except Exception as exc:
            print("element listing failed:", type(exc).__name__, str(exc)[:300])
            return
        print("window:", data["window"])
        print(f"{len(data['elements'])} elements with tokens")
        for el in data["elements"][:30]:
            print("  ", el)

        if click_index is not None:
            await _click_element(entry, click_index)
            print(f"clicked element {click_index}; check the screenshot for the result")
    finally:
        cm = entry.get("driver_cm")
        if cm is not None:
            await cm.__aexit__(None, None, None)
        await sb.destroy()
        print("sandbox destroyed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--click", type=int, default=None, help="element index to click")
    args = parser.parse_args()
    asyncio.run(main(args.click))
