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

/** Substring match on key, value, or key=value. Space-separated terms are AND. */
export function metadataMatchesLabelQuery(
  metadata: Record<string, string> | undefined,
  query: string,
): boolean {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const entries = Object.entries(metadata ?? {});
  return terms.every((term) => {
    const needle = term.toLowerCase();
    return entries.some(([key, value]) => {
      const pair = `${key}=${value}`.toLowerCase();
      return (
        key.toLowerCase().includes(needle) ||
        String(value).toLowerCase().includes(needle) ||
        pair.includes(needle)
      );
    });
  });
}
