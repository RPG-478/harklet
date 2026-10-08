import unittest

from aiohttp.test_utils import TestClient, TestServer

from server import TOKEN_HEADER, make_app

TOKEN = "t" * 20


class FakeMouse:
    def __init__(self):
        self.calls = []

    async def click(self, x, y, button="left"):
        self.calls.append(("click", x, y, button))

    async def double_click(self, x, y):
        self.calls.append(("double_click", x, y))

    async def right_click(self, x, y):
        self.calls.append(("right_click", x, y))

    async def move(self, x, y):
        self.calls.append(("move", x, y))

    async def scroll(self, x, y, scroll_x=0, scroll_y=0):
        self.calls.append(("scroll", x, y, scroll_y))


class FakeKeyboard:
    def __init__(self):
        self.calls = []

    async def type(self, text):
        self.calls.append(("type", text))

    async def keypress(self, keys):
        self.calls.append(("keypress", keys))


class FakeScreen:
    async def screenshot(self):
        return b"\x89PNG-fake"


class FakeSandbox:
    def __init__(self):
        self.mouse = FakeMouse()
        self.keyboard = FakeKeyboard()
        self.screen = FakeScreen()
        self.destroyed = False

    async def get_dimensions(self):
        return (1280, 800)

    async def viewer_url(self):
        return "http://127.0.0.1:9/viewer?ticket=x"

    async def destroy(self):
        self.destroyed = True


class BridgeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.sb = FakeSandbox()

        async def factory():
            return self.sb

        self.client = TestClient(TestServer(make_app(TOKEN, factory)))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()

    def headers(self):
        return {TOKEN_HEADER: TOKEN}

    async def new_session(self):
        r = await self.client.post("/sessions", headers=self.headers())
        self.assertEqual(r.status, 200)
        return (await r.json())["id"]

    async def test_rejects_missing_token(self):
        r = await self.client.post("/sessions")
        self.assertEqual(r.status, 401)

    async def test_health_needs_no_token(self):
        r = await self.client.get("/health")
        self.assertEqual(r.status, 200)

    async def test_create_reports_size(self):
        r = await self.client.post("/sessions", headers=self.headers())
        body = await r.json()
        self.assertEqual((body["width"], body["height"]), (1280, 800))

    async def test_click_and_type_reach_sandbox(self):
        sid = await self.new_session()
        r = await self.client.post(f"/sessions/{sid}/actions", headers=self.headers(),
                                   json={"type": "click", "x": 10, "y": 20})
        self.assertEqual(r.status, 200)
        r = await self.client.post(f"/sessions/{sid}/actions", headers=self.headers(),
                                   json={"type": "type", "text": "hello"})
        self.assertEqual(r.status, 200)
        self.assertEqual(self.sb.mouse.calls, [("click", 10, 20, "left")])
        self.assertEqual(self.sb.keyboard.calls, [("type", "hello")])

    async def test_rejects_bad_input(self):
        sid = await self.new_session()
        bad = [
            {"type": "click", "x": True, "y": 1},
            {"type": "click", "x": -1, "y": 1},
            {"type": "shell", "cmd": "rm -rf /"},
            {"type": "type", "text": ""},
            {"type": "key", "keys": ["a"] * 9},
        ]
        for body in bad:
            r = await self.client.post(f"/sessions/{sid}/actions", headers=self.headers(), json=body)
            self.assertEqual(r.status, 400, body)
        self.assertEqual(self.sb.mouse.calls, [])
        self.assertEqual(self.sb.keyboard.calls, [])

    async def test_screenshot_returns_png_base64(self):
        sid = await self.new_session()
        r = await self.client.get(f"/sessions/{sid}/screenshot", headers=self.headers())
        body = await r.json()
        self.assertTrue(body["png_base64"])
        self.assertEqual((body["width"], body["height"]), (1280, 800))

    async def test_unknown_session_is_404(self):
        r = await self.client.get("/sessions/nope/screenshot", headers=self.headers())
        self.assertEqual(r.status, 404)

    async def test_destroy_removes_session(self):
        sid = await self.new_session()
        r = await self.client.delete(f"/sessions/{sid}", headers=self.headers())
        self.assertEqual(r.status, 200)
        self.assertTrue(self.sb.destroyed)
        r = await self.client.get(f"/sessions/{sid}/screenshot", headers=self.headers())
        self.assertEqual(r.status, 404)

    async def test_viewer_returns_url(self):
        sid = await self.new_session()
        r = await self.client.post(f"/sessions/{sid}/viewer", headers=self.headers())
        self.assertIn("viewer", (await r.json())["url"])


if __name__ == "__main__":
    unittest.main()
