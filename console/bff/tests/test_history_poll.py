# Copyright 2026 The OpenSandbox Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

import asyncio

import pytest

from app.config import Settings
from app.history import reconcile
from app.tenants import TenantRecord


def _settings(**updates: object) -> Settings:
    base = dict(
        lifecycle_api_base="http://lifecycle.test/v1",
        tenants_toml_path="/tmp/tenants.toml",
        bff_session_secret="x" * 32,
        bff_admin_token="admin",
        bff_history_enabled=True,
        bff_history_reconcile_interval_seconds=600,
    )
    base.update(updates)
    return Settings(**base)


@pytest.mark.asyncio
async def test_poll_skips_when_interval_is_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    called = False

    async def sync(settings: Settings, *, tenants: list[TenantRecord]) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(reconcile, "sync_with_lifecycle", sync)
    await reconcile.poll_forever(_settings(bff_history_reconcile_interval_seconds=0))
    assert called is False


@pytest.mark.asyncio
async def test_poll_reconciles_all_tenants_once_per_tick(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list[str]] = []

    async def sync(settings: Settings, *, tenants: list[TenantRecord]) -> None:
        seen.append([tenant.name for tenant in tenants])

    async def stop_after_one_tick(_: float) -> None:
        raise asyncio.CancelledError

    monkeypatch.setattr(reconcile, "sync_with_lifecycle", sync)
    monkeypatch.setattr(reconcile, "load_tenants", lambda _path: [TenantRecord("geip", "geip-ns", "key")])
    monkeypatch.setattr(reconcile.asyncio, "sleep", stop_after_one_tick)

    with pytest.raises(asyncio.CancelledError):
        await reconcile.poll_forever(_settings())

    assert seen == [["geip"]]
