# AgentVis Script Skill 核心模块模板：brokerOnly 联网逻辑放在 entry 之外。
"""Core module template for a brokerOnly AgentVis Script Skill.

Use this file as the sibling module imported by python_script_entry.py. It may
contain API base URL constants and broker helper calls because it is not the
declared execution.entry. Do not read host tokens from env, Home/AppData, or
Credential Manager; declare credentials in SKILL.md and pass credentialRef in
the broker request.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlparse

API_BASE_URL = "https://api.example.com"
USER_AGENT = "AgentVis-Script-Skill/1.0"


class UserCorrectableError(RuntimeError):
    """Raised when Agent can explain the issue to the user and retry later."""


@dataclass
class BrokerResponse:
    status: int
    headers: dict[str, str]
    text: str
    credential_applied: bool

    def json(self) -> Any:
        return json.loads(self.text)


def broker_available() -> bool:
    return bool(
        os.environ.get("AGENTVIS_BROKER_FETCH")
        and os.environ.get("AGENTVIS_BROKER_PIPE")
        and os.environ.get("AGENTVIS_BROKER_TOKEN")
    )


def broker_failure_diagnostics(payload: dict[str, Any], url: str) -> str:
    """Return stable broker diagnostics for Agent observations."""
    lines = []
    reason_code = str(payload.get("reasonCode") or "").strip()
    error_kind = str(payload.get("errorKind") or "").strip()
    if reason_code:
        lines.append(f"brokerReasonCode: {reason_code}")
    if error_kind:
        lines.append(f"brokerErrorKind: {error_kind}")
    target_host = str(payload.get("targetHost") or urlparse(url).hostname or "").strip()
    if target_host:
        lines.append(f"brokerTargetHost: {target_host}")
    credential_ref = str(payload.get("credentialRef") or "").strip()
    if credential_ref:
        lines.append(f"brokerCredentialRef: {credential_ref}")
    if "credentialApplied" in payload:
        lines.append(f"credentialApplied: {bool(payload.get('credentialApplied'))}")
    if not lines:
        return ""
    return "\n" + "\n".join(lines)


def broker_request(
    method: str,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    body: bytes | None = None,
    credential_ref: str | None = None,
    timeout_seconds: int = 30,
) -> BrokerResponse:
    """Send one HTTP(S) request through agentvis-broker-fetch."""
    helper = os.environ.get("AGENTVIS_BROKER_FETCH") or "agentvis-broker-fetch"
    request: dict[str, Any] = {
        "method": method.upper(),
        "url": url,
        "headers": [
            {"name": name, "value": value}
            for name, value in (headers or {}).items()
            if value
        ],
        "timeoutMs": timeout_seconds * 1000,
    }
    if body is not None:
        request["bodyBase64"] = base64.b64encode(body).decode("ascii")
    if credential_ref:
        request["credentialRef"] = credential_ref

    completed = subprocess.run(
        [helper],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        timeout=timeout_seconds + 10,
        check=False,
    )

    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Broker helper returned invalid JSON: {exc}") from exc

    if completed.returncode != 0 or payload.get("ok") is not True:
        error = payload.get("error") or completed.stderr or "unknown broker helper failure"
        raise RuntimeError(f"Broker helper request failed: {error}{broker_failure_diagnostics(payload, url)}")

    response_headers = {
        str(item.get("name", "")).lower(): str(item.get("value", ""))
        for item in payload.get("headers") or []
        if item.get("name")
    }
    body_bytes = base64.b64decode(payload.get("bodyBase64") or "")
    return BrokerResponse(
        status=int(payload.get("status") or 0),
        headers=response_headers,
        text=body_bytes.decode("utf-8", errors="replace"),
        credential_applied=bool(payload.get("credentialApplied")),
    )


def run(
    *,
    resource_id: str,
    mode: str = "info",
    limit: int = 10,
    include_metadata: bool = False,
) -> dict[str, Any] | str:
    if not broker_available():
        raise UserCorrectableError("AgentVis brokerOnly helper is unavailable.")

    safe_resource_id = quote(resource_id, safe="")
    response = broker_request(
        "GET",
        f"{API_BASE_URL}/resources/{safe_resource_id}?mode={mode}&limit={limit}",
        headers={
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
        # Set credential_ref only when execution.credentials declares it.
        credential_ref=None,
    )

    if response.status == 404:
        raise UserCorrectableError(f"Resource not found: {resource_id}")
    if response.status in (401, 403) and not response.credential_applied:
        raise UserCorrectableError(
            "The required credential provider is missing or invalid in AgentVis "
            "Credential Manager, or the request continued anonymously."
        )
    if response.status < 200 or response.status >= 300:
        raise RuntimeError(f"API request failed with status {response.status}: {response.text[:500]}")

    try:
        data = response.json()
    except json.JSONDecodeError:
        data = {"text": response.text}

    if include_metadata:
        data["_agentvis"] = {"credentialApplied": response.credential_applied}
    return data
