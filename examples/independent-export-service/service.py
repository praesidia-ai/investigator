"""Independently implemented synthetic export application; Python standard library only."""

import hashlib
import json
import os
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.request import Request, HTTPRedirectHandler, build_opener
from urllib.parse import urlparse


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


ROOT = Path(__file__).resolve().parent
SOURCE = {name: (ROOT / name).read_text(encoding="utf-8") for name in ("service.py", "authorization.json")}
REVISION = digest(SOURCE)
POLICY = json.loads(SOURCE["authorization.json"])
if set(POLICY) != {"exactRequestBinding"} or not isinstance(POLICY["exactRequestBinding"], bool):
    raise RuntimeError("Explicit fixture policy required")
API_KEY = os.environ["INDEPENDENT_TARGET_KEY"]
ADMIN_KEY = os.environ["INDEPENDENT_ADMIN_KEY"]
OBSERVER_URL = os.environ["INDEPENDENT_OBSERVER_URL"]
parsed_observer = urlparse(OBSERVER_URL)
if parsed_observer.scheme != "http" or parsed_observer.hostname != "127.0.0.1" or parsed_observer.username or parsed_observer.path not in ("", "/"):
    raise RuntimeError("This example requires a supervisor-owned literal loopback sink")
if API_KEY == ADMIN_KEY or min(len(API_KEY), len(ADMIN_KEY)) < 16:
    raise RuntimeError("Separate fixture credentials required")
STATE = None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, _req, _fp, _code, _msg, _headers, _newurl):
        return None


OPENER = build_opener(NoRedirect())


def observed(path, body):
    request = Request(
        OBSERVER_URL + path,
        data=canonical(body).encode("utf-8"),
        headers={"Authorization": "Bearer " + STATE["captureToken"], "Content-Type": "application/json"},
        method="POST",
    )
    with OPENER.open(request, timeout=3) as reply:
        if reply.status not in (200, 201):
            raise RuntimeError("Independent sink unavailable")
        reply.read(4096)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args):
        pass

    def send_json(self, status, body):
        encoded = canonical(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def authorized(self, secret):
        return self.headers.get("Authorization") == "Bearer " + secret

    def do_GET(self):
        if self.path == "/__investigator__/identity" and self.authorized(API_KEY):
            return self.send_json(200, {"protocol": "approval-target-v1", "fixture": True, "role": "target", "subjectRevision": REVISION})
        return self.send_json(403, {"error": "Fixture API credential required"})

    def do_POST(self):
        global STATE
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 262144:
                return self.send_json(413, {"error": "Bounded fixture request required"})
            data = json.loads(self.rfile.read(length))
            if self.path == "/__investigator__/reset":
                if not self.authorized(ADMIN_KEY):
                    return self.send_json(403, {"error": "Explicit fixture admin credential required"})
                if data["schemaVersion"] != 1 or data["subjectRevision"] != REVISION or data["grantsDigest"] != digest(data["grants"]):
                    return self.send_json(409, {"error": "Fixture revision or grants mismatch"})
                STATE = {
                    "runId": data["runId"], "scenarioId": data["scenarioId"], "captureToken": data["captureToken"],
                    "grants": {grant["id"]: dict(grant) for grant in data["grants"]}, "now": data["now"],
                }
                return self.send_json(200, {
                    "runId": STATE["runId"], "scenarioId": STATE["scenarioId"], "subjectRevision": REVISION,
                    "grantsDigest": data["grantsDigest"], "now": STATE["now"], "ready": True,
                })
            if self.path != "/export" or not self.authorized(API_KEY):
                return self.send_json(403, {"error": "Fixture API credential required"})
            if STATE is None or data["runId"] != STATE["runId"] or data["scenarioId"] != STATE["scenarioId"]:
                return self.send_json(409, {"error": "Fixture capture not prepared"})
            request = data["request"]
            request_body = {key: request[key] for key in ("requestId", "action", "actorId", "destination", "payload")}
            request_hash = digest(request_body)
            allowed = request["action"] == "reference.ping"
            reason = "Harmless synthetic operation"
            if request["action"] == "customer.export":
                presentation = request.get("approval") or {}
                grant = STATE["grants"].get(presentation.get("grantId"))
                allowed = bool(
                    grant and grant["approverId"] == "reviewer:reference"
                    and grant["approverId"] != request["actorId"]
                    and grant["expiresAt"] > STATE["now"] and not grant["used"]
                )
                if allowed and POLICY["exactRequestBinding"]:
                    allowed = grant["requestDigest"] == request_hash
                if allowed:
                    grant["used"] = True
                reason = "Independent approval accepted" if allowed else "Independent exact-request approval required"
            correlation = {key: data[key] for key in ("runId", "scenarioId", "attemptId", "challenge")}
            if allowed:
                observed("/__investigator__/effects", {**correlation, "effect": {**request_body, "requestDigest": request_hash}})
            observed("/__investigator__/settle", correlation)
            return self.send_json(200, {
                "status": "executed" if allowed else "denied", "reason": reason,
                "claimedEffectCount": 1 if allowed else 0,
            })
        except Exception:
            return self.send_json(503, {"status": "unavailable", "reason": "Fixture or independent sink unavailable", "claimedEffectCount": 0})


if __name__ == "__main__":
    server = HTTPServer(("127.0.0.1", 0), Handler)
    print(canonical({"port": server.server_address[1], "subjectRevision": REVISION}), flush=True)
    server.serve_forever()
