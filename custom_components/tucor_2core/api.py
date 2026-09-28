"""Local bridge API. Tucor credentials stay on the bridge."""
import asyncio
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import aiohttp


class BridgeError(Exception):
    """An API operation failed."""


class BridgeAuthError(BridgeError):
    """The bridge access key was rejected."""


class BridgeClient:
    def __init__(self, session: aiohttp.ClientSession, url: str, key: str):
        self.session = session
        self.url = url.rstrip("/")
        self.key = key

    async def request(self, path: str, body: dict | None = None):
        headers = {"Authorization": f"Bearer {self.key}"}
        if body is not None:
            headers["Idempotency-Key"] = uuid4().hex
            body = {**body, "deadline": (datetime.now(timezone.utc) + timedelta(seconds=60)).isoformat()}
        try:
            async with asyncio.timeout(90 if body is not None else 10):
                async with self.session.request(
                    "POST" if body is not None else "GET", f"{self.url}/api{path}",
                    headers=headers, json=body, allow_redirects=False,
                ) as response:
                    if response.status == 401:
                        raise BridgeAuthError("Invalid 2core access key")
                    data = await response.json()
                    if response.status != 200:
                        raise BridgeError(data.get("error", "2core request failed"))
                    return data
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            raise BridgeError("Cannot reach 2core; command outcome may be unknown. Check status before retrying") from err

    async def state(self):
        data = await self.request("/state")
        if data.get("apiVersion") != 1:
            raise BridgeError("Unsupported 2core API version")
        return data
