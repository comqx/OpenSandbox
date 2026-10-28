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

import type { PlatformGrafanaSettings, ResourceRecommendationSettings } from '../api/types';

function withoutSchemaVersion(
  value: ResourceRecommendationSettings | undefined,
): ResourceRecommendationSettings | undefined {
  if (!value) return undefined;
  const { schemaVersion: _schemaVersion, ...rest } = value;
  return rest;
}

/** Fields registered on the active tab, plus recommendation values held only in the form store. */
export function platformSettingsSavePayload(
  validated: PlatformGrafanaSettings,
  stored: PlatformGrafanaSettings,
): PlatformGrafanaSettings {
  const { persisted: _persisted, source: _source, ...validatedFields } = validated;
  const { persisted: _storedPersisted, source: _storedSource, resourceRecommendation: _storedRec, ...storedFields } =
    stored;
  return {
    ...storedFields,
    ...validatedFields,
    resourceRecommendation: {
      ...withoutSchemaVersion(stored.resourceRecommendation),
      ...withoutSchemaVersion(validated.resourceRecommendation),
    },
  };
}
