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
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urljoin

import httpx

from app.config import Settings
from app.history import store as history_store
from app.k8s_resources import primary_pod_name_for_sandbox
from app.platform_settings import get_resource_recommendation_settings
from app.prometheus_ssrf import validate_prometheus_base_url

logger = logging.getLogger(__name__)

_MAX_SANDBOXES = 2000
_PODS_PER_PROM_BATCH = 30
_MIN_SAMPLES = 30
_PROM_STEP = "60s"
_PROM_QUERY_TIMEOUT = 60.0
_COMPUTE_DEADLINE_SECONDS = 180.0
_FETCH_WORKERS = 4

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


def _pod_names_for_substitute(*, pod: str | None, pods: list[str] | None) -> list[str]:
    if pods:
        return list(pods)
    if pod:
        return [pod]
    raise RecommendationError("INVALID_PROMQL_LABEL", "pod or pods is required")


def _normalize_promql_template_for_pods(template: str, pod_names: list[str]) -> str:
    if len(pod_names) <= 1:
        return template
    normalized = template
    if 'pod="{{pod}}"' in normalized:
        normalized = normalized.replace('pod="{{pod}}"', 'pod=~"{{pod_regex}}"')
    if "{{pod_regex}}" not in normalized and "{{pod}}" not in normalized:
        raise RecommendationError(
            "INVALID_PROMQL_LABEL",
            "PromQL template must include {{pod_regex}} or {{pod}} for batch queries",
        )
    return normalized


def _promql_label_regex(name: str) -> str:
    """Escape RE2 metacharacters in a K8s pod name (UUID-style names stay unescaped)."""
    out: list[str] = []
    for ch in name:
        if ch in r"\[]{}()+*?^.|$":
            out.append("\\" + ch)
        else:
            out.append(ch)
    return "".join(out)


def substitute_promql(
    template: str,
    *,
    namespace: str,
    pod: str | None = None,
    pods: list[str] | None = None,
) -> str:
    pod_names = _pod_names_for_substitute(pod=pod, pods=pods)
    _validate_promql_label("namespace", namespace)
    for name in pod_names:
        _validate_promql_label("pod", name)
    ns = promql_escape_string(namespace)
    pod_regex = "|".join(_promql_label_regex(name) for name in pod_names)
    tpl = _normalize_promql_template_for_pods(template, pod_names)
    out = tpl.replace("{{namespace}}", ns).replace("{{pod_regex}}", pod_regex)
    if "{{pod}}" in out:
        if len(pod_names) != 1:
            raise RecommendationError(
                "INVALID_PROMQL_LABEL",
                "PromQL template uses {{pod}} but multiple pods were requested; use pod=~\"{{pod_regex}}\"",
            )
        out = out.replace("{{pod}}", promql_escape_string(pod_names[0]))
    return out


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


def _parse_sample_value(raw: Any) -> float | None:
    if raw in ("NaN", "+Inf", "-Inf", None):
        return None
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return None
    if math.isnan(value) or math.isinf(value):
        return None
    return value


def _values_in_interval(
    points: list[tuple[float, float]],
    interval_start: datetime,
    interval_end: datetime,
) -> list[float]:
    start_ts = interval_start.timestamp()
    end_ts = interval_end.timestamp()
    out: list[float] = []
    for ts, value in points:
        if ts < start_ts or ts >= end_ts:
            continue
        out.append(value)
    return out


def _prometheus_query_range_by_pod(
    client: httpx.Client,
    base_url: str,
    query: str,
    start: datetime,
    end: datetime,
    *,
    step: str = _PROM_STEP,
) -> dict[str, list[tuple[float, float]]]:
    endpoint = urljoin(base_url.rstrip("/") + "/", "api/v1/query_range")
    # POST avoids 400/414 from oversized GET URLs when many pods are batched in one regex.
    response = client.post(
        endpoint,
        data={
            "query": query,
            "start": str(start.timestamp()),
            "end": str(end.timestamp()),
            "step": step,
        },
    )
    if response.status_code >= 400:
        detail = response.text.strip()[:500]
        raise RuntimeError(
            f"prometheus HTTP {response.status_code}"
            + (f": {detail}" if detail else ""),
        )
    response.raise_for_status()
    payload = response.json()
    if payload.get("status") != "success":
        raise RuntimeError(payload.get("error") or "prometheus query failed")
    data = payload.get("data") or {}
    result = data.get("result") or []
    by_pod: dict[str, list[tuple[float, float]]] = {}
    for series in result:
        metric = series.get("metric") or {}
        pod_name = metric.get("pod")
        if not pod_name:
            continue
        points: list[tuple[float, float]] = []
        for ts_raw, raw in series.get("values") or []:
            try:
                ts = float(ts_raw)
            except (TypeError, ValueError):
                continue
            value = _parse_sample_value(raw)
            if value is None:
                continue
            points.append((ts, value))
        if points:
            by_pod[str(pod_name)] = points
    return by_pod


def _fetch_pods_batch_samples(
    client: httpx.Client,
    cfg: dict[str, Any],
    *,
    namespace: str,
    pod_names: list[str],
    query_start: datetime,
    query_end: datetime,
) -> tuple[dict[str, list[tuple[float, float]]], dict[str, list[tuple[float, float]]]]:
    if not pod_names:
        return {}, {}
    mem_query = substitute_promql(cfg["memoryPromql"], namespace=namespace, pods=pod_names)
    cpu_query = substitute_promql(cfg["cpuPromql"], namespace=namespace, pods=pod_names)
    base = cfg["prometheusUrl"]

    with ThreadPoolExecutor(max_workers=2) as mini:
        mem_future = mini.submit(
            _prometheus_query_range_by_pod, client, base, mem_query, query_start, query_end
        )
        cpu_future = mini.submit(
            _prometheus_query_range_by_pod, client, base, cpu_query, query_start, query_end
        )
        mem_by_pod = mem_future.result()
        cpu_by_pod = cpu_future.result()
    return cpu_by_pod, mem_by_pod


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
        cfg = {
            **cfg,
            "prometheusUrl": validate_prometheus_base_url(
                prom_url,
                allow_internal=settings.bff_prometheus_allow_internal,
            ),
        }
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
    # (sandbox_id, namespace, pod, interval_start, interval_end)
    sandbox_work: list[tuple[str, str, str, datetime, datetime]] = []
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
        pod = primary_pod_name_for_sandbox(sid)
        sandbox_work.append((sid, ns, pod, interval[0], interval[1]))

    by_namespace: dict[str, list[tuple[str, str, str, datetime, datetime]]] = defaultdict(list)
    for entry in sandbox_work:
        by_namespace[entry[1]].append(entry)

    batch_jobs: list[tuple[str, list[tuple[str, str, str, datetime, datetime]]]] = []
    for ns, entries in by_namespace.items():
        for offset in range(0, len(entries), _PODS_PER_PROM_BATCH):
            batch_jobs.append((ns, entries[offset : offset + _PODS_PER_PROM_BATCH]))

    cpu_pool: list[float] = []
    mem_pool: list[float] = []
    per_sandbox: list[dict[str, Any]] = []
    excluded: list[dict[str, str]] = []

    with httpx.Client(timeout=_PROM_QUERY_TIMEOUT) as client:

        def _process_batch(
            namespace: str,
            batch_entries: list[tuple[str, str, str, datetime, datetime]],
        ) -> list[tuple[str, list[float], list[float]]]:
            pod_names = list(dict.fromkeys(entry[2] for entry in batch_entries))
            cpu_by_pod, mem_by_pod = _fetch_pods_batch_samples(
                client,
                cfg,
                namespace=namespace,
                pod_names=pod_names,
                query_start=period_from,
                query_end=period_to,
            )
            out: list[tuple[str, list[float], list[float]]] = []
            for sid, _ns, pod, start, end in batch_entries:
                cpu_samples = _values_in_interval(cpu_by_pod.get(pod, []), start, end)
                mem_samples = _values_in_interval(mem_by_pod.get(pod, []), start, end)
                out.append((sid, cpu_samples, mem_samples))
            return out

        with ThreadPoolExecutor(max_workers=_FETCH_WORKERS) as pool:
            futures = {
                pool.submit(_process_batch, ns, batch): batch
                for ns, batch in batch_jobs
            }
            try:
                for future in as_completed(futures, timeout=_COMPUTE_DEADLINE_SECONDS):
                    batch = futures[future]
                    batch_sids = [entry[0] for entry in batch]
                    try:
                        batch_results = future.result()
                    except RecommendationError:
                        raise
                    except Exception as exc:
                        logger.warning(
                            "Prometheus batch fetch failed for namespace %s (%d sandboxes): %s",
                            batch[0][1] if batch else "?",
                            len(batch_sids),
                            exc,
                        )
                        for sid in batch_sids:
                            excluded.append({"sandboxId": sid, "reason": "prometheus_error"})
                        continue
                    for sandbox_id_out, cpu_samples, mem_samples in batch_results:
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
        "sandboxCount": len(sandbox_work),
        "prometheusBatchCount": len(batch_jobs),
        "podsPerPrometheusBatch": _PODS_PER_PROM_BATCH,
        "sandboxCountWithMetrics": len(per_sandbox),
        "sampleCount": {"cpu": len(cpu_pool), "memory": len(mem_pool)},
        "excludedSandboxes": excluded,
        "perSandbox": sorted(per_sandbox, key=lambda x: x["sandboxId"]),
        "aggregation": "pooled_percentile",
        **resource,
    }
