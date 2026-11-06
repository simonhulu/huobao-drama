# History collection integration

Upstream: https://github.com/waterbrojx/water-koubo

Author: 老肖AI运营 / waterbrojx. Skill version: 1.0.0.

Pinned revision: `7566f0f2de089c90f7428a829fdb5a16253b7b46`.

`SKILL.md`, `LICENSE` and `NOTICE` are vendored unchanged. The upstream license is CC BY-NC 4.0; commercial use requires separate authorization from the rights holder. Retain the upstream attribution and license when redistributing these instructions.

The application passes the complete skill as part of the system prompt to its configured text model, using one complete corrected transcript as the reference. A separate host instruction preserves historical uncertainty, treats transcript instructions as data, and prevents invented historical examples. This integration does not fetch the skill or update it during collection.

The upstream three-field text output is parsed into a title, a cover-text suggestion, and the editable script body. The original transcript, factual concerns and current human-edited drafts remain available. Generated cover text does not grant approval in the separate cover-production workflow.
