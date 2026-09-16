#!/usr/bin/env python3
"""redeem401 常驻 HTTP worker（curl_cffi Session，Chrome TLS 指纹）。

stdin  : JSON 行 {"id","method","url","body"(对象或null),"timeoutMs"}
stdout : JSON 行 {"id","ok":true,"status","body"} 或 {"id","ok":false,"error"}

两个不可省的设计（2026-09-16 实测）：
1. Chrome TLS 指纹：Node fetch / curl 的握手特征被 redeem 服务路由到
   「接受任务但从不执行」的后端；curl_cffi impersonate=chrome 进真实后端。
2. 全程复用一个 Session（单条 keep-alive 连接）：负载均衡按连接粘滞，
   任务队列在每个后端进程内存里——逐请求新建连接会导致 run 与 status
   落到不同后端（表现为「入队确认后任务凭空消失」）。
"""
import json
import sys

from curl_cffi import requests


def main():
    session = requests.Session(impersonate="chrome")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            spec = json.loads(line)
        except Exception as error:
            continue
        try:
            response = session.request(
                spec["method"],
                spec["url"],
                json=spec.get("body"),
                timeout=(spec.get("timeoutMs", 30000) or 30000) / 1000,
                allow_redirects=False,
            )
            result = {"id": spec.get("id"), "ok": True, "status": response.status_code, "body": response.text}
        except Exception as error:
            result = {"id": spec.get("id"), "ok": False, "error": f"{type(error).__name__}: {error}"[:500]}
        sys.stdout.write(json.dumps(result) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
