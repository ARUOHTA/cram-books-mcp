import os
import sys
from typing import Any, Sequence
import httpx


def log(*a: Any) -> None:
    print(*a, file=sys.stderr, flush=True)


def _script_id() -> str:
    sid = os.environ.get("SCRIPT_ID")
    if not sid:
        raise RuntimeError("SCRIPT_ID is not set")
    return sid


def _access_token() -> str:
    tok = os.environ.get("GAS_ACCESS_TOKEN")
    if not tok:
        raise RuntimeError("GAS_ACCESS_TOKEN is not set")
    return tok


async def scripts_run(
    function: str,
    parameters: Sequence[Any] | None = None,
    dev_mode: bool = True,
    script_id: str | None = None,
) -> dict:
    """Call Apps Script Execution API: scripts.run

    Expects an OAuth2 access token in env var GAS_ACCESS_TOKEN that is authorized
    to run the target script. Returns the `response.result` payload on success.
    """
    sid = script_id or _script_id()
    url = f"https://script.googleapis.com/v1/scripts/{sid}:run"
    body = {
        "function": function,
        "devMode": bool(dev_mode),
    }
    if parameters is not None:
        body["parameters"] = list(parameters)

    headers = {
        "Authorization": f"Bearer {_access_token()}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }

    log("EXECUTION_API POST", url, body)
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(url, headers=headers, json=body)
        r.raise_for_status()
        data = r.json()

    # Execution API success shape: { response: { result: ... } }
    resp = data.get("response") if isinstance(data, dict) else None
    if isinstance(resp, dict) and "result" in resp:
        return resp["result"]

    # Error shape passthrough
    return data

