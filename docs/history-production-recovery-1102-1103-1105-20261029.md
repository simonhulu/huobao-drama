# History production recovery: 1102, 1103, 1105

## Causes and repairs

- Episode 1102 (`彭德怀和刘伯承的用兵差异巨大`): Whisper returned
  traditional Chinese while the locked script used simplified Chinese. The
  global text mismatch rejected all 107 boundaries. ICU writing-system
  normalization now applies only to matching, preserving source positions,
  original captions, and the raw recognition evidence.
- Episode 1105 (`郑和下西洋竟是为了找他？`): two classical quotations
  contained ASR homophones. Recovery requires continuous complete mapping,
  an exact neighboring anchor, two exact final characters, matching readings,
  a complete token, and a measured pause. Ordinary match thresholds remain
  unchanged. Missing speech, unrelated text, and coarse internal cuts still fail.
- Episode 1103 (`蒋介石退到重庆真能打的还有多少`): shot-54's generation
  record 25853 returned an explicit temporary upstream 502. The old checkpoint
  only allowed 429 to retry. Explicit temporary 502/503 rejections now retry
  on the same record, at most three submissions per recovery invocation,
  with 2/4-second delays. Existing task IDs only resume; ambiguous gateways,
  network timeouts, and unknown accepted requests cannot resubmit.
- Live recovery encountered a newer explicit capacity 503:
  `No available compatible accounts`. This rejection now receives the same
  bounded retry treatment and a readable capacity message when exhausted.
  Software retries cannot supply missing upstream accounts.
- Pending upstream task errors previously lost their recovery code in the
  outer shot error wrapper. That code now reaches the queue's existing
  automatic continuation handler. A regression test advances the timer and
  verifies the completed image and narration are not recreated.

## Real cache verification

| Episode | Shots | Measured internal ends | Captions | Frames | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1102 | 108 | 107 / 107 | 140 | 14823 | 494.1 |
| 1105 | 116 | 115 / 115 | 159 | 16782 | 559.4 |

1105 shot-89 ends at 428740 ms (confidence 0.54545); shot-101 ends at
486440 ms (confidence 0.58065). Confidence is retained, not raised to pass.
Every frame cut is at or after its measured boundary, timestamps are monotonic,
and caption text reproduces the locked narration. These are ASR estimates;
no human listening or phoneme-level forced alignment is claimed.

The maintenance command `backend/scripts/history-motion-recover-audio.ts`
defaults to verification. Its explicit `--apply` mode saves a before snapshot
and updates only an inactive unfinished original job using compare-and-swap.
Both affected episodes received their verified checkpoints without regenerating
audio or recognition. Backups and detailed reports are in
`data/reports/history-audio-recovery-1102/` and
`data/reports/history-audio-recovery-1105/`.

Both episodes passed their former narration failure and entered asset selection
on the real queue. The updated backend was loaded at a saved selection checkpoint
with no active history render; original interrupted queue entries were resumed.
The original job IDs and completed artifacts were retained. This records
production recovery, not completed new movies or a healthy upstream supplier.

## Checks

67 focused tests passed across audio alignment, production, image assets, and
image checkpoints. The image tests launch the actual worker subprocess against
a local HTTP provider to verify explicit 502/capacity 503 recovery, retry limits,
unknown-result protection, and completed-file reuse. Backend typecheck and
targeted diff checks passed. ICU uconv is already installed locally; configure
`HISTORY_ALIGNMENT_UCONV` elsewhere or retain strict matching when unavailable.
