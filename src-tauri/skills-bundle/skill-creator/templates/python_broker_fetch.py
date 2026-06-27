"""Template helpers for AgentVis Script Skills using brokerOnly HTTP(S).

Copy the relevant functions into a sibling core module imported by the declared
entrypoint, not directly into execution.entry. In brokerOnly mode, the script
process must not read host secrets from env/Home/AppData/Credential Manager.
Pass credentialRef to the broker helper and let the AgentVis main process inject
the declared header for allowed HTTPS hosts.
"""

from __future__ import annotations

import base64
import json
import os
import subprocess
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse


@dataclass
class BrokerResponse:
    status: int
    headers: dict[str, str]
    text: str
    credential_applied: bool
    truncated: bool = False
    saved_path: str = ""
    bytes_in: int = 0
    final_url: str = ""

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
    save_path: str = "",
    timeout_seconds: int = 30,
) -> BrokerResponse:
    """Send one HTTP(S) request through agentvis-broker-fetch.

    Use save_path for binary or large responses. Non-savePath bodyBase64
    responses are capped by the broker and must not be treated as files.
    """
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
    if save_path:
        request["savePath"] = save_path

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
    truncated = bool(payload.get("truncated"))
    saved_path = str(payload.get("savedPath") or "")
    if truncated and not saved_path:
        raise RuntimeError("Broker response was truncated; use savePath for large or binary responses.")
    body_bytes = b"" if saved_path else base64.b64decode(payload.get("bodyBase64") or "")
    return BrokerResponse(
        status=int(payload.get("status") or 0),
        headers=response_headers,
        text=body_bytes.decode("utf-8", errors="replace"),
        credential_applied=bool(payload.get("credentialApplied")),
        truncated=truncated,
        saved_path=saved_path,
        bytes_in=int(payload.get("bytesIn") or len(body_bytes)),
        final_url=str(payload.get("finalUrl") or url),
    )


def example_get_resource(resource_id: str) -> BrokerResponse:
    """Example request with a broker-managed credentialRef."""
    if not broker_available():
        raise RuntimeError("This Script Skill requires AgentVis brokerOnly mode.")

    response = broker_request(
        "GET",
        f"https://api.example.com/resources/{resource_id}",
        headers={
            "Accept": "application/json",
            "User-Agent": "AgentVis-Script-Skill/1.0",
        },
        credential_ref="example",
    )

    if response.status in (401, 403) and not response.credential_applied:
        raise RuntimeError(
            "The API credential provider 'example' is not configured in AgentVis "
            "Credential Manager, or the request continued anonymously."
        )

    return response
