import unittest
from types import SimpleNamespace

from aiohttp.test_utils import TestClient, TestServer
from cua_driver._native_contract import ClickInput

from server import TOKEN_HEADER, make_app

TOKEN = "t" * 20


class FakeDriver:
    def __init__(self, click_error=None):
        self.clicks = []
        self.click_error = click_error

    async def list_windows(self, _inp):
        return SimpleNamespace(windows=[
            SimpleNamespace(pid=None, window_id=1, app_name="Desktop", title=""),
            SimpleNamespace(pid=42, window_id=7, app_name="Editor", title="Login"),
        ])

    async def get_window_state(self, inp):
        assert (inp.pid, inp.window_id) == (42, 7)
        return SimpleNamespace(elements=[
            SimpleNamespace(element_index=0, role="AXButton", label="Sign in", element_token="tok-0",
                            frame=SimpleNamespace(x=10, y=20, w=100, h=30)),
            SimpleNamespace(element_index=1, role="AXTextField", label="Email", element_token=None, frame=None),
            SimpleNamespace(element_index=2, role="AXTextField", label="Password", element_token="tok-2", frame=None),
        ])

    async def click(self, inp):
        self.clicks.append(inp)
        if self.click_error:
            return SimpleNamespace(error=self.click_error)
        return SimpleNamespace(error=None)


class FakeConnect:
    def __init__(self, driver, error):
        self.driver = driver
        self.error = error

    async def __aenter__(self):
        if self.error:
            raise self.error
        return self.driver

    async def __aexit__(self, *exc):
        return False


async def _shot():
    return b"png"


class FakeSandbox:
    def __init__(self, driver=None, connect_error=None):
        self.driver_obj = driver
        self.connect_error = connect_error
        self.driver = SimpleNamespace(connect=lambda: FakeConnect(self.driver_obj, self.connect_error))
        self.mouse = SimpleNamespace()
        self.keyboard = SimpleNamespace()
        self.screen = SimpleNamespace(screenshot=_shot)

    async def get_dimensions(self):
        return (1280, 800)

    async def destroy(self):
        pass


class ElementsTest(unittest.IsolatedAsyncioTestCase):
    async def start(self, sb):
        async def factory():
            return sb
        self.client = TestClient(TestServer(make_app(TOKEN, factory)))
        await self.client.start_server()
        r = await self.client.post("/sessions", headers={TOKEN_HEADER: TOKEN})
        return (await r.json())["id"]

    async def asyncTearDown(self):
        if hasattr(self, "client"):
            await self.client.close()

    def h(self):
        return {TOKEN_HEADER: TOKEN}

    async def test_lists_only_elements_with_tokens(self):
        sid = await self.start(FakeSandbox(FakeDriver()))
        r = await self.client.get(f"/sessions/{sid}/elements", headers=self.h())
        self.assertEqual(r.status, 200)
        body = await r.json()
        self.assertEqual(body["window"], {"app": "Editor", "title": "Login"})
        self.assertEqual([e["index"] for e in body["elements"]], [0, 2])
        self.assertEqual(body["elements"][0]["x"], 60)
        self.assertNotIn("tok-0", str(body))

    async def test_click_element_sends_element_token(self):
        driver = FakeDriver()
        sid = await self.start(FakeSandbox(driver))
        await self.client.get(f"/sessions/{sid}/elements", headers=self.h())
        r = await self.client.post(f"/sessions/{sid}/actions", headers=self.h(), json={"type": "click_element", "index": 2})
        self.assertEqual(r.status, 200)
        self.assertEqual(len(driver.clicks), 1)
        inp = driver.clicks[0]
        self.assertIsInstance(inp, ClickInput)
        self.assertEqual(inp.position.element_token, "tok-2")
        self.assertEqual((inp.target.pid, inp.target.window_id), (42, 7))

    async def test_click_element_needs_a_fresh_listing(self):
        driver = FakeDriver()
        sid = await self.start(FakeSandbox(driver))
        r = await self.client.post(f"/sessions/{sid}/actions", headers=self.h(), json={"type": "click_element", "index": 0})
        self.assertEqual(r.status, 400)
        await self.client.get(f"/sessions/{sid}/elements", headers=self.h())
        r = await self.client.post(f"/sessions/{sid}/actions", headers=self.h(), json={"type": "click_element", "index": 1})
        self.assertEqual(r.status, 400)
        self.assertEqual(driver.clicks, [])

    async def test_driver_unavailable_is_503_without_details(self):
        sid = await self.start(FakeSandbox(connect_error=RuntimeError("secret detail")))
        r = await self.client.get(f"/sessions/{sid}/elements", headers=self.h())
        self.assertEqual(r.status, 503)
        text = await r.text()
        self.assertNotIn("secret detail", text)
        r = await self.client.get(f"/sessions/{sid}/screenshot", headers=self.h())
        self.assertEqual(r.status, 200)

    async def test_failed_driver_click_is_502(self):
        sid = await self.start(FakeSandbox(FakeDriver(click_error="denied")))
        await self.client.get(f"/sessions/{sid}/elements", headers=self.h())
        r = await self.client.post(f"/sessions/{sid}/actions", headers=self.h(), json={"type": "click_element", "index": 0})
        self.assertEqual(r.status, 502)


if __name__ == "__main__":
    unittest.main()
