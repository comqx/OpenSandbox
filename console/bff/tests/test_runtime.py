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

from datetime import datetime, timezone

from app.runtime import attach_runtime_summary


def test_wall_clock_stops_at_expires_at_while_state_is_still_running():
    now = datetime(2026, 10, 9, 1, 0, tzinfo=timezone.utc)
    sandbox = {
        "createdAt": "2026-10-09T00:00:00Z",
        "expiresAt": "2026-10-09T00:10:00Z",
        "status": {"state": "Running"},
    }

    result = attach_runtime_summary(sandbox, now=now)

    assert result["status"]["state"] == "Terminated"
    assert result["status"]["reason"] == "SANDBOX_EXPIRED"
    assert result["status"]["lastTransitionAt"] == "2026-10-09T00:10:00Z"
    assert sandbox["status"]["state"] == "Running"
    assert result["runtimeSummary"]["wallClockSeconds"] == 600
    assert result["runtimeSummary"]["remainingSeconds"] == 0


def test_wall_clock_keeps_growing_before_expiry():
    now = datetime(2026, 10, 9, 0, 5, tzinfo=timezone.utc)
    sandbox = {
        "createdAt": "2026-10-09T00:00:00Z",
        "expiresAt": "2026-10-09T00:10:00Z",
        "status": {"state": "Running"},
    }

    result = attach_runtime_summary(sandbox, now=now)

    assert result["status"]["state"] == "Running"
    assert result["runtimeSummary"]["wallClockSeconds"] == 300
    assert result["runtimeSummary"]["basis"] == "createdAt"


def test_expired_non_running_state_is_left_unchanged():
    now = datetime(2026, 10, 9, 1, 0, tzinfo=timezone.utc)
    sandbox = {
        "createdAt": "2026-10-09T00:00:00Z",
        "expiresAt": "2026-10-09T00:10:00Z",
        "status": {"state": "Failed", "reason": "TASK_FAILED"},
    }

    result = attach_runtime_summary(sandbox, now=now)

    assert result["status"]["state"] == "Failed"
    assert result["status"]["reason"] == "TASK_FAILED"
