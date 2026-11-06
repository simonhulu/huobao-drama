# NBA quality incident: polluted article bodies and repeated footage

The user reported five rejected posts for the 2026-11-02 Warriors 116-113 Suns game. The reported platform outcome is retained as a user report; the incident work does not claim to have independently read the platform rejection reason.

## Confirmed causes

- All five use YouTube source `8K-SL92pXR0` and the same arena audio bed. Their Chinese narration files have five different hashes. Their cover files also differ, but use the same two player photographs and poster template.
- Sina body extraction selected an outer article wrapper that included recommendations and the page footer. Each narration consequently contains approximately 106-123 seconds of non-reporting text.
- Each old video has approximately 3.52-3.54 seconds of continuous ending silence. Its selected source closing picture is a silent scoreboard. The silence starts well before the intended final one-second fade.
- Measured TTS insertion is 120 ms in all five, matching the plan. This establishes technical insertion timing only, not semantic correspondence between a report and an individual possession.

Original measurements and ten playable opening/ending samples are in `outputs/nba-quality-incident-20261105/audit.md` and `audit.json`. Original job backups and the nine-record cleanup report are in the same directory. Keep those pre-repair audit files unchanged.

## Changes

- `backend/src/services/nba-article-body.ts` selects bounded DOM article bodies with the existing `linkedom` parser, prioritizes Sina's nested article container, and removes non-reporting website modules. Structured article bodies use the same cleaner. Minimum story lengths apply after cleaning. News wording and facts are not rewritten or fact-reviewed.
- `nba-news.ts` uses the cleaner at intake. `nba-production.ts` and `nba-upload.ts` also reject contaminated saved text before TTS, cache reuse or publication.
- `nba-content-identity.ts` and `nba-video.ts` deduplicate by source video across languages and different news URLs at intake, production and publication. Separate interviews with different video IDs remain eligible. An original uncertain submission can reconcile its receipt; a sibling cannot create another submission.
- `nba-audio-preflight.ts` measures the selected closing bed. A silent bed is replaced by a bounded selection of adjacent audio from the same source, preserving arena gain and the original closing picture. Crossfade and final fade remain in place. Production and rendering fingerprints changed to exclude the old silent cache.
- Every newly verified video gets opening/ending 15-second signal checks, rejects abnormal silence outside the final fade, and checks independent narration insertion timing when the reference is available. Existing full decode and true-peak checks still apply. These checks do not replace subjective listening or establish frame-by-frame semantic alignment.
- `nba-types.ts` adds a quality hold. `nba-video.ts`, `nba-upload.ts` and `frontend/app/pages/nba-video.vue` prevent held works from being resumed or published, retain historical receipts, and distinguish a local repaired preview from a submitted work.

## Existing Records And Preview

Nine contaminated saved reports were backed up, cleaned and held. Five have the user's rejection report; four were found by local inspection. Historical publication records and the old uploaded versions were retained.

One clean local preview was rebuilt for `nba-a0080b1ca5995004e25a`, using its complete cleaned Chinese report (1,079 characters) and the existing voice. It is registered on the original task and remains held. It was not uploaded. Its final measured results are recorded in `preview-result.json` and the job's `repaired-preview/audio-preflight.json`.

The repaired 1080p video lasts 207.24 seconds (formerly 326.63 seconds). Its true peak is -2.11 dBTP and loudness is -16.49 LUFS. Its opening has no detected silence; its ending has only 0.06 seconds below -50 dBFS at the end of the final fade and no silence outside that fade. Actual narration insertion is 120 ms, with waveform correlation 0.8563. Subtitles cover the complete clean spoken script without caption gaps. The files `repaired-opening-15s.mp4` and `repaired-ending-15s.mp4` provide directly playable repaired samples.

NBA automatic publication and scheduled collection remain disabled during the incident. Chinese and English collection remain selected. The independent NBA API uses port 5684; the main backend on 5679 was not restarted.

## Validation

- 281 NBA backend tests pass, including real FFmpeg silence/fade and TTS insertion tests, body extraction regressions, same-source duplicate production/publication protection, upload recovery, and quality holds.
- Backend TypeScript checking passes.
- 35 frontend controller checks pass, including quality holds and historical receipt preservation.
- The new check rejects the actual old a008 video for 2.37 seconds of silence outside the final fade allowance. Its silent source bed measures -102.63 dBFS RMS; the adjacent selected bed measures -22.98 dBFS RMS with no silent interval.
- Read-only Playwright checks passed at 1440x1000 and 390x844. The repaired video plays, sampled opening/ending video pixels are visible, all five preview assets respond successfully, clean report and captions exclude the known page modules, the historical receipt is preserved, and publication remains unavailable for the held preview. There are no JavaScript page errors, mutating API requests or horizontal overflow. Screenshots and `browser-verification.json` are in the incident directory.
- Exact saved upload records for all nine cleaned jobs still match their original backups. The standalone NBA API was restarted while idle to load the repairs; automatic publication remains off.

## One Authorized Publication Test

After the user explicitly requested one repaired upload, only the verified repaired delivery for `nba-a0080b1ca5995004e25a` was released from its quality hold. The previous hold is archived under `delivery.verification.qualityRepairRelease` and in `pre-test-job.json`. Its original upload receipt remains unchanged. The other eight affected jobs remain held; automatic publication and scheduled collection remain disabled.

The existing NBA upload queue submitted the repaired video to the shared CBA/NBA Baijiahao account, labelled `体育`, with the selected platform topic `#NBA#`. Request `nba-quality-test-a008-20261105-v1` contains exactly one job. The uploaded video blob SHA-256 matches the repaired delivery (`dec351bdf84cdbc730813a11fdc555e84b20c459c87fa72fc957cde765a2975a`). Both uploaded covers were verified against their local files.

At 2026-11-05 14:45:48 Asia/Shanghai, the platform returned article ID `1880999737991466865` with `submitted:true`, `saved:false` and `published:false`. The platform content-management screenshot shows the repaired work as `审核中`; this is submission evidence, not an approval claim. Submission details are in `test-upload-result.json` and `data/social-auto-upload/jobs/nba-upload-68ce596558a82f11d39e43766bddfbcaa59ca52fdfeed284/publication.png`.

A subsequent read-only moderation refresh was withheld by the existing media-identity check because the platform `file_name` changed. It did not change the saved receipt or trigger another upload. Approval or rejection of the repaired test has not yet been verified.
