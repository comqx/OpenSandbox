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

from __future__ import annotations

import logging
import math
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode, urljoin

import httpx

from app.config import Settings
from app.history import store as history_store
from app.k8s_resources import primary_pod_name_for_sandbox
from app.platform_settings import get_resource_recommendation_settings
from app.prometheus_ssrf import validate_prometheus_base_url

logger = logging.getLogger(__name__)

_MAX_SANDBOXES = 500
_MIN_SAMPLES = 30
_PROM_STEP = "60s"
_PROM_QUERY_TIMEOUT = 30.0
_COMPUTE_DEADLINE_SECONDS = 120.0
_FETCH_WORKERS = 8

_CPU_QUANT_MILLICORES = 50
_MEM_QUANT_MIB = 64

_K8S_DNS_LABEL = re.compile(r"^[a-z0-9]([-a-z0-9]*[a-z0-9])?$", re.IGNORECASE)


class RecommendationError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def window_to_period(window: str) -> tuple[datetime, datetime]:
    normalized = window.strip().lower()
    now = datetime.now(timezone.utc)
    if normalized == "7d":
        return now - timedelta(days=7), now
    if normalized == "15d":
        return now - timedelta(days=15), now
    raise RecommendationError("INVALID_WINDOW", "window must be 7d or 15d")


def promql_escape_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n")


def _validate_promql_label(name: str, value: str) -> None:
    if not value or len(value) > 253:
        raise RecommendationError("INVALID_PROMQL_LABEL", f"{name} is empty or too long")
    if not _K8S_DNS_LABEL.match(value):
        raise RecommendationError("INVALID_PROMQL_LABEL", f"{name} contains invalid characters")


def substitute_promql(template: str, *, namespace: str, pod: str) -> str:
    _validate_promql_label("namespace", namespace)
    _validate_promql_label("pod", pod)
    ns = promql_escape_string(namespace)
    po = promql_escape_string(pod)
    return (
        template.replace("{{namespace}}", ns)
        .replace("{{pod}}", po)
        .replace("{{pod_regex}}", re.escape(pod))
    )


def percentile(values: list[float], p: float) -> float:
    if not values:
        raise ValueError("empty values")
    if p <= 0:
        return min(values)
    if p >= 100:
        return max(values)
    ordered = sorted(values)
    rank = (len(ordered) - 1) * (p / 100.0)
    lower = int(math.floor(rank))
    upper = int(math.ceil(rank))
    if lower == upper:
        return ordered[lower]
    weight = rank - lower
    return ordered[lower] * (1.0 - weight) + ordered[upper] * weight


def parse_cpu_cores(value: str) -> float:
    text = value.strip()
    if not text:
        raise ValueError("empty cpu quantity")
    if text.endswith("m"):
        return float(text[:-1]) / 1000.0
    return float(text)


def parse_memory_bytes(value: str) -> float:
    text = value.strip()
    if not text:
        raise ValueError("empty memory quantity")
    match = re.fullmatch(r"(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?i?", text, re.IGNORECASE)
    if not match:
        raise ValueError(f"invalid memory quantity: {value}")
    amount = float(match.group(1))
    unit = (match.group(2) or "i").lower()
    if unit in ("", "i"):
        return amount
    if unit == "ki":
        return amount * 1024
    if unit == "mi":
        return amount * 1024**2
    if unit == "gi":
        return amount * 1024**3
    if unit == "ti":
        return amount * 1024**4
    if unit == "k":
        return amount * 1000
    if unit == "m":
        return amount * 1000**2
    if unit == "g":
        return amount * 1000**3
    if unit == "t":
        return amount * 1000**4
    raise ValueError(f"unsupported memory unit: {unit}")


def format_cpu_cores(cores: float) -> str:
    millicores = max(1, int(math.ceil(cores * 1000)))
    millicores = ((millicores + _CPU_QUANT_MILLICORES - 1) // _CPU_QUANT_MILLICORES) * _CPU_QUANT_MILLICORES
    if millicores >= 1000 and millicores % 1000 == 0:
        return str(millicores // 1000)
    return f"{millicores}m"


def format_memory_bytes(num_bytes: float) -> str:
    mib = max(1, int(math.ceil(num_bytes / (1024**2))))
    mib = ((mib + _MEM_QUANT_MIB - 1) // _MEM_QUANT_MIB) * _MEM_QUANT_MIB
    if mib >= 1024 and mib % 1024 == 0:
        return f"{mib // 1024}Gi"
    return f"{mib}Mi"


def build_requests_limits(
    *,
    cpu_base_cores: float,
    memory_base_bytes: float,
    percentile: float,
    cpu_limit_ratio: float,
    cpu_limit_floor: str,
    memory_limit_ratio: float,
    memory_limit_floor: str,
) -> dict[str, Any]:
    cpu_request = format_cpu_cores(cpu_base_cores)
    mem_request = format_memory_bytes(memory_base_bytes)

    cpu_limit_val = max(cpu_base_cores * cpu_limit_ratio, parse_cpu_cores(cpu_limit_floor))
    mem_limit_val = max(memory_base_bytes * memory_limit_ratio, parse_memory_bytes(memory_limit_floor))

    cpu_limit = format_cpu_cores(cpu_limit_val)
    mem_limit = format_memory_bytes(mem_limit_val)

    if parse_cpu_cores(cpu_limit) < parse_cpu_cores(cpu_request):
        cpu_limit = cpu_request
    if parse_memory_bytes(mem_limit) < parse_memory_bytes(mem_request):
        mem_limit = mem_request

    return {
        "percentile": percentile,
        "cpuBaseCores": cpu_base_cores,
        "memoryBaseBytes": memory_base_bytes,
        "requests": {"cpu": cpu_request, "memory": mem_request},
        "limits": {"cpu": cpu_limit, "memory": mem_limit},
        "ratios": {
            "cpuLimitRatio": cpu_limit_ratio,
            "memoryLimitRatio": memory_limit_ratio,
            "cpuLimitFloor": cpu_limit_floor,
            "memoryLimitFloor": memory_limit_floor,
        },
    }


def _prometheus_query_range(
    client: httpx.Client,
    base_url: str,
    query: str,
    start: datetime,
    end: datetime,
    *,
    step: str = _PROM_STEP,
) -> list[float]:
    params = {
        "query": query,
        "start": start.timestamp(),
        "end": end.timestamp(),
        "step": step,
    }
    url = urljoin(base_url.rstrip("/") + "/", "api/v1/query_range") + "?" + urlencode(params)
    response = client.get(url)
    response.raise_for_status()
    payload = response.json()
    if payload.get("status") != "success":
        raise RuntimeError(payload.get("error") or "prometheus query failed")
    data = payload.get("data") or {}
    result = data.get("result") or []
    samples: list[float] = []
    for series in result:
        for _ts, raw in series.get("values") or []:
            if raw in ("NaN", "+Inf", "-Inf", None):
                continue
            try:
                value = float(raw)
            except (TypeError, ValueError):
                continue
            if math.isnan(value) or math.isinf(value):
                continue
            samples.append(value)
    return samples


def _fetch_sandbox_samples(
    client: httpx.Client,
    cfg: dict[str, Any],
    *,
    namespace: str,
    sandbox_id: str,
    start: datetime,
    end: datetime,
) -> tuple[list[float], list[float]]:
    pod = primary_pod_name_for_sandbox(sandbox_id)
    mem_query = substitute_promql(cfg["memoryPromql"], namespace=namespace, pod=pod)
    cpu_query = substitute_promql(cfg["cpuPromql"], namespace=namespace, pod=pod)
    base = cfg["prometheusUrl"]

    with ThreadPoolExecutor(max_workers=2) as mini:
        mem_future = mini.submit(_prometheus_query_range, client, base, mem_query, start, end)
        cpu_future = mini.submit(_prometheus_query_range, client, base, cpu_query, start, end)
        mem_samples = mem_future.result()
        cpu_samples = cpu_future.result()
    return cpu_samples, mem_samples


def compute_resource_recommendations(
    settings: Settings,
    *,
    tenant_name: str | None,
    period_from: datetime,
    period_to: datetime,
    label: str | None = None,
    sandbox_id: str | None = None,
) -> dict[str, Any]:
    if not history_store.history_pool_available():
        raise RecommendationError(
            "HISTORY_UNAVAILABLE",
            "History database is not available",
        )

    cfg = get_resource_recommendation_settings(settings)
    if not cfg.get("enabled"):
        raise RecommendationError(
            "RECOMMENDATION_DISABLED",
            "Resource recommendations are disabled in platform settings",
        )
    prom_url = str(cfg.get("prometheusUrl") or "").strip()
    if not prom_url:
        raise RecommendationError(
            "PROMETHEUS_NOT_CONFIGURED",
            "Set Prometheus URL in platform settings",
        )
    try:
        cfg = {**cfg, "prometheusUrl": validate_prometheus_base_url(prom_url)}
    except ValueError as exc:
        raise RecommendationError("PROMETHEUS_URL_INVALID", str(exc)) from exc

    rows = history_store.list_recommendation_candidates(
        settings,
        tenant_name=tenant_name,
        period_from=period_from,
        period_to=period_to,
        label=label,
        sandbox_id=sandbox_id,
        max_rows=_MAX_SANDBOXES + 1,
    )
    if len(rows) > _MAX_SANDBOXES:
        raise RecommendationError(
            "SANDBOX_LIMIT_EXCEEDED",
            f"More than {_MAX_SANDBOXES} sandboxes match; narrow label or period",
        )

    now = datetime.now(timezone.utc)
    intervals: list[tuple[str, str, str, datetime, datetime]] = []
    for row in rows:
        interval = history_store.effective_lifecycle_interval(
            row,
            period_from=period_from,
            period_to=period_to,
            now=now,
        )
        if interval is None:
            continue
        sid = str(row.get("sandbox_id") or "")
        ns = str(row.get("namespace") or "")
        if not sid or not ns:
            continue
        intervals.append((sid, ns, str(row.get("tenant_name") or ""), interval[0], interval[1]))

    cpu_pool: list[float] = []
    mem_pool: list[float] = []
    per_sandbox: list[dict[str, Any]] = []
    excluded: list[dict[str, str]] = []

    with httpx.Client(timeout=_PROM_QUERY_TIMEOUT) as client:

        def _task(item: tuple[str, str, str, datetime, datetime]) -> tuple[str, list[float], list[float]]:
            sid, ns, _tenant, start, end = item
            cpu_samples, mem_samples = _fetch_sandbox_samples(
                client,
                cfg,
                namespace=ns,
                sandbox_id=sid,
                start=start,
                end=end,
            )
            return sid, cpu_samples, mem_samples

        with ThreadPoolExecutor(max_workers=_FETCH_WORKERS) as pool:
            futures = {pool.submit(_task, item): item[0] for item in intervals}
            try:
                for future in as_completed(futures, timeout=_COMPUTE_DEADLINE_SECONDS):
                    sid = futures[future]
                    try:
                        sandbox_id_out, cpu_samples, mem_samples = future.result()
                    except RecommendationError:
                        raise
                    except Exception as exc:
                        logger.warning("Prometheus fetch failed for sandbox %s: %s", sid, exc)
                        excluded.append({"sandboxId": sid, "reason": "prometheus_error"})
                        continue
                    if not cpu_samples and not mem_samples:
                        excluded.append({"sandboxId": sandbox_id_out, "reason": "no_metrics_in_window"})
                        continue
                    cpu_pool.extend(cpu_samples)
                    mem_pool.extend(mem_samples)
                    per_sandbox.append(
                        {
                            "sandboxId": sandbox_id_out,
                            "cpuSampleCount": len(cpu_samples),
                            "memorySampleCount": len(mem_samples),
                        },
                    )
            except TimeoutError as exc:
                for pending in futures:
                    if not pending.done():
                        pending.cancel()
                raise RecommendationError(
                    "COMPUTE_TIMEOUT",
                    f"Resource recommendation timed out after {_COMPUTE_DEADLINE_SECONDS:.0f}s",
                ) from exc

    if len(cpu_pool) < _MIN_SAMPLES or len(mem_pool) < _MIN_SAMPLES:
        raise RecommendationError(
            "INSUFFICIENT_DATA",
            f"Need at least {_MIN_SAMPLES} CPU and memory samples; got {len(cpu_pool)} cpu and {len(mem_pool)} memory",
        )

    p = float(cfg.get("percentile") or 95)
    cpu_base = percentile(cpu_pool, p)
    mem_base = percentile(mem_pool, p)

    try:
        resource = build_requests_limits(
            cpu_base_cores=cpu_base,
            memory_base_bytes=mem_base,
            percentile=p,
            cpu_limit_ratio=float(cfg.get("cpuLimitRatio") or 2),
            cpu_limit_floor=str(cfg.get("cpuLimitFloor") or "100m"),
            memory_limit_ratio=float(cfg.get("memoryLimitRatio") or 1.5),
            memory_limit_floor=str(cfg.get("memoryLimitFloor") or "200Mi"),
        )
    except ValueError as exc:
        raise RecommendationError("INVALID_SETTINGS", str(exc)) from exc

    return {
        "period": {
            "from": period_from.isoformat().replace("+00:00", "Z"),
            "to": period_to.isoformat().replace("+00:00", "Z"),
        },
        "sandboxCount": len(intervals),
        "sandboxCountWithMetrics": len(per_sandbox),
        "sampleCount": {"cpu": len(cpu_pool), "memory": len(mem_pool)},
        "excludedSandboxes": excluded,
        "perSandbox": sorted(per_sandbox, key=lambda x: x["sandboxId"]),
        "aggregation": "pooled_percentile",
        **resource,
    }
