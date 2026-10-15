import json
from typing import Any

from jsonschema import Draft202012Validator

from .paths import TRACK_SCHEMA


def load_track_schema() -> dict[str, Any]:
    return json.loads(TRACK_SCHEMA.read_text())


def validate_track(doc: dict[str, Any]) -> None:
    """Raise jsonschema.ValidationError if doc breaks the engine contract."""
    Draft202012Validator(load_track_schema()).validate(doc)
