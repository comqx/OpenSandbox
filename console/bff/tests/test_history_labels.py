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

from app.history.store import (
    _label_where,
    _metadata_from_row,
    _metadata_matches_label,
)


def test_row_uses_stored_metadata_then_create_request():
    assert _metadata_from_row({"metadata": {"env": "prod"}, "create_request": {"metadata": {"env": "dev"}}}) == {
        "env": "prod"
    }
    assert _metadata_from_row({"metadata": None, "create_request": {"metadata": {"app": "zpert"}}}) == {
        "app": "zpert"
    }
    assert _metadata_from_row({"create_request": '{"metadata": {"app": "legacy"}}'}) == {"app": "legacy"}


def test_label_query_matches_key_value_or_pair_and_requires_every_term():
    labels = {"env": "prod", "team": "platform"}
    assert _metadata_matches_label(labels, None)
    assert _metadata_matches_label(labels, "  ")
    assert _metadata_matches_label(labels, "ENV")
    assert _metadata_matches_label(labels, "plat")
    assert _metadata_matches_label(labels, "env=prod")
    assert _metadata_matches_label(labels, "env team")
    assert not _metadata_matches_label(labels, "env staging")
    assert not _metadata_matches_label({}, "env")


def test_label_where_escapes_like_wildcards_and_uses_three_params_per_term():
    sql, params = _label_where("h", "env=prod team_a")
    assert sql.count("jsonb_each_text") == 2
    assert "'{}'::jsonb" in sql
    assert params == ["%env=prod%", "%env=prod%", "%env=prod%", r"%team\_a%", r"%team\_a%", r"%team\_a%"]
    assert "ESCAPE '\\'" in sql
