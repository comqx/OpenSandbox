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

# 默认官方镜像；内网：--build-arg NODE_IMAGE=... --build-arg NGINX_IMAGE=...
# npm 官方源超时时可改回：--build-arg NPM_REGISTRY=https://registry.npmjs.org
# 平台由 buildx --platform linux/amd64 指定
ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginx:1.27-alpine

FROM ${NODE_IMAGE} AS build
ARG NPM_REGISTRY=https://registry.npmmirror.com
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --registry="${NPM_REGISTRY}" --fetch-retries=5 --fetch-timeout=300000
COPY . .
RUN npm run build

# 第二个 FROM 前必须单独声明 ARG（不可写在 build 阶段的 RUN 之后仍指望作用于 FROM）
ARG NGINX_IMAGE
FROM ${NGINX_IMAGE}
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
