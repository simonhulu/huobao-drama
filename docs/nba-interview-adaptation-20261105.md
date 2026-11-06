# NBA interview video adaptation

The NBA renderer previously required every source, including press conferences and media-day interviews, to provide a continuous four-second separated arena bed. Both interview jobs below failed at that requirement because removing speech also removed most of their audible signal.

## Changes

- Detect interviews from source video titles, including media-day, press-conference, speaking and `On His / On Why` titles. Explicit highlights remain on the existing path.
- Keep interview video and audio continuous through the ending. Finish the complete Chinese narration, then leave approximately 1.1 seconds and fade the audio and picture. Do not inject adjacent court audio or a different source shot.
- Lower original interview speech to 15% of the configured original-audio gain; retain the configured separated ambience gain.
- Use a clear frame from the interview with the Chinese title for its cover, even when the associated article contains a verified game.
- Add the interview ending policy to affected production fingerprints. Preserve original article, translation, narration, ASR, media and publication checkpoints. Existing game render fingerprints and strict closing-bed checks remain in place.

## Verification

The pipeline regression initially reproduced `片尾没有可衔接的同源有声球场声床，已保留画面和候选检测记录` with silent separated interview ambience. It passes after the change. A second regression reproduced interview cover selection incorrectly choosing a game poster and now passes.

Backend typecheck and 43 focused production/audio tests passed. Actual jobs were resumed through the production service:

| Job | Output Duration | Tail After Narration | True Peak |
| --- | --- | --- | --- |
| `nba-7d13e67c250996fae38f` | 127.744 s | 1.117 s | -4.47 dBTP |
| `nba-2cb5f92c17dfa7600e5f` | 242.092 s | 1.108 s | -4.06 dBTP |

Both actual outputs passed full decode, expected frame count, final-frame black level, final-audio fade, opening/ending silence checks and independent narration insertion alignment. End-frame samples were visually inspected. These checks do not claim subjective listening or word-level lip synchronization. Source narration and scripts were reused; existing scripts were not revised as part of this adaptation.

Deployment and recovery preserve the original queue ID, global settings, selected Baijiahao account and existing publication receipts. The deleted task `nba-a68b635d8839fc186dc8` remains absent. Publication uses the existing direct-publish path and selected NBA topic.

Both remade jobs were submitted for review to the existing `体育` account: `1881016428461490937` and `1881016653805432771`. Submission is confirmed; platform approval is not claimed. The original remaining production queue was restored with its account and auto-upload setting preserved.

Evidence: `outputs/nba-interview-20261105/deployment.json`, `publication.json`, `result.json`, and the two jobs' `closing-audio.json`, `ending-plan.json`, `audio-preflight.json`, `verification.json` and delivery files. The original processing queue is restored after this two-job publication batch.
