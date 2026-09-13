"""Reusable dynamic Sentinel client for the authorized CTF environment."""

from __future__ import annotations

import json
import uuid
from typing import Any

from curl_cffi import requests

from sentinel_dynamic import (
    PROXY,
    TLS_PROFILE,
    fetch_assets,
    run_call,
    start_runtime,
)


class SentinelClient:
    """Load one live Sentinel SDK and keep its state for several flows."""

    def __init__(
        self,
        page_url: str = "https://auth.openai.com/create-account/password",
        client: requests.Session | None = None,
        screen_width: int = 1920,
        screen_height: int = 1080,
        user_agent: str | None = None,
        browser_identity: dict[str, Any] | None = None,
        node_command: str = "node",
        device_id: str | None = None,
    ) -> None:
        self.page_url = page_url
        self.user_agent = user_agent or (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
        )
        self.browser_identity = browser_identity or {}
        self.client = client or requests.Session(
            impersonate=TLS_PROFILE,
            proxies={"http": PROXY, "https": PROXY},
            verify=False,
        )
        self._owns_client = client is None
        resolved_device_id = device_id or self.client.cookies.get("oai-did") or str(uuid.uuid4())
        self.client.cookies.set("oai-did", resolved_device_id, domain=".openai.com", path="/")
        self.cookies = {"oai-did": resolved_device_id}
        self.assets = fetch_assets(self.client, page_url, self.user_agent)
        self.process, self.input_file = start_runtime(
            self.assets, page_url, self.cookies,
            screen_width=screen_width,
            screen_height=screen_height,
            user_agent=self.user_agent,
            browser_identity=self.browser_identity,
            node_command=node_command,
        )

    def _call(self, method: str, flow: str) -> str:
        result = run_call(
            self.process,
            self.client,
            None,
            self.page_url,
            method,
            flow,
            self.user_agent,
            self.browser_identity,
        )
        errors = result.get("errors") or []
        value = result.get("value")
        if errors:
            raise RuntimeError(f"Sentinel runtime error: {errors[-1]}")
        if not value:
            raise RuntimeError(f"Sentinel returned no value for flow {flow}")
        return value

    def token(self, flow: str) -> str:
        """Return the exact value for the OpenAI-Sentinel-Token header."""

        value = self._call("token", flow)
        parsed = json.loads(value)
        required = {"p", "t", "c", "id", "flow"}
        if not required.issubset(parsed):
            raise RuntimeError(f"Incomplete Sentinel token keys: {sorted(parsed)}")
        return value

    def session_observer_token(self, flow: str) -> str:
        """Return the exact value for the OpenAI-Sentinel-SO-Token header."""

        value = self._call("sessionObserverToken", flow)
        parsed = json.loads(value)
        required = {"so", "c", "id", "flow"}
        if not required.issubset(parsed):
            raise RuntimeError(f"Incomplete Sentinel SO token keys: {sorted(parsed)}")
        return value

    def headers(self, flow: str, include_session_observer: bool = False) -> dict[str, str]:
        headers = {"OpenAI-Sentinel-Token": self.token(flow)}
        if include_session_observer:
            headers["OpenAI-Sentinel-SO-Token"] = self.session_observer_token(flow)
        return headers

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                assert self.process.stdin is not None
                self.process.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
                self.process.stdin.flush()
                self.process.wait(timeout=2)
            except Exception:
                self.process.kill()
                self.process.wait()
        self.input_file.close()
        if self._owns_client:
            self.client.close()

    def __enter__(self) -> "SentinelClient":
        return self

    def __exit__(self, _type: Any, _value: Any, _traceback: Any) -> None:
        self.close()
