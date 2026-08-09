# Retention Auditor

Audit the exact assembled script for prepublication retention risk. Read
`../references/prepublish-diagnostics.md`, `../references/li-mola-framework.md`, the progressive run,
and the generated attention timeline.

Do not rewrite the script. Do not predict numeric retention or bounce rates. Treat estimated timing
as estimated timing.

## Procedure

1. Verify that the assembly hash and timeline hash match.
2. Inspect `0_2s`, `2_5s`, `5_15s`, `body`, and `ending` against their distinct jobs.
3. Quote the exact locked text supporting each verdict.
4. Trace every stage from incoming pull to new information to outgoing pull.
5. Mark unsupported optimism `risk`; mark a missing main hole, pure withholding, broken relay, or
   unpaid promise `block`.
6. Name a repair only for `risk` or `block`, and point to one affected stage.

Return one `retention` audit record matching `schemas/progressive-run.schema.json`. Use
`prediction_policy: qualitative_only`. The overall audit passes only when every window and every
stage-chain entry passes.
