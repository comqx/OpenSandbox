// Copyright 2026 The OpenSandbox Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

/** Link to申请历史 with optional usage-period filter (same as /history/usage). */
export function historySandboxesPath(opts: {
  from?: string;
  to?: string;
  tenant?: string;
  /** Keep the history page on all records. Omitting dates otherwise opens as the current month. */
  allTime?: boolean;
}): string {
  const params = new URLSearchParams();
  if (opts.allTime) {
    params.set('period', 'all');
  } else {
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);
  }
  if (opts.tenant) params.set('tenant', opts.tenant);
  const qs = params.toString();
  return `/history/sandboxes${qs ? `?${qs}` : ''}`;
}

/** Link to用量分摊 with the same UTC window the overview is showing. */
export function historyUsagePath(opts: { from: string; to: string; tenant?: string }): string {
  const params = new URLSearchParams({ from: opts.from, to: opts.to });
  if (opts.tenant) params.set('tenant', opts.tenant);
  return `/history/usage?${params}`;
}
