# NBA encoded audio peak recovery

## Failure and evidence

Job `nba-d5b77faad2e993846d3a` stopped at verification with the old combined error for an empty audio track or clipping. Its 335.301634-second AAC stereo track was present. FFmpeg measured integrated loudness -15.84 LUFS and true peak +0.08 dBTP; sample peak was -0.235768 dBFS, with no NaN/Inf samples. The existing sample limiter did not guarantee a safe true peak after AAC encoding.

The actual pending file reproduced the verification failure. A recovery of that file applied -2.08 dB to the mix and encoded only audio, copying the H.264 video packets. The resulting track measured -17.97 LUFS and -2.47 dBTP. Video packet SHA256 remained identical; full decoding, all 20,098 frames, final black frame and silent final 10 ms passed.

## Automatic behavior

- Measure the encoded track before delivery, with distinct errors for silent tracks and malformed measurement data.
- For true peaks above -1.5 dBTP, attenuate toward -2 dBTP. Keep the relative levels of narration, original audio and arena bed.
- Copy video packets and verify their SHA256. Re-encode only audio; make at most two completed peak-repair attempts, each from the original file.
- Preserve original files and repair candidates until verification and atomic promotion finish. Save input/output hashes, gain, measurements and attempts in `audio-recovery.json`.
- Bind `render-cache.json` to production inputs, voice SHA256, ASS SHA256, timing, renderer version and actual output SHA256. Resume rendering and cover failures from that checkpoint.
- Preserve repair counts through measurement failures. Preserve candidates through the promotion/checkpoint interruption window.
- Existing submitted deliveries remain immutable. Existing upload receipts and duplicate-publication protections are unchanged.

This older task predated render checkpoints. A one-time, task-specific adoption checked the source, arena audio, voice, original article, translation, subtitles, timing, video metadata and repaired candidate before registering the existing render. Evidence is in `outputs/nba-audio-recovery-20261105/verification.json`; the adoption script intentionally refuses to overwrite an existing checkpoint.

## Verification

`node --import tsx --test src/services/nba*.test.ts src/routes/nba-video.test.ts`: 256 tests passed. After tightening interruption recovery, all 32 targeted audio/production tests passed again. `npm run typecheck` passed. Tests include real FFmpeg encoding/repair, silent and malformed data, finite retries across resume, packet changes, cancellation, and resuming an already-rendered video after a cover failure.

The independent NBA API was restarted on port 5684 while idle. The original task resumed under request ID `nba-audio-recovery-d5b77faad2-20261105`, using its existing automatic direct-publication setting and shared CBA account.

## Delivery result

The original job completed without downloading, translating, synthesizing speech or rendering video again. Its delivered SHA256 is `238a7687990b02f7ddd2be132a1dd966319c7e74a4cf5da0e518a459bec265a4`; the registered MP4 asset returns HTTP 200.

At 2026-11-05 05:25:26 UTC, Baijiahao accepted direct publication in account `体育` with required topic `#NBA#`. Article ID: `1880994682783115486`. Receipt: `submitted:true`, `saved:false`, `published:false`, `publicationStatus:submitted`. This confirms submission for platform review, not public publication. The run is finished, all 15 jobs are completed/submitted, and no job is waiting for manual recovery.

Implementation files: `backend/src/services/nba-audio.ts`, `backend/src/services/nba-production.ts`; regression coverage: their corresponding `.test.ts` files.
