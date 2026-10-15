"""Offline smoke tests. No network, so they're safe in CI."""

import json

import pytest
from jsonschema import ValidationError

from pitwall import fetch_race
from pitwall.cache import enable_cache
from pitwall.paths import REPO_ROOT, TRACK_SCHEMA
from pitwall.schema import validate_track

FIXTURE = REPO_ROOT / "engine" / "test" / "fixtures" / "track.synthetic.json"


def test_schema_is_shared_with_engine():
    assert TRACK_SCHEMA.is_file()
    assert TRACK_SCHEMA.parent.parent.name == "engine"


def test_engine_fixture_validates_in_python():
    # Same schema, same fixture, both languages: the cross-language contract check.
    validate_track(json.loads(FIXTURE.read_text()))


def test_schema_rejects_bad_doc():
    doc = json.loads(FIXTURE.read_text())
    doc["tyres"]["S"]["degRate"] = -1
    with pytest.raises(ValidationError):
        validate_track(doc)


def test_cache_enables(tmp_path):
    assert enable_cache(tmp_path / "ff1").is_dir()


def test_fetch_race_cli_parses():
    assert callable(fetch_race.main)
    assert fetch_race.TRACK_STATUS["4"] == "sc"
