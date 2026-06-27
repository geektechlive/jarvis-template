"""Unit tests for graph._repair_node_resolutions (#792),
graph._repair_edge_duplicate (#794), graph._repair_edge_timestamps (#821),
and graph._repair_json_content (#756).

The resolution/duplicate/timestamps repairs are pure dict manipulation -- no graphiti,
Neo4j, or network required. The _repair_json_content tests need the
``json_repair`` library (the ``graph`` optional extra); they skip when it is
absent so the keep-list suite (which syncs groups but not extras) stays green.
"""

import importlib.util

import pytest

from harness.memory.graph import (
    _repair_edge_duplicate,
    _repair_edge_timestamps,
    _repair_node_resolutions,
)

# json_repair ships only with the `graph` extra (uv sync --extra graph). The
# keep-list `make check` does not install extras, so guard the repair tests.
needs_json_repair = pytest.mark.skipif(
    importlib.util.find_spec("json_repair") is None,
    reason="json_repair not installed (graph extra)",
)


class NodeResolutions:  # name is what the repair keys on
    pass


class EdgeDuplicate:
    pass


class EdgeTimestamps:
    pass


class SomethingElse:
    pass


def test_backfills_missing_required_fields() -> None:
    parsed = {"entity_resolutions": [{"id": 0}]}
    out = _repair_node_resolutions(parsed, NodeResolutions)
    assert out["entity_resolutions"] == [
        {"id": 0, "duplicate_candidate_id": -1, "name": ""}
    ]


def test_backfills_only_the_missing_field() -> None:
    parsed = {"entity_resolutions": [{"id": 1, "duplicate_candidate_id": 3}]}
    out = _repair_node_resolutions(parsed, NodeResolutions)
    item = out["entity_resolutions"][0]
    assert item["duplicate_candidate_id"] == 3  # preserved, not overwritten
    assert item["name"] == ""


def test_leaves_complete_items_untouched() -> None:
    complete = {"id": 2, "name": "Alex", "duplicate_candidate_id": -1}
    parsed = {"entity_resolutions": [dict(complete)]}
    out = _repair_node_resolutions(parsed, NodeResolutions)
    assert out["entity_resolutions"] == [complete]


def test_drops_items_missing_the_id_anchor() -> None:
    parsed = {"entity_resolutions": [{"name": "no id here"}, {"id": 5}]}
    out = _repair_node_resolutions(parsed, NodeResolutions)
    ids = [it["id"] for it in out["entity_resolutions"]]
    assert ids == [5]


def test_treats_null_valued_keys_as_missing() -> None:
    # Key present but null is the same under-fill as absent; both must be backfilled
    # so NodeResolutions(**parsed) does not reject the null.
    parsed = {"entity_resolutions": [{"id": 0, "duplicate_candidate_id": None, "name": None}]}
    out = _repair_node_resolutions(parsed, NodeResolutions)
    assert out["entity_resolutions"] == [
        {"id": 0, "duplicate_candidate_id": -1, "name": ""}
    ]


def test_drops_item_with_null_id() -> None:
    out = _repair_node_resolutions(
        {"entity_resolutions": [{"id": None, "name": "x"}, {"id": 4}]}, NodeResolutions
    )
    assert [it["id"] for it in out["entity_resolutions"]] == [4]


def test_preserves_a_real_zero_candidate_id() -> None:
    # 0 is a valid merge target -- `is None` must not treat it as missing.
    out = _repair_node_resolutions(
        {"entity_resolutions": [{"id": 1, "name": "Alex", "duplicate_candidate_id": 0}]},
        NodeResolutions,
    )
    assert out["entity_resolutions"][0]["duplicate_candidate_id"] == 0


def test_default_candidate_id_is_negative_one_never_zero() -> None:
    # -1 is the schema's "no duplicate" sentinel; 0 would wrongly merge into the
    # first candidate. This is the safety-critical default.
    out = _repair_node_resolutions({"entity_resolutions": [{"id": 0}]}, NodeResolutions)
    assert out["entity_resolutions"][0]["duplicate_candidate_id"] == -1


def test_noop_for_other_response_model() -> None:
    parsed = {"entity_resolutions": [{"id": 0}]}
    out = _repair_node_resolutions(parsed, SomethingElse)
    assert out == {"entity_resolutions": [{"id": 0}]}  # untouched


def test_noop_for_non_dict_parsed() -> None:
    assert _repair_node_resolutions(["not", "a", "dict"], NodeResolutions) == [
        "not",
        "a",
        "dict",
    ]


def test_noop_when_entity_resolutions_absent_or_wrong_type() -> None:
    assert _repair_node_resolutions({}, NodeResolutions) == {}
    assert _repair_node_resolutions(
        {"entity_resolutions": "oops"}, NodeResolutions
    ) == {"entity_resolutions": "oops"}


def test_handles_empty_list() -> None:
    assert _repair_node_resolutions(
        {"entity_resolutions": []}, NodeResolutions
    ) == {"entity_resolutions": []}


# --- #794: EdgeDuplicate coercion -------------------------------------------


def test_edge_bare_list_becomes_empty_lists() -> None:
    # A top-level list (the reported crash: EdgeDuplicate(**list)) -> conservative
    # "no duplicates, no contradictions".
    out = _repair_edge_duplicate([0, 1, 2], EdgeDuplicate)
    assert out == {"duplicate_facts": [], "contradicted_facts": []}


def test_edge_empty_list_becomes_empty_lists() -> None:
    out = _repair_edge_duplicate([], EdgeDuplicate)
    assert out == {"duplicate_facts": [], "contradicted_facts": []}


def test_edge_unwraps_single_dict_wrapped_in_list() -> None:
    out = _repair_edge_duplicate(
        [{"duplicate_facts": [1], "contradicted_facts": [2]}], EdgeDuplicate
    )
    assert out == {"duplicate_facts": [1], "contradicted_facts": [2]}


def test_edge_unwrapped_dict_still_backfills_missing_field() -> None:
    out = _repair_edge_duplicate([{"duplicate_facts": [1]}], EdgeDuplicate)
    assert out == {"duplicate_facts": [1], "contradicted_facts": []}


def test_edge_backfills_missing_fields_on_dict() -> None:
    assert _repair_edge_duplicate({}, EdgeDuplicate) == {
        "duplicate_facts": [],
        "contradicted_facts": [],
    }


def test_edge_resets_non_list_field_values() -> None:
    out = _repair_edge_duplicate(
        {"duplicate_facts": None, "contradicted_facts": "oops"}, EdgeDuplicate
    )
    assert out == {"duplicate_facts": [], "contradicted_facts": []}


def test_edge_leaves_a_valid_payload_untouched() -> None:
    valid = {"duplicate_facts": [0, 3], "contradicted_facts": [5]}
    assert _repair_edge_duplicate(dict(valid), EdgeDuplicate) == valid


def test_edge_multi_element_list_is_not_unwrapped() -> None:
    # Two dicts -> ambiguous -> conservative empty (do not guess which one).
    two = [
        {"duplicate_facts": [1], "contradicted_facts": []},
        {"duplicate_facts": [2], "contradicted_facts": []},
    ]
    assert _repair_edge_duplicate(two, EdgeDuplicate) == {
        "duplicate_facts": [],
        "contradicted_facts": [],
    }


def test_edge_scalar_or_null_becomes_empty_lists() -> None:
    # A top-level scalar/null (another off-shape failure mode) must also not crash
    # EdgeDuplicate(**parsed).
    for bad in (42, "oops", True, None):
        assert _repair_edge_duplicate(bad, EdgeDuplicate) == {
            "duplicate_facts": [],
            "contradicted_facts": [],
        }


def test_edge_noop_for_other_response_model() -> None:
    assert _repair_edge_duplicate([1, 2], NodeResolutions) == [1, 2]


def test_node_repair_noop_for_edge_model() -> None:
    # The two repairs must not interfere with each other's model.
    assert _repair_node_resolutions({"entity_resolutions": [{"id": 0}]}, EdgeDuplicate) == {
        "entity_resolutions": [{"id": 0}]
    }


# --- #821: EdgeTimestamps coercion -------------------------------------------


def test_timestamps_bare_list_becomes_empty_dict() -> None:
    # The reported crash: EdgeTimestamps(**list) -> conservative "no timestamps".
    out = _repair_edge_timestamps(["2024-01-01", "2024-06-01"], EdgeTimestamps)
    assert out == {}


def test_timestamps_empty_list_becomes_empty_dict() -> None:
    out = _repair_edge_timestamps([], EdgeTimestamps)
    assert out == {}


def test_timestamps_single_dict_in_list_is_unwrapped() -> None:
    out = _repair_edge_timestamps(
        [{"valid_at": "2024-01-01", "invalid_at": None}], EdgeTimestamps
    )
    assert out == {"valid_at": "2024-01-01", "invalid_at": None}


def test_timestamps_scalar_becomes_empty_dict() -> None:
    for bad in (42, "oops", True, None):
        assert _repair_edge_timestamps(bad, EdgeTimestamps) == {}


def test_timestamps_valid_dict_passes_through_untouched() -> None:
    valid = {"valid_at": "2024-01-01T00:00:00Z", "invalid_at": None}
    assert _repair_edge_timestamps(dict(valid), EdgeTimestamps) == valid


def test_timestamps_non_string_fields_reset_to_none() -> None:
    # Model returned an integer or list for a timestamp field -> coerce to None.
    out = _repair_edge_timestamps(
        {"valid_at": 1234567890, "invalid_at": ["bad"]}, EdgeTimestamps
    )
    assert out == {"valid_at": None, "invalid_at": None}


def test_timestamps_noop_for_other_response_model() -> None:
    payload = ["2024-01-01"]
    assert _repair_edge_timestamps(payload, SomethingElse) == payload
    assert _repair_edge_timestamps(payload, EdgeDuplicate) == payload
    assert _repair_edge_timestamps(payload, NodeResolutions) == payload


# --- _repair_json_content: json-repair helper (issue #756) --------------------


@needs_json_repair
def test_repair_json_content_valid_json_returns_parsed() -> None:
    from harness.memory.graph import _repair_json_content
    assert _repair_json_content('{"key": "value"}') == {"key": "value"}


@needs_json_repair
def test_repair_json_content_missing_comma_repaired() -> None:
    from harness.memory.graph import _repair_json_content
    result = _repair_json_content('{"a": 1 "b": 2}')
    assert result == {"a": 1, "b": 2}


@needs_json_repair
def test_repair_json_content_unterminated_string_repaired() -> None:
    from harness.memory.graph import _repair_json_content
    result = _repair_json_content('{"entities": [{"name": "Alex Example", "type": "Per')
    assert result is not None
    assert "entities" in result


@needs_json_repair
def test_repair_json_content_empty_string_returns_none() -> None:
    from harness.memory.graph import _repair_json_content
    assert _repair_json_content("") is None


@needs_json_repair
def test_repair_json_content_whitespace_only_returns_none() -> None:
    from harness.memory.graph import _repair_json_content
    assert _repair_json_content("   ") is None


@needs_json_repair
def test_repair_json_content_fence_only_returns_none() -> None:
    from harness.memory.graph import _repair_json_content
    assert _repair_json_content("```json\n") is None


@needs_json_repair
def test_repair_json_content_fence_wrapped_json_repaired() -> None:
    from harness.memory.graph import _repair_json_content
    result = _repair_json_content('```json\n{"key": "value"}\n```')
    assert result == {"key": "value"}
