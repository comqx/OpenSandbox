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

export const BUILD_IMAGE_PREFIX = 'hub.glodon.com/glodon-pub/';

const IMAGE_NAME = /^[A-Za-z0-9._:/-]{1,255}$/;

export function imageSuffixFromInput(value: string): string {
  let rest = value.trim();
  if (rest.startsWith(BUILD_IMAGE_PREFIX)) {
    rest = rest.slice(BUILD_IMAGE_PREFIX.length);
  }
  return rest.replace(/^\/+/, '');
}

export function composeBuildImageName(suffix: string): string {
  return `${BUILD_IMAGE_PREFIX}${imageSuffixFromInput(suffix)}`;
}

export function buildImageNameError(suffix: string): string | null {
  const rest = imageSuffixFromInput(suffix);
  if (!rest) {
    return '镜像名称不能为空';
  }
  const imageName = `${BUILD_IMAGE_PREFIX}${rest}`;
  if (!IMAGE_NAME.test(imageName) || imageName.includes('..')) {
    return '镜像名称不合法';
  }
  return null;
}
