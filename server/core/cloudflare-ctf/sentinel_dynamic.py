#!/usr/bin/env python3
"""Run the current Sentinel SDK in the local JavaScript runtime.

This probe intentionally handles only token generation. It does not submit
account credentials or automate account creation.
"""

from __future__ import annotations

import argparse
import json
import re
import selectors
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from curl_cffi import requests

BASE_DIR = Path(__file__).resolve().parent
RUNTIME = BASE_DIR / "sentinel_runtime.cjs"
PROXY = "http://127.0.0.1:8080"
TLS_PROFILE = "chrome145"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
)
SENTINEL_LOADER = "https://sentinel.openai.com/backend-api/sentinel/sdk.js"


def session() -> requests.Session:
    return requests.Session(
        impersonate=TLS_PROFILE,
        proxies={"http": PROXY, "https": PROXY},
        verify=False,
    )


def request_headers(
    source_url: str,
    target_url: str,
    supplied: dict[str, Any] | None = None,
    user_agent: str = USER_AGENT,
    browser_identity: dict[str, Any] | None = None,
) -> dict[str, str]:
    identity = browser_identity or {}
    source = urlparse(source_url)
    target = urlparse(target_url)
    source_origin = f"{source.scheme}://{source.netloc}"
    target_origin = f"{target.scheme}://{target.netloc}"
    headers = {str(k): str(v) for k, v in (supplied or {}).items()}
    headers.setdefault("user-agent", user_agent)
    headers.setdefault("accept-language", str(identity.get("acceptLanguage") or "zh-CN,zh;q=0.9,en;q=0.8"))
    if identity.get("secChUa"):
        headers.setdefault("sec-ch-ua", str(identity["secChUa"]))
    if identity.get("secChUaMobile"):
        headers.setdefault("sec-ch-ua-mobile", str(identity["secChUaMobile"]))
    if identity.get("secChUaPlatform"):
        headers.setdefault("sec-ch-ua-platform", str(identity["secChUaPlatform"]))
    headers.setdefault("referer", source_url)
    headers.setdefault("accept", "*/*")
    headers.setdefault("sec-fetch-site", "same-origin" if source_origin == target_origin else "cross-site")
    headers.setdefault("sec-fetch-mode", "cors")
    headers.setdefault("sec-fetch-dest", "empty")
    if source_origin == target_origin and target.path.endswith("/req"):
        headers.setdefault("origin", target_origin)
        headers.setdefault("content-type", "text/plain;charset=UTF-8")
    return headers


def fetch_assets(client: requests.Session, page_url: str, user_agent: str = USER_AGENT) -> dict[str, str]:
    loader_response = client.get(
        SENTINEL_LOADER,
        headers={
            "user-agent": user_agent,
            "accept": "*/*",
            "referer": page_url,
            "sec-fetch-dest": "script",
            "sec-fetch-mode": "no-cors",
            "sec-fetch-site": "cross-site",
        },
        timeout=30,
    )
    loader_source = loader_response.text
    if loader_response.status_code != 200:
        raise RuntimeError(f"Sentinel loader HTTP {loader_response.status_code}")
    match = re.search(r"https://sentinel\.openai\.com/sentinel/[^\"']+/sdk\.js", loader_source)
    if not match:
        raise RuntimeError("Sentinel loader did not expose a versioned SDK URL")
    sdk_url = match.group(0)
    sdk_response = client.get(
        sdk_url,
        headers={
            "user-agent": user_agent,
            "accept": "*/*",
            "referer": SENTINEL_LOADER,
            "sec-fetch-dest": "script",
            "sec-fetch-mode": "no-cors",
            "sec-fetch-site": "same-origin",
        },
        timeout=30,
    )
    if sdk_response.status_code != 200:
        raise RuntimeError(f"Sentinel SDK HTTP {sdk_response.status_code}")
    return {
        "loaderUrl": SENTINEL_LOADER,
        "loaderSource": loader_source,
        "sdkUrl": sdk_url,
        "sdkSource": sdk_response.text,
    }


def cookie_from_header(header: str, name: str) -> str | None:
    for item in header.split(";"):
        key, separator, value = item.strip().partition("=")
        if separator and key == name:
            return value
    return None


def assets_from_har(path: Path) -> tuple[dict[str, str], dict[str, Any], dict[str, str]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    entries = data["log"]["entries"]
    loader = next(
        entry for entry in entries
        if entry["request"]["url"] == SENTINEL_LOADER and entry["response"]["status"] == 200
    )
    sdk = next(
        entry for entry in entries
        if re.search(r"https://sentinel\.openai\.com/sentinel/[^/]+/sdk\.js$", entry["request"]["url"])
        and entry["response"]["status"] == 200
        and entry["response"]["content"].get("text")
    )
    response = next(
        entry for entry in entries
        if entry["request"]["url"] == "https://sentinel.openai.com/backend-api/sentinel/req"
        and entry["response"]["status"] == 200
        and entry["response"]["content"].get("text")
    )
    page_entry = next(
        entry for entry in entries
        if entry["request"]["url"] == "https://auth.openai.com/create-account/password"
    )
    page_cookie_header = ";".join(
        header["value"] for header in page_entry["request"].get("headers", [])
        if header["name"].lower() == "cookie"
    )
    device_id = cookie_from_header(page_cookie_header, "oai-did")
    return (
        {
            "loaderUrl": SENTINEL_LOADER,
            "loaderSource": loader["response"]["content"]["text"],
            "sdkUrl": sdk["request"]["url"],
            "sdkSource": sdk["response"]["content"]["text"],
        },
        {
            "body": response["response"]["content"]["text"],
            "headers": {
                header["name"]: header["value"]
                for header in response["response"].get("headers", [])
                if not header["name"].startswith(":")
            },
            "url": response["request"]["url"],
            "status": response["response"]["status"],
        },
        {"oai-did": device_id} if device_id else {},
    )


def start_runtime(
    assets: dict[str, str],
    page_url: str,
    cookies: dict[str, str] | None = None,
    debug: bool = False,
    screen_width: int = 1920,
    screen_height: int = 1080,
    user_agent: str = USER_AGENT,
    browser_identity: dict[str, Any] | None = None,
    node_command: str = "node",
) -> tuple[subprocess.Popen[str], tempfile.NamedTemporaryFile[str]]:
    identity = browser_identity or {}
    runtime_input = {
        "url": page_url,
        "html": "<!doctype html><html><head></head><body></body></html>",
        "userAgent": user_agent,
        "platform": identity.get("platform") or "MacIntel",
        "language": identity.get("locale") or "zh-CN",
        "languages": identity.get("languages") or ["zh-CN", "zh"],
        "cookies": cookies or {},
        "debug": debug,
        "screenWidth": screen_width,
        "screenHeight": screen_height,
        **assets,
    }
    input_file = tempfile.NamedTemporaryFile(mode="w", suffix=".json")
    json.dump(runtime_input, input_file)
    input_file.flush()
    process = subprocess.Popen(
        [node_command, str(RUNTIME), input_file.name],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=None,
        text=True,
        bufsize=1,
    )
    return process, input_file


def send(process: subprocess.Popen[str], message: dict[str, Any]) -> None:
    assert process.stdin is not None
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()


def run_call(
    process: subprocess.Popen[str],
    client: requests.Session | None,
    replay_response: dict[str, Any] | None,
    page_url: str,
    method: str,
    flow: str,
    user_agent: str = USER_AGENT,
    browser_identity: dict[str, Any] | None = None,
) -> dict[str, Any]:
    send(process, {"type": "call", "method": method, "flow": flow})
    assert process.stdout is not None
    network_responses: list[dict[str, Any]] = []
    while True:
        line = process.stdout.readline()
        if not line:
            stderr = process.stderr.read() if process.stderr else ""
            raise RuntimeError(f"Sentinel runtime exited unexpectedly: {stderr[-1000:]}")
        message = json.loads(line)
        if message.get("type") == "request":
            request = message["request"]
            is_req = urlparse(request["url"]).path.endswith("/backend-api/sentinel/req")
            if replay_response is not None and is_req:
                reply = replay_response
            elif replay_response is not None:
                reply = {
                    "status": 200,
                    "url": request["url"],
                    "headers": {"content-type": "text/plain"},
                    "body": "",
                }
            else:
                assert client is not None
                response = client.request(
                    request["method"],
                    request["url"],
                    headers=request_headers(
                        request.get("sourceUrl", page_url),
                        request["url"],
                        request.get("headers"),
                        user_agent,
                        browser_identity,
                    ),
                    data=request.get("body") if request["method"] != "GET" else None,
                    timeout=45,
                    allow_redirects=False,
                )
                reply = {
                    "status": response.status_code,
                    "url": response.url,
                    "headers": dict(response.headers),
                    "body": response.text,
                }
            send(process, {
                "id": request["id"],
                "status": reply["status"],
                "url": reply.get("url", request["url"]),
                "headers": reply.get("headers", {}),
                "body": reply.get("body", ""),
            })
            network_responses.append({
                "method": request["method"],
                "url": request["url"],
                "status": reply["status"],
                "responseBodyLength": len(reply.get("body", "")),
            })
            continue
        if message.get("type") == "result":
            message["networkResponses"] = network_responses
            return message


def safe_value_summary(value: str | None) -> dict[str, Any]:
    if not value:
        return {"present": False}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {"present": True, "length": len(value), "json": False}
    return {
        "present": True,
        "length": len(value),
        "json": True,
        "keys": sorted(parsed) if isinstance(parsed, dict) else [],
        "flow": parsed.get("flow") if isinstance(parsed, dict) else None,
        "id_present": bool(parsed.get("id")) if isinstance(parsed, dict) else False,
        "error": (parsed.get("e") or "")[:240] if isinstance(parsed, dict) else "",
        "error_present": bool(parsed.get("e")) if isinstance(parsed, dict) else False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run dynamic Sentinel SDK locally")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--har", type=Path, help="use Sentinel scripts and response from a HAR")
    source.add_argument("--online", action="store_true", help="download the current Sentinel SDK")
    parser.add_argument("--page-url", default="https://auth.openai.com/create-account/password")
    parser.add_argument("--flow", default="username_password_create")
    parser.add_argument("--method", choices=["token", "sessionObserverToken"], default="token")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--screen-width", type=int, default=1920)
    parser.add_argument("--screen-height", type=int, default=1080)
    args = parser.parse_args()

    client = session()
    process: subprocess.Popen[str] | None = None
    input_file: tempfile.NamedTemporaryFile[str] | None = None
    try:
        replay_response = None
        if args.har:
            assets, replay_response, cookies = assets_from_har(args.har)
        else:
            assets = fetch_assets(client, args.page_url)
            device_id = client.cookies.get("oai-did") or str(uuid.uuid4())
            client.cookies.set("oai-did", device_id, domain=".openai.com", path="/")
            cookies = {"oai-did": device_id}
        process, input_file = start_runtime(
            assets, args.page_url, cookies, args.debug,
            args.screen_width, args.screen_height,
        )
        result = run_call(process, None if replay_response else client, replay_response, args.page_url, args.method, args.flow)
        output = {
            "ok": bool(result.get("value"))
            and not result.get("errors")
            and not safe_value_summary(result.get("value")).get("error_present"),
            "sdk_url": assets["sdkUrl"],
            "method": args.method,
            "flow": args.flow,
            "value": safe_value_summary(result.get("value")),
            "request_count": result.get("requests"),
            "request_summaries": result.get("requestSummaries", []),
            "network_responses": result.get("networkResponses", []),
            "frame_created": result.get("frameCreated"),
            "environment": result.get("environment", {}),
            "runtime_errors": len(result.get("errors") or []),
            "runtime_error_messages": (result.get("errors") or [])[-3:],
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return 0 if output["ok"] else 1
    finally:
        if process is not None and process.poll() is None:
            try:
                send(process, {"type": "shutdown"})
                process.wait(timeout=2)
            except Exception:
                process.kill()
                process.wait()
        if input_file is not None:
            input_file.close()
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
