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
from app.platform_settings import get_resource_recommendation_runtime
from app.prometheus_ssrf import validate_prometheus_base_url

logger = logging.getLogger(__name__)

_MAX_SANDBOXES = 2000
_PODS_PER_PROM_BATCH = 30
_MIN_SAMPLES_PER_SANDBOX = 3
_MIN_QUALIFIED_SANDBOXES = 5
_LOW_CONFIDENCE_BELOW = 20
_CPU_REQUEST_WITHIN_PERCENTILE = 75.0
_MEMORY_REQUEST_WITHIN_PERCENTILE = 95.0
_CPU_COHORT_REQUEST_PERCENTILE = 75.0
_HETEROGENEOUS_PEAK_RATIO = 3.0
_PROM_STEP = "60s"
_PROM_CHUNK = timedelta(days=7)
_PROM_QUERY_TIMEOUT = 60.0
_COMPUTE_DEADLINE_SECONDS = 180.0
_FETCH_WORKERS = 4

_CPU_QUANT_MILLICORES = 10
_MEM_QUANT_MIB = 32

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
    """Parse a Kubernetes memory quantity. Suffix case is significant.

    ``m`` is milli-bytes. ``M`` is decimal megabytes. ``Mi`` is mebibytes.
    """
    text = value.strip()
    if not text:
        raise ValueError("empty memory quantity")
    match = re.fullmatch(r"(\d+(?:\.\d+)?)([A-Za-z]+)?", text)
    if not match:
        raise ValueError(f"invalid memory quantity: {value}")
    amount = float(match.group(1))
    unit = match.group(2) or ""
    if unit == "":
        return amount
    if unit == "m":
        return amount / 1000.0
    binary = {"Ki": 1024, "Mi": 1024**2, "Gi": 1024**3, "Ti": 1024**4}
    decimal = {"k": 1000, "K": 1000, "M": 1000**2, "G": 1000**3, "T": 1000**4}
    if unit in binary:
        return amount * binary[unit]
    if unit in decimal:
        return amount * decimal[unit]
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
    cpu_request_cores: float,
    memory_request_bytes: float,
    cpu_limit_base_cores: float,
    memory_limit_base_bytes: float,
    percentile: float,
    cpu_limit_ratio: float,
    cpu_limit_floor: str,
    memory_limit_ratio: float,
    memory_limit_floor: str,
) -> dict[str, Any]:
    """Quantize request baselines. Limit floors are emitted unchanged when they win."""
    cpu_request = format_cpu_cores(cpu_request_cores)
    mem_request = format_memory_bytes(memory_request_bytes)

    cpu_floor = parse_cpu_cores(cpu_limit_floor)
    mem_floor = parse_memory_bytes(memory_limit_floor)
    cpu_limit_val = cpu_limit_base_cores * cpu_limit_ratio
    mem_limit_val = memory_limit_base_bytes * memory_limit_ratio
    cpu_limit = cpu_limit_floor.strip() if cpu_limit_val <= cpu_floor else format_cpu_cores(cpu_limit_val)
    mem_limit = memory_limit_floor.strip() if mem_limit_val <= mem_floor else format_memory_bytes(mem_limit_val)

    if parse_cpu_cores(cpu_limit) < parse_cpu_cores(cpu_request):
        cpu_limit = cpu_request
    if parse_memory_bytes(mem_limit) < parse_memory_bytes(mem_request):
        mem_limit = mem_request

    return {
        "percentile": percentile,
        "cpuBaseCores": cpu_request_cores,
        "memoryBaseBytes": memory_request_bytes,
        "requests": {"cpu": cpu_request, "memory": mem_request},
        "limits": {"cpu": cpu_limit, "memory": mem_limit},
        "ratios": {
            "cpuLimitRatio": cpu_limit_ratio,
            "memoryLimitRatio": memory_limit_ratio,
            "cpuLimitFloor": cpu_limit_floor,
            "memoryLimitFloor": memory_limit_floor,
        },
    }


def recommendation_pod_names(sandbox_id: str) -> list[str]:
    """Pod names to try: current BatchSandbox ``<id>-0``, then pre-upgrade ``sandbox-<id>-0``."""
    primary = primary_pod_name_for_sandbox(sandbox_id)
    legacy = f"sandbox-{sandbox_id}-0"
    names: list[str] = []
    for name in (primary, legacy):
        if name and name not in names:
            names.append(name)
    return names


def iter_prom_range_chunks(
    start: datetime,
    end: datetime,
    *,
    chunk: timedelta = _PROM_CHUNK,
):
    """Split a query_range so each piece stays under Prometheus's 11000-point cap at 60s."""
    if end <= start:
        return
    cursor = start
    while cursor < end:
        nxt = min(cursor + chunk, end)
        yield cursor, nxt
        cursor = nxt


def sandbox_usage_summary(
    cpu_samples: list[float],
    memory_samples: list[float],
    cpu_peak_samples: list[float],
) -> dict[str, Any]:
    """One sandbox, one vote: sustained percentiles plus short-window peaks."""
    peak_fallback = not cpu_peak_samples
    return {
        "cpuRequestCores": percentile(cpu_samples, _CPU_REQUEST_WITHIN_PERCENTILE),
        "memoryRequestBytes": percentile(memory_samples, _MEMORY_REQUEST_WITHIN_PERCENTILE),
        "cpuPeakCores": max(cpu_samples) if peak_fallback else max(cpu_peak_samples),
        "memoryPeakBytes": max(memory_samples),
        "cpuPeakFallback": peak_fallback,
    }


def _distribution(values: list[float]) -> dict[str, float]:
    return {
        "p50": percentile(values, 50),
        "p95": percentile(values, 95),
        "max": max(values),
    }


def aggregate_sandbox_recommendations(
    sandboxes: list[dict[str, Any]],
    *,
    cohort_percentile: float,
    cpu_limit_ratio: float,
    cpu_limit_floor: str,
    memory_limit_ratio: float,
    memory_limit_floor: str,
    single_sandbox_filter: bool,
    schema_version: int,
    extra_warnings: list[str] | None = None,
) -> dict[str, Any]:
    """Equal-weight cohort recommendation from per-sandbox summaries."""
    minimum = 1 if single_sandbox_filter else _MIN_QUALIFIED_SANDBOXES
    if len(sandboxes) < minimum:
        raise RecommendationError(
            "INSUFFICIENT_DATA",
            f"Need at least {minimum} sandboxes with both CPU and memory samples; got {len(sandboxes)}",
        )

    cpu_requests = [float(row["cpuRequestCores"]) for row in sandboxes]
    mem_requests = [float(row["memoryRequestBytes"]) for row in sandboxes]
    cpu_peaks = [float(row["cpuPeakCores"]) for row in sandboxes]
    mem_peaks = [float(row["memoryPeakBytes"]) for row in sandboxes]
    mem_peak_dist = _distribution(mem_peaks)

    warnings = list(extra_warnings or [])
    if mem_peak_dist["p50"] <= 0:
        if mem_peak_dist["p95"] > 0:
            warnings.append("heterogeneous_cohort")
    elif mem_peak_dist["p95"] / mem_peak_dist["p50"] > _HETEROGENEOUS_PEAK_RATIO:
        warnings.append("heterogeneous_cohort")
    if any(row.get("cpuPeakFallback") for row in sandboxes):
        warnings.append("cpu_peak_fallback")

    resource = build_requests_limits(
        cpu_request_cores=percentile(cpu_requests, _CPU_COHORT_REQUEST_PERCENTILE),
        memory_request_bytes=percentile(mem_requests, cohort_percentile),
        cpu_limit_base_cores=percentile(cpu_peaks, cohort_percentile),
        memory_limit_base_bytes=percentile(mem_peaks, cohort_percentile),
        percentile=cohort_percentile,
        cpu_limit_ratio=cpu_limit_ratio,
        cpu_limit_floor=cpu_limit_floor,
        memory_limit_ratio=memory_limit_ratio,
        memory_limit_floor=memory_limit_floor,
    )
    per_sandbox = sorted(
        (
            {
                "sandboxId": row["sandboxId"],
                "cpuSampleCount": row["cpuSampleCount"],
                "memorySampleCount": row["memorySampleCount"],
                "cpuRequestCores": row["cpuRequestCores"],
                "memoryRequestBytes": row["memoryRequestBytes"],
                "cpuPeakCores": row["cpuPeakCores"],
                "memoryPeakBytes": row["memoryPeakBytes"],
            }
            for row in sandboxes
        ),
        key=lambda item: item["sandboxId"],
    )
    return {
        **resource,
        "schemaVersion": schema_version,
        "confidence": "low" if len(sandboxes) < _LOW_CONFIDENCE_BELOW else "ok",
        "warnings": warnings,
        "aggregation": "per_sandbox_percentile",
        "distribution": {
            "sandboxCountQualified": len(sandboxes),
            "cpuRequestCores": _distribution(cpu_requests),
            "memoryRequestBytes": _distribution(mem_requests),
            "cpuPeakCores": _distribution(cpu_peaks),
            "memoryPeakBytes": mem_peak_dist,
        },
        "perSandbox": per_sandbox,
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


def classify_sandbox_metrics(
    pod_names: list[str],
    cpu_by_pod: dict[str, list[tuple[float, float]]],
    mem_by_pod: dict[str, list[tuple[float, float]]],
    peak_by_pod: dict[str, list[tuple[float, float]]],
    start: datetime,
    end: datetime,
) -> dict[str, Any]:
    """Pick the first pod name that has both resources, else say why this sandbox is out."""
    saw_series = False
    saw_in_window = False
    for pod in pod_names:
        cpu_all = cpu_by_pod.get(pod) or []
        mem_all = mem_by_pod.get(pod) or []
        peak_all = peak_by_pod.get(pod) or []
        if cpu_all or mem_all or peak_all:
            saw_series = True
        cpu_samples = _values_in_interval(cpu_all, start, end)
        mem_samples = _values_in_interval(mem_all, start, end)
        peak_samples = _values_in_interval(peak_all, start, end)
        if cpu_samples or mem_samples or peak_samples:
            saw_in_window = True
        if len(cpu_samples) >= _MIN_SAMPLES_PER_SANDBOX and len(mem_samples) >= _MIN_SAMPLES_PER_SANDBOX:
            return {
                "pod": pod,
                "cpuSampleCount": len(cpu_samples),
                "memorySampleCount": len(mem_samples),
                **sandbox_usage_summary(cpu_samples, mem_samples, peak_samples),
            }
    if not saw_series:
        return {"excluded": "pod_name_unresolved"}
    if not saw_in_window:
        return {"excluded": "no_metrics_in_window"}
    return {"excluded": "partial_metrics"}


def _merge_pod_points(
    into: dict[str, dict[float, float]],
    extra: dict[str, list[tuple[float, float]]],
) -> None:
    for pod, points in extra.items():
        bucket = into.setdefault(pod, {})
        for ts, value in points:
            bucket[ts] = value


def _materialize_pod_points(
    acc: dict[str, dict[float, float]],
) -> dict[str, list[tuple[float, float]]]:
    return {pod: sorted(points.items()) for pod, points in acc.items() if points}


def _fetch_pods_batch_samples(
    client: httpx.Client,
    cfg: dict[str, Any],
    *,
    namespace: str,
    pod_names: list[str],
    query_start: datetime,
    query_end: datetime,
) -> tuple[
    dict[str, list[tuple[float, float]]],
    dict[str, list[tuple[float, float]]],
    dict[str, list[tuple[float, float]]],
]:
    if not pod_names:
        return {}, {}, {}
    mem_query = substitute_promql(cfg["memoryPromql"], namespace=namespace, pods=pod_names)
    cpu_query = substitute_promql(cfg["cpuPromql"], namespace=namespace, pods=pod_names)
    peak_template = str(cfg.get("cpuPeakPromql") or cfg["cpuPromql"])
    peak_query = substitute_promql(peak_template, namespace=namespace, pods=pod_names)
    base = cfg["prometheusUrl"]
    cpu_acc: dict[str, dict[float, float]] = {}
    peak_acc: dict[str, dict[float, float]] = {}
    mem_acc: dict[str, dict[float, float]] = {}

    for chunk_start, chunk_end in iter_prom_range_chunks(query_start, query_end):
        with ThreadPoolExecutor(max_workers=3) as mini:
            mem_future = mini.submit(
                _prometheus_query_range_by_pod, client, base, mem_query, chunk_start, chunk_end
            )
            cpu_future = mini.submit(
                _prometheus_query_range_by_pod, client, base, cpu_query, chunk_start, chunk_end
            )
            peak_future = mini.submit(
                _prometheus_query_range_by_pod, client, base, peak_query, chunk_start, chunk_end
            )
            _merge_pod_points(mem_acc, mem_future.result())
            _merge_pod_points(cpu_acc, cpu_future.result())
            _merge_pod_points(peak_acc, peak_future.result())
    return (
        _materialize_pod_points(cpu_acc),
        _materialize_pod_points(peak_acc),
        _materialize_pod_points(mem_acc),
    )


def _batches_for_namespace(
    entries: list[tuple[str, str, datetime, datetime]],
) -> list[list[tuple[str, str, datetime, datetime]]]:
    """Keep each Prometheus regex at or under ``_PODS_PER_PROM_BATCH`` pod names."""
    batches: list[list[tuple[str, str, datetime, datetime]]] = []
    current: list[tuple[str, str, datetime, datetime]] = []
    used = 0
    for entry in entries:
        cost = len(recommendation_pod_names(entry[0]))
        if current and used + cost > _PODS_PER_PROM_BATCH:
            batches.append(current)
            current = []
            used = 0
        current.append(entry)
        used += cost
    if current:
        batches.append(current)
    return batches


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

    cfg, headroom_warnings = get_resource_recommendation_runtime(settings)
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
    # (sandbox_id, namespace, interval_start, interval_end)
    sandbox_work: list[tuple[str, str, datetime, datetime]] = []
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
        sandbox_work.append((sid, ns, interval[0], interval[1]))

    by_namespace: dict[str, list[tuple[str, str, datetime, datetime]]] = defaultdict(list)
    for entry in sandbox_work:
        by_namespace[entry[1]].append(entry)

    batch_jobs: list[tuple[str, list[tuple[str, str, datetime, datetime]]]] = []
    for ns, entries in by_namespace.items():
        for batch in _batches_for_namespace(entries):
            batch_jobs.append((ns, batch))

    qualified: list[dict[str, Any]] = []
    excluded: list[dict[str, str]] = []

    with httpx.Client(timeout=_PROM_QUERY_TIMEOUT) as client:

        def _process_batch(
            namespace: str,
            batch_entries: list[tuple[str, str, datetime, datetime]],
        ) -> list[tuple[str, dict[str, Any]]]:
            pod_names = list(
                dict.fromkeys(name for entry in batch_entries for name in recommendation_pod_names(entry[0]))
            )
            cpu_by_pod, peak_by_pod, mem_by_pod = _fetch_pods_batch_samples(
                client,
                cfg,
                namespace=namespace,
                pod_names=pod_names,
                query_start=period_from,
                query_end=period_to,
            )
            out: list[tuple[str, dict[str, Any]]] = []
            for sid, _ns, start, end in batch_entries:
                classified = classify_sandbox_metrics(
                    recommendation_pod_names(sid),
                    cpu_by_pod,
                    mem_by_pod,
                    peak_by_pod,
                    start,
                    end,
                )
                out.append((sid, classified))
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
                    for sandbox_id_out, classified in batch_results:
                        if "excluded" in classified:
                            excluded.append({"sandboxId": sandbox_id_out, "reason": str(classified["excluded"])})
                            continue
                        qualified.append({"sandboxId": sandbox_id_out, **classified})
            except TimeoutError as exc:
                for pending in futures:
                    if not pending.done():
                        pending.cancel()
                raise RecommendationError(
                    "COMPUTE_TIMEOUT",
                    f"Resource recommendation timed out after {_COMPUTE_DEADLINE_SECONDS:.0f}s",
                ) from exc

    try:
        resource = aggregate_sandbox_recommendations(
            qualified,
            cohort_percentile=float(cfg.get("percentile") or 95),
            cpu_limit_ratio=float(cfg.get("cpuLimitRatio") or 1.2),
            cpu_limit_floor=str(cfg.get("cpuLimitFloor") or "100m"),
            memory_limit_ratio=float(cfg.get("memoryLimitRatio") or 1.15),
            memory_limit_floor=str(cfg.get("memoryLimitFloor") or "200Mi"),
            single_sandbox_filter=bool(sandbox_id and str(sandbox_id).strip()),
            schema_version=2,
            extra_warnings=headroom_warnings,
        )
    except RecommendationError:
        raise
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
        "sandboxCountWithMetrics": len(qualified),
        "sampleCount": {
            "cpu": sum(int(row["cpuSampleCount"]) for row in qualified),
            "memory": sum(int(row["memorySampleCount"]) for row in qualified),
        },
        "excludedSandboxes": excluded,
        **resource,
    }
