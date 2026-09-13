#!/usr/bin/env python3
"""Small NDJSON bridge around curl_cffi for browser-like TLS requests."""

import base64
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
from pathlib import Path
import re
import sys
from typing import get_args
from urllib.parse import urljoin, urlparse

try:
    from curl_cffi import requests
    from curl_cffi.requests.impersonate import BrowserTypeLiteral
    IMPORT_ERROR = None
except Exception as error:  # pragma: no cover - exercised on missing local dependency
    requests = None
    BrowserTypeLiteral = None
    IMPORT_ERROR = f"{type(error).__name__}: {error}"


# The Cloudflare challenge solver and the dynamic Sentinel client live in
# cloudflare-ctf/. Both are loaded lazily and treated as optional: if they are
# missing the plain request path keeps working and only the two operations below
# report a descriptive error instead of taking the whole worker down at import.
SOLVER_DIR = Path(__file__).resolve().parent / "cloudflare-ctf"
SOLVER_PATH = SOLVER_DIR / "cloudflare_solver.py"
CLOUDFLARE_SOLVER = None
SentinelClient = None
SOLVER_IMPORT_ERROR = None
if IMPORT_ERROR is None:
    try:
        if str(SOLVER_DIR) not in sys.path:
            sys.path.insert(0, str(SOLVER_DIR))
        from sentinel_client import SentinelClient  # noqa: E402

        SOLVER_SPEC = importlib.util.spec_from_file_location("tosub2_cloudflare_solver", SOLVER_PATH)
        if SOLVER_SPEC is not None and SOLVER_SPEC.loader is not None:
            CLOUDFLARE_SOLVER = importlib.util.module_from_spec(SOLVER_SPEC)
            SOLVER_SPEC.loader.exec_module(CLOUDFLARE_SOLVER)
        else:  # pragma: no cover - installation corruption
            SOLVER_IMPORT_ERROR = f"solver entry point missing: {SOLVER_PATH}"
    except Exception as error:  # pragma: no cover - exercised on missing optional module
        CLOUDFLARE_SOLVER = None
        SentinelClient = None
        SOLVER_IMPORT_ERROR = f"{type(error).__name__}: {error}"


def write_message(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


class Worker:
    def __init__(self):
        self.session = None
        self.proxy = None
        self.impersonate = "chrome146"
        self.verify_tls = True
        self.sentinel_client = None
        self.fallback_profiles = ("chrome146", "chrome145", "chrome142", "chrome136")

    def configure(self, proxy, impersonate, allow_fallback=True, verify_tls=True):
        if IMPORT_ERROR:
            raise RuntimeError(
                "Python curl_cffi is unavailable. Run: python -m pip install -r requirements.txt "
                f"({IMPORT_ERROR})"
            )
        self.close_sentinel()
        if self.session is not None:
            self.session.close()
            self.session = None
        self.proxy = proxy or None
        self.verify_tls = bool(verify_tls)
        requested_profile = impersonate or "chrome146"
        profiles = [requested_profile]
        if allow_fallback:
            profiles.extend(
                profile for profile in self.fallback_profiles if profile != requested_profile
            )

        last_error = None
        for profile in profiles:
            try:
                session_options = {"impersonate": profile}
                if self._uses_local_http_proxy():
                    # curl_cffi needs the explicit mapping form for local HTTP proxies.
                    session_options["proxies"] = {
                        "http": self.proxy,
                        "https": self.proxy,
                    }
                else:
                    session_options["proxy"] = self.proxy
                if not self.verify_tls:
                    session_options["verify"] = False
                self.session = requests.Session(**session_options)
                self.impersonate = profile
                if profile != requested_profile:
                    sys.stderr.write(
                        f"[tls] 指纹 {requested_profile} 不受当前 curl_cffi 支持，已降级为 {profile}\n"
                    )
                return
            except Exception as error:
                last_error = error
                self.session = None
                if not self._is_unsupported_impersonate(error):
                    raise
        raise last_error

    def _uses_local_http_proxy(self):
        if not self.proxy:
            return False
        parsed = urlparse(self.proxy)
        hostname = (parsed.hostname or "").lower()
        return parsed.scheme == "http" and hostname in {"localhost", "127.0.0.1", "::1"}

    def probe_profiles(self, url, profiles=None, timeout_ms=15000, concurrency=4):
        if IMPORT_ERROR:
            raise RuntimeError(
                "Python curl_cffi is unavailable. Run: python -m pip install -r requirements.txt "
                f"({IMPORT_ERROR})"
            )
        candidates = profiles or self._supported_chrome_profiles()
        if not candidates:
            raise RuntimeError("No desktop Chrome fingerprints are available in the installed curl_cffi")

        if self.session is not None:
            self.session.close()
        self.session = None
        failures = []
        attempts = 0
        batch_size = max(1, min(4, int(concurrency or 4)))
        for offset in range(0, len(candidates), batch_size):
            batch = candidates[offset:offset + batch_size]
            with ThreadPoolExecutor(max_workers=len(batch)) as executor:
                results = list(executor.map(
                    lambda profile: self._probe_profile(profile, url, timeout_ms),
                    batch,
                ))
            attempts += len(batch)

            selected_index = next(
                (index for index, result in enumerate(results) if result[1] is not None),
                None,
            )
            if selected_index is not None:
                selected_profile = batch[selected_index]
                selected_session = results[selected_index][0]
                for index, (session, _, _) in enumerate(results):
                    if index != selected_index and session is not None:
                        session.close()
                self.session = selected_session
                self.proxy = None
                self.impersonate = selected_profile
                return {"profile": selected_profile, "attempts": attempts}

            for profile, (session, _, failure) in zip(batch, results):
                if session is not None:
                    session.close()
                failures.append(f"{profile}={failure}")

        summary = ", ".join(failures[-8:])
        raise RuntimeError(
            "No supported desktop Chrome fingerprint reached ChatGPT without a security-check page"
            + (f": {summary}" if summary else "")
        )

    @classmethod
    def _probe_profile(cls, profile, url, timeout_ms):
        session = None
        try:
            session = requests.Session(impersonate=profile, proxy=None)
            response = session.get(
                url,
                timeout=max(1, int(timeout_ms)) / 1000,
                allow_redirects=False,
            )
            if cls._is_usable_probe_response(response, url):
                return session, response, None
            return session, None, f"HTTP {int(response.status_code)}"
        except Exception as error:
            return session, None, type(error).__name__

    @staticmethod
    def _supported_chrome_profiles():
        values = get_args(BrowserTypeLiteral) if BrowserTypeLiteral is not None else ()
        profiles = {
            value for value in values
            if isinstance(value, str) and re.fullmatch(r"chrome\d+[a-z]?", value)
        }

        def sort_key(profile):
            match = re.fullmatch(r"chrome(\d+)([a-z]?)", profile)
            return (int(match.group(1)), match.group(2))

        return sorted(profiles, key=sort_key, reverse=True)

    @staticmethod
    def _is_usable_probe_response(response, request_url="https://chatgpt.com/"):
        status = int(response.status_code)
        headers = {str(name).lower(): str(value) for name, value in response.headers.items()}
        if not 200 <= status < 400:
            return False
        if "challenge" in (headers.get("cf-mitigated") or headers.get("x-cf-mitigated") or "").lower():
            return False
        if 300 <= status < 400:
            location = headers.get("location") or ""
            if not location:
                return False
            target = urlparse(urljoin(request_url, location))
            source = urlparse(request_url)
            if target.hostname != source.hostname:
                return False
            if re.search(r"cdn-cgi|challenge|captcha|security-check|verify", target.path + "?" + target.query, re.I):
                return False
        body = bytes(response.content or b"")[:200000].decode("utf-8", errors="ignore")
        return re.search(r"Just a moment|cdn-cgi|challenge-platform|cf-challenge", body, re.I) is None

    @staticmethod
    def _is_unsupported_impersonate(error):
        message = str(error or "")
        return "impersonat" in message.lower() and "not supported" in message.lower()

    def _request_with_profile_fallback(self, method, url, headers, body_bytes, timeout_ms):
        try:
            return self.session.request(
                method,
                url,
                headers=headers,
                data=body_bytes,
                timeout=timeout_ms / 1000,
                allow_redirects=False,
            )
        except Exception as error:
            if not self._is_unsupported_impersonate(error):
                raise

            original_profile = self.impersonate
            last_error = error
            for profile in self.fallback_profiles:
                if profile == original_profile:
                    continue
                try:
                    self.configure(self.proxy, profile, allow_fallback=False, verify_tls=self.verify_tls)
                    response = self.session.request(
                        method,
                        url,
                        headers=headers,
                        data=body_bytes,
                        timeout=timeout_ms / 1000,
                        allow_redirects=False,
                    )
                    sys.stderr.write(
                        f"[tls] 指纹 {original_profile} 不受当前 curl_cffi 支持，已降级为 {profile}\n"
                    )
                    return response
                except Exception as fallback_error:
                    last_error = fallback_error
                    if not self._is_unsupported_impersonate(fallback_error):
                        raise
            raise last_error

    def request(self, message):
        if self.session is None:
            self.configure(message.get("proxy"), message.get("impersonate"))

        method = str(message.get("method") or "GET").upper()
        url = str(message.get("url") or "")
        headers = {}
        for pair in message.get("headers") or []:
            if isinstance(pair, list) and len(pair) == 2:
                headers[str(pair[0])] = str(pair[1])

        body = message.get("body")
        body_bytes = base64.b64decode(body) if body else None
        timeout_ms = max(1, int(message.get("timeoutMs") or 30000))
        response = self._request_with_profile_fallback(
            method, url, headers, body_bytes, timeout_ms
        )
        header_items = list(response.headers.multi_items()) if hasattr(response.headers, "multi_items") else list(response.headers.items())
        cookies = []
        cookie_jar = getattr(self.session.cookies, "jar", None)
        if cookie_jar is not None:
            for cookie in cookie_jar:
                cookies.append({
                    "name": cookie.name,
                    "value": cookie.value,
                    "domain": cookie.domain.lstrip("."),
                    "path": cookie.path or "/",
                    "secure": bool(cookie.secure),
                    # JavaScript Date.now() and the Node cookie jar use milliseconds.
                    "expires": cookie.expires * 1000 if cookie.expires else None,
                })
        return {
            "status": int(response.status_code),
            "headers": [[str(name), str(value)] for name, value in header_items],
            "body": "" if message.get("discardBody") else base64.b64encode(response.content).decode("ascii"),
            "cookies": cookies,
        }

    def solve_cloudflare(self, message):
        if self.session is None:
            raise RuntimeError("TLS session must be configured before solving Cloudflare")
        if CLOUDFLARE_SOLVER is None:
            raise RuntimeError(
                "Cloudflare solver module could not be loaded"
                + (f" ({SOLVER_IMPORT_ERROR})" if SOLVER_IMPORT_ERROR else "")
            )
        challenge_body = message.get("challengeBody") or ""
        challenge_html = base64.b64decode(challenge_body).decode("utf-8", errors="ignore")
        challenge_url = str(message.get("url") or "")
        parsed = urlparse(challenge_url)
        verification_url = f"{parsed.scheme}://{parsed.netloc}/"
        return CLOUDFLARE_SOLVER.solve_challenge(
            self.session,
            challenge_url=challenge_url,
            challenge_html=challenge_html,
            challenge_size=len(challenge_html.encode("utf-8")),
            user_agent=str(message.get("userAgent") or "Mozilla/5.0"),
            browser_identity=message.get("browserIdentity") or {},
            verification_url=verification_url,
            node_command=str(message.get("nodeCommand") or "node"),
            timeout_seconds=max(10, int(message.get("solverTimeoutMs") or 70000) // 1000),
        )

    def generate_sentinel_tokens(self, message):
        if self.session is None:
            raise RuntimeError("TLS session must be configured before generating Sentinel tokens")
        if SentinelClient is None:
            raise RuntimeError(
                "Dynamic Sentinel client could not be loaded"
                + (f" ({SOLVER_IMPORT_ERROR})" if SOLVER_IMPORT_ERROR else "")
            )
        identity = message.get("browserIdentity") or {}
        user_agent = str(message.get("userAgent") or identity.get("userAgent") or "Mozilla/5.0")
        page_url = str(message.get("pageUrl") or "https://auth.openai.com/create-account/password")
        device_id = str(message.get("deviceID") or "") or None
        sentinel = SentinelClient(
            page_url=page_url,
            client=self.session,
            user_agent=user_agent,
            browser_identity=identity,
            node_command=str(message.get("nodeCommand") or "node"),
            device_id=device_id,
        )
        try:
            flow = str(message.get("flow") or "default")
            token = sentinel.token(flow)
            so_token = None
            if message.get("includeSessionObserver", True):
                try:
                    so_token = sentinel.session_observer_token(flow)
                except RuntimeError as error:
                    # The Session Observer collector is optional; a token without
                    # it is still accepted by the account endpoints.
                    if "returned no value" not in str(error):
                        raise
            return {"token": token, "soToken": so_token}
        finally:
            sentinel.close()

    def close_sentinel(self):
        if self.sentinel_client is None:
            return
        self.sentinel_client.close()
        self.sentinel_client = None


def main():
    worker = Worker()
    for raw_line in sys.stdin:
        try:
            message = json.loads(raw_line)
            request_id = message.get("id")
            operation = message.get("operation", "request")
            if operation == "configure":
                worker.configure(
                    message.get("proxy"),
                    message.get("impersonate"),
                    verify_tls=message.get("verifyTls", True),
                )
                result = {
                    "configured": True,
                    "profile": worker.impersonate,
                    "identityProfile": worker.impersonate,
                }
            elif operation == "probe_profiles":
                result = worker.probe_profiles(
                    str(message.get("url") or "https://chatgpt.com/"),
                    message.get("profiles"),
                    message.get("probeTimeoutMs") or 15000,
                    message.get("concurrency") or 4,
                )
            elif operation == "solve_cloudflare":
                result = worker.solve_cloudflare(message)
            elif operation == "generate_sentinel_tokens":
                result = worker.generate_sentinel_tokens(message)
            elif operation == "close":
                worker.close_sentinel()
                write_message({"id": request_id, "ok": True, "result": {"closed": True}})
                return
            else:
                result = worker.request(message)
            write_message({"id": request_id, "ok": True, "result": result})
        except Exception as error:
            write_message({
                "id": locals().get("request_id"),
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
            })


if __name__ == "__main__":
    main()
