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

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.deps import get_session_payload
from app.image_catalog import ImageCatalogError, actor_label, create_image, delete_image, list_images, update_image

router = APIRouter(prefix="/images/catalog", tags=["images"])


def _catalog_error(exc: ImageCatalogError) -> HTTPException:
    return HTTPException(
        status_code=exc.status_code,
        detail={"code": exc.code, "message": exc.message},
    )


@router.get("")
async def get_catalog(payload: dict = Depends(get_session_payload)) -> dict[str, Any]:
    del payload
    return list_images()


@router.post("", status_code=status.HTTP_201_CREATED)
async def post_catalog(body: dict[str, Any], payload: dict = Depends(get_session_payload)) -> dict[str, Any]:
    try:
        return create_image(body, actor_label(payload))
    except ImageCatalogError as exc:
        raise _catalog_error(exc) from exc


@router.patch("/{image_id}")
async def patch_catalog(
    image_id: str,
    body: dict[str, Any],
    payload: dict = Depends(get_session_payload),
) -> dict[str, Any]:
    try:
        return update_image(image_id, body, actor_label(payload))
    except ImageCatalogError as exc:
        raise _catalog_error(exc) from exc


@router.delete("/{image_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_catalog(image_id: str, payload: dict = Depends(get_session_payload)) -> Response:
    del payload
    try:
        delete_image(image_id)
    except ImageCatalogError as exc:
        raise _catalog_error(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
