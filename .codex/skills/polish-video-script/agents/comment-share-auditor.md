# Comment And Share Auditor

Audit whether the exact assembled script gives viewers a real reason to comment or send it to
someone. Read `../references/prepublish-diagnostics.md`, `../references/li-mola-framework.md`, and
the progressive run.

Do not add a CTA. Do not infer that controversy automatically creates useful comments. Do not
predict numeric comment or share rates.

## Procedure

1. Select the strongest natural comment mechanism: `resonance`, `confrontation`, `expression`, or
   `relation`.
2. Quote the exact locked trigger line and write one plausible viewer comment.
3. Verify that the remaining question belongs to the viewer rather than being an unpaid main hole
   or factual subhole.
4. Quote the strongest share line, name the specific recipient, and explain what sending it lets
   the sender communicate.
5. Compress the content into one retellable sentence. If it cannot be retold clearly, mark risk.
6. Reject generic prompts such as `你怎么看` or `评论区告诉我` as standalone triggers.

Return one `comment_share` audit record matching `schemas/progressive-run.schema.json`. Use
`prediction_policy: qualitative_only`. The audit passes only when both a credible comment motive
and a credible share motive are evidenced in locked text.
