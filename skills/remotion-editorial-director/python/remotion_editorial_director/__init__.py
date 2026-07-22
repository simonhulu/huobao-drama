"""Provider-neutral editorial analysis primitives for Remotion workflows."""

from .core import build_coverage, canonical_digest, non_max_suppression, parse_srt

__all__ = [
    "build_coverage",
    "canonical_digest",
    "non_max_suppression",
    "parse_srt",
]

__version__ = "0.1.0"
