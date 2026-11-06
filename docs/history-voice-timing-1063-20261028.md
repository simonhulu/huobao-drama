# Episode 1063: Narration Voice And Shot Timing

## Requested Result

- Use MiniMax voice `ttv-voice-2026072016135626-xnywYYL4` as the default and for Episode 1063.
- Preserve the confirmed history-script narration, selected unique assets, and reviewed maps.
- Keep a shot on screen until its assigned narration has finished; retain short dissolves after the boundary.
- Preserve previous masters and delivered editions.

## Cause And Change

The previous timeline interpolated internal shot boundaries by character count inside 64 large provider subtitle chunks. Of 156 internal cuts, 131 were inside those chunks. This did not follow variations in speech rate or pauses. For example, an old cut at 19.633 seconds preceded the corresponding recognized phrase ending at 20.220 seconds in the old master.

MiniMax accepted `subtitle_type=word`, but the real response still contained whole paragraphs. This request alone cannot establish word timing.

The new master was synthesized once with the requested voice, preserving the locked script. Its duration is 778.6 seconds; its 63 provider subtitle chunks remain stored as provider evidence. Local whisper.cpp recognition supplies token and segment offsets. Full-script character alignment maps those offsets back to the locked text without replacing the narration with recognition text.

Multi-character tokens remain atomic. A sentence-ending token retains the segment tail; following token onsets provide conservative boundaries. Frame boundaries use a ceiling, so converting an audio end to 30 fps does not move the cut earlier. Captions use the same mapping and remain inside their narration shots. Map stages, route animation, highlights, camera times and sound effects follow the new shot timeline.

The resulting plan has 157 shots, 156 measured internal boundaries and 234 captions. The minimum matching confidence is approximately 0.682. Twenty-eight boundaries retain warnings about recognition substitutions or missing characters, mainly names and homophones. These are ASR estimates, not a claim of word-level forced alignment or independent historical verification.

## Execution And Reuse

- The configured narration default and built-in fallback use the requested voice.
- `POST /api/v1/remotion/episodes/1063/history-production/rebuild` accepts an optional `voiceId`; an explicit replacement must match cached voice metadata. An Episode-seeded cache cannot bypass this check.
- Ordinary retries reuse existing masters and valid visuals. New masters get new filenames; the prior revision retains its audio path.
- The production runner realigns older plans once and stores `audioTimingVersion: 2` and shot-end evidence. Recognition is cached by the audio fingerprint. Valid provider timestamps that already cover every shot boundary skip local ASR.
- The existing Episode and Remotion delivery route registers the new full video and preserves previous editions.

## Verification

The first seven shots were rendered as a 32.27-second voiced sample. All six cut boundaries were decoded at two frames before, two frames after and fourteen frames after. The contact sheet was visually inspected for the expected scene handoff, subtitle changes and black-frame failures. This did not include human listening.

Focused regression coverage includes early frame rounding, nonuniform timing, unrelated or truncated recognition, repeated phrases, zero-duration tokens, atomic multi-character tokens, exact caption preservation, captions remaining inside shots, explicit voice replacement and reuse of completed media. Failed or incomplete recognition stops recoverably instead of marking estimated timing as aligned. Changing the requested voice during a delivery retry cannot deliver the old audio. The final combined run passed 63 of 63 tests. Backend type checking passed.

Sample: `http://localhost:3013/static/remotion/history-1063-voice-timing-sample-f0929f1c5eb6.mp4`

Full-run pointer: `data/temp/history-transition-1063/voice-retimed-run.json`.
The completed run is `data/storage/history-motion/67df9801-27d8-4e06-a1b2-1970b564b528/render-voice-retimed-1793143740308/`.

## Delivered Full Video

- Episode page: `http://localhost:3013/remotion/episode/1063`.
- Full video: `http://localhost:3013/static/remotion/history-67df9801-27d8-4e06-a1b2-1970b564b528-fb70c7a4b2e4.mp4`.
- First-minute voiced preview: `http://localhost:3013/static/remotion/history-67df9801-27d8-4e06-a1b2-1970b564b528-fb70c7a4b2e4-preview.mp4`.
- Dongchang voiced excerpt: `http://localhost:3013/static/remotion/history-1063-dongchang-voice-timing-a146beb58fc2.mp4`, covering 504.967-541.100 seconds of the full video.
- Source manuscript 141 delivery: `/static/history-deliveries/141/5f330b7a-a2f7-403f-b203-ea15f16fef33.mp4`.

The delivered file has 23,358 frames, 1920x1080 at 30 fps, H.264/AAC, a container duration of 778.603 seconds, and 192,958,048 bytes. It is within the upload budget at about 14.87 MB/minute. SHA-256: `fb70c7a4b2e445dad975993d0ea35c7bd07ae97cf152c988bfad691addd742fb`.

The raw Remotion output introduced a constant 42.667 ms AAC delay. Four clean narration windows (16-19, 508-511, 531.5-534.5, 751-754 seconds) measured the same lag. This delivery corrects audio timestamps with packet copying; the H.264 packet hash is unchanged. After correction all four sampled windows have zero measured lag at an 8 kHz measurement rate and waveform correlations of 0.99877-0.99995. This proves sampled encoded-audio timing relative to the new master, not phoneme-perfect speech recognition or subjective listening quality. The timestamp correction is recorded by this repair's finalization script; it is not a claim that every factory render automatically runs waveform correction.

Actual final-file visual inspection covered 15 selected transitions at -2, +2 and +14 frames, plus three in-shot frames each for maps 105 and 110 (51 decoded frames). No black flashes were found in those samples. Dongchang and Jinan remain visible together; the return-to-Beiping arrow progresses across the map samples. This is sampled inspection, not a full-film watch or independent historical review.

A fresh browser opened the Episode page and verified the new default video, its 778.603-second duration, the new master URL, and the manuscript's updated delivery. Browser playback passed around 15.8-18.0, 507-509.2, 530.5-532.7 and 751.3-753.5 seconds without page errors. Both old and new editions remain listed. The Episode video pointer was explicitly switched to the new edition; the previous Episode, source delivery, narration metadata and job were archived in this run. The source replacement reused the existing attachment service, which retains old files and also queues the existing article-refresh workflow.

Evidence is in `movie-audio-aligned.mp4.json`, `audio-timestamp-correction.json`, `timing-review.json`, `full-review/` and `ui-review/` under the completed run directory. No human listening or full realtime playback was performed. Passing tests, file existence, or sampled frames alone do not establish subjective film quality.

## Changed Components

- `backend/src/services/history-motion-audio-align.ts` and its tests.
- `backend/src/services/history-motion-pipeline.ts` and the focused production tests.
- `backend/src/services/history-factory.ts`, its tests, and `backend/src/routes/history-factory.ts`.
- `backend/src/services/narration-defaults.ts`, its configured-default test, and the legacy default assignment in `backend/src/db/index.ts`.
- `.codex/skills/remotion-history-factory/SKILL.md`.

The existing unrelated worktree changes are outside this repair.
