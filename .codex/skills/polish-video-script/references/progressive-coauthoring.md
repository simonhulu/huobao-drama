# Progressive Coauthoring Protocol

Use this reference for every V2 interaction. The unit of authorization is one semantic stage.

## 1. Core Rule

AI may prepare research and structure in the background. It may produce publishable prose only for
the single stage the creator has explicitly authorized.

The creator may ask questions, edit, replace, reject, reopen, or stop at any time. None of these
actions silently authorizes later prose.

## 2. State Sequence

```text
INTAKE_PENDING
  -> AWAIT_TOPIC                  # creator answered 无原稿; mode = generate
  -> ORIGINAL_STORED              # creator answered 有原稿; mode = transplant
       -> AWAIT_TOPIC
  -> TOPIC_CONFIRMED
  -> AUTOPSY_READY                # original mode only
  -> SEARCH_RUNNING               # generate mode goes here directly
  -> MATERIALS_READY
  -> CONTRACT_PROPOSED
  -> CONTRACT_LOCKED
  -> MAP_PROPOSED
  -> MAP_LOCKED
  -> AWAIT_STAGE_PERMISSION(S1)
  -> STAGE_ACTIVE(S1)
  -> AWAIT_CREATOR(S1)
       -> STAGE_ACTIVE(S1)       # question/edit/retry/replace
       -> STAGE_LOCKED(S1)       # explicit final instruction
  -> AWAIT_STAGE_PERMISSION(S2)
  -> ...
  -> ASSEMBLED
  -> AUDIT_RUNNING
       -> REOPEN_PROPOSED -> creator unlock -> revision/revalidation
       -> AUDITED_CANDIDATE
  -> AWAIT_FINAL_ACK
  -> PUBLISH_READY
```

Any later text, contract, map, source, or Creator Bible change invalidates candidate/audit hashes
and routes to the earliest affected state.

## 3. Separate Creator Events

Persist distinct events:

- `topic_confirm`
- `contract_lock`
- `map_lock`
- `stage_activate`
- `stage_lock`
- `stage_unlock`
- `map_unlock`
- `contract_unlock`
- `stage_revalidate`
- `final_ack`

A lock event cannot double as an activation event. After locking a stage, the assistant must ask
whether it may enter the next named stage. The next draft requires a later creator activation event.

The first creator input must answer whether an original exists. Persist that answer and set
`mode` to `transplant` or `generate`. In transplant mode, store the breakout original first, ask
for the new topic in the next turn, and do not run the original structure dissection or search
until the creator gives an unambiguous topic. Complete the original structure dissection, violent
search, and fact curation before proposing the creative contract. In generate mode, skip
`ORIGINAL_STORED` and `AUTOPSY_READY`: after the creator confirms the topic, run search and fact
curation directly, then propose the creative contract. `AUTOPSY_READY` is an internal state label;
display it to the creator as `原稿解剖完成`.

## 4. What Counts As Explicit

These can lock exact text:

- `这版定稿`
- `就按这版锁定`
- `定稿：<creator text>`
- another unambiguous statement that the current version is final

These do not lock:

- a pasted rewrite without final language;
- `这里再狠一点`;
- a question;
- criticism;
- silence;
- approval of one sentence rather than the whole stage.

If meaning is ambiguous, ask one short confirmation. Do not guess.

## 5. Stage Contract Before Draft

Create this contract before writing prose:

```yaml
stage_job: ""
audience_belief_before: ""
audience_belief_after: ""
main_hole_relation: open|shrink|deepen|reverse|raise_stakes|pay
subholes_opened: []
subholes_paid: []
primary_driver: 山|海|墓|色
evidence_ids: []
creator_decision_needed: null
must_preserve: []
intentionally_unpaid: ""
upstream_locked_hashes: []
downstream_constraints: []
```

`creator_decision_needed` contains at most one high-leverage judgment. Leave it null when there is
no real fork. Never invent a question merely to simulate collaboration.

## 6. Teaching Card

Write the current-stage candidate and show it with three compact reasons:

```text
当前阶段：<name>
这段要完成：<stage job>

初稿：
<current stage only>

为什么这样写：
- 缺口/情绪：<specific missing information or desired experience>
- 理论依据：<specific Li Mola principle applied to this material>
- 结构作用：<belief before -> after; main-hole relation>

你可以直接改写、指出问题、要求重做，或明确确认这段定稿。
```

Do not show future prose, long feature instructions, or a menu of near-identical variants.

## 7. Revision Behavior

- Answer theory questions without advancing.
- On a narrow change request, modify only the current stage.
- Show the diff and the updated current-stage text; do not replay the full history.
- Preserve creator wording exactly unless the creator asks for polishing.
- Record every draft version with actor, reason, text hash, and parent hash.
- Update `downstream_constraints` when the creator changes meaning, motive, stance, or promise.

## 8. Lock Behavior

On explicit lock:

1. save exact `locked_text`;
2. calculate SHA-256 `locked_hash`;
3. create a creator `stage_lock` event whose `content_hash` matches;
4. echo the locked text once;
5. state one important downstream constraint;
6. ask `可以进入下一阶段「<name>」吗？`;
7. stop.

Do not include the next draft in this turn.

## 9. Reopen And Invalidate

When the creator reopens an earlier stage:

- keep the old locked version as history;
- mark any unapproved later draft `STALE_DRAFT`;
- mark dependent locked stages `NEEDS_REVALIDATION`;
- show the impact list;
- revise the requested stage;
- revisit affected stages in dependency order;
- reassemble and rerun stale audits.

Changing the contract invalidates map and prose assumptions. Changing the map invalidates affected
stage ordering and dependencies. Neither change may be treated as a local wording edit.

## 10. Assembly

Final spoken text is:

```text
locked_stage_1 + "\n\n" + locked_stage_2 + ...
```

Assembly may not add headings, transitions, punctuation, summaries, or a final polish. If a bridge
is needed, reopen an adjacent stage and let the creator lock it.

After assembly, build the estimated attention timeline and run the retention and comment/share
auditors described in `prepublish-diagnostics.md`. Both reports must bind the exact assembly hash.
They report qualitative `pass`, `risk`, or `block` findings only; they never invent platform rates.
Any finding that requires a text change follows the normal unlock and revalidation path.

## 11. Audit Repair

Auditors have read-only access. A finding contains:

- risk type;
- evidence;
- affected stage;
- why it matters;
- minimal patch proposal;
- audits that become stale if changed.

The creator decides whether to unlock. A locked claim can still fail truth review; locking proves
authorship, not factual correctness.

## 12. Interaction-time Discipline

Count required intake, reading, edits, questions, locks, advance confirmations, audit decisions,
and audit-triggered revisions. Do not count AI search/execution wait or explicit pauses.

If the run risks exceeding ten active minutes, shorten explanations and stage display. Never merge
lock with activation, skip author review, remove needed facts, or prewrite the remainder.
