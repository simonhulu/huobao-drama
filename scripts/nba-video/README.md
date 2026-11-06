# NBA Production Runtime

`backend/src/services/nba-production.ts` exports
`produceNbaVideo(input: NbaProductionInput): Promise<Partial<NbaJob>>`.
The caller owns job persistence through `checkpoint` and `onProgress`.
`NBA_ATTENTION` errors include `stage` and a recovery instruction. An aborted
signal ends child process groups and preserves completed artifacts.

## Sports Video Topics

Channel collection is video-first: interviews, media days, features, historical
recaps, season compilations and other sports videos all search for related
complete original news in Chinese and English. A final NBA game is optional.
`article.topic` stores the source video ID, URL, title and description. Each
independent article creates one video; the existing minimum body lengths and
article deduplication still apply. Search snippets and video descriptions are
never substituted for a source article. English articles are translated only.

Topic production uses its associated video without requiring official NBA
channel ownership, matchup metadata or an English audio track. Media caches
use the topic identity. Topic endings dissolve to the source video's tail and
fade out without a fabricated final score. Topic covers use a real source frame
with a Chinese headline panel. The game-specific contracts below continue to
apply to legacy matchup production without a topic context.

## Runtime Requirements

- Existing configured text and narration providers, reached through
  `callTextModel` and `generateTTSWithMetadata`.
- `ffmpeg`, `ffprobe`, `yt-dlp`, and `whisper-cli` on PATH.
- `HISTORY_YOUTUBE_YTDLP_BIN`, `HISTORY_YOUTUBE_PROXY`,
  `HISTORY_YOUTUBE_COOKIES_FILE`, and `HISTORY_YOUTUBE_COOKIES_BROWSER` retain
  their existing meaning. Cookie files are copied privately for each download.
  The downloader explicitly uses the current Node runtime. A login rejection
  refreshes the existing Chrome session once and validates the same video
  before continuing; no interactive verification is bypassed.
- `WHISPER_CLI` and `WHISPER_MODEL` override local speech recognition paths.
  The default model is `~/.cache/hyperframes/whisper/models/ggml-small.bin`.
- `NBA_AUDIO_PYTHON` selects a Python environment with compatible Torch and
  Torchaudio, plus NumPy and SoundFile. The verified environment uses Python
  3.12, Torch 2.6.0, and Torchaudio 2.6.0. The pipeline does not modify global
  Python packages.
- `NBA_DEMUCS_CACHE` selects the official HDemucs model cache; otherwise it is
  `<sharedDir>/.models`. `NBA_DEMUCS_WEIGHTS` can import an existing official
  checkpoint. Its full SHA-256 must match before inference.
- `NBA_VIDEO_ENCODER` overrides `h264_videotoolbox` on macOS or `libx264` on
  other systems. `NBA_SUBTITLE_FONT` overrides the local CJK font.

The separate audio command is:

```sh
"$NBA_AUDIO_PYTHON" scripts/nba-video/separate-audio.py \
  --input /absolute/source.mp4 \
  --output /absolute/reduced_commentary.wav \
  --cache-dir /absolute/model-cache \
  --report /absolute/separation.json
```

The model estimates a vocal stem, then subtracts 94 percent of that estimate
from the original stereo audio. It preserves the exact decoded sample count.
The JSON report records input, output and model hashes, levels, alignment and
limitations. Commentary can remain and crowd shouts can also be reduced.

Each six-second inference window is saved atomically beneath
`<output-directory>/.separation-chunks/`, or `--checkpoint-dir` when supplied.
An interrupted retry verifies and reuses completed windows, then rebuilds the
same one-second overlaps. Cache identities bind the source, model, sample count,
global normalization and runtime versions; corrupted windows are recomputed.
The report's `checkpoint` records reused and computed window counts. Existing
final outputs are still accepted only with the source/output verification report.

The production timeout is `max(1800, 4 * sourceDuration + 600)` seconds, capped
at three hours per attempt. Window progress is persisted in the workbench.
Deadline expiry is retryable and reuses verified windows through the existing
bounded media recovery and continuous scheduler; an import failure or invalid
model fingerprint still requires repairing the environment or model cache.

## Download Recovery

Single-video metadata reads may tolerate missing formats; actual downloads
never use that tolerance. Prefer a muxed 1080p H264 original English HLS
format, falling back to separate 1080p video and English audio. Use four
concurrent fragments, five bounded fragment retries, and abort on a missing
fragment. Partial files remain available for continuation. The download
timeout is 45 minutes and cancellation kills the process group.

The transport reports `youtube_login_required`, `youtube_network`, or
`youtube_unavailable` without exposing provider URLs or credential values.
Only an explicitly retryable media network failure gets two additional
orchestrator attempts, after 5 and 15 seconds. Each attempt uses persisted
checkpoints; a stop also cancels the backoff. An exhausted authentication
refresh, HTTP 403/404, or narration failure does not trigger
this retry loop.

Selected audio is verified from `requested_formats` or from exact component
IDs in `format_id` against the saved `formats` list, including muxed HLS.
Reading a full metadata document alone is not proof of media permission.

If a complete `sources/<YouTubeId>/source.mp4` and its info JSON exist but
manifest writing was interrupted, recovery checks the exact source ID,
same-game identity, selected English audio, resolved path, actual probe and
source duration locally. It hashes the file and creates an unreviewed media
checkpoint; the normal visual ending review is still mandatory.

## Shared Media Contract

The active manifest is `<sharedDir>/<game.id>/manifest.json`:

```ts
{
  version: 1,
  gameFingerprint: nbaGameFingerprint(game),
  media: NbaMedia,
  sourceMetadata: { id, title, description, channel_id, upload_date },
  reducedAudioSha256?: string,
  separation?: Record<string, unknown>
}
```

Imported direct `NbaMedia` manifests are also accepted when their sibling
`source.info.json` exists. Registered source files must resolve inside
`sharedDir`. New sources use `sources/<YouTubeId>/` under the game directory;
replacing a URL does not overwrite a previous source or its audio bed.

`verified: true`, finite `liveEndSeconds` and `closingStartSeconds`, and
nonempty `verificationNotes` record an approved complete-possession cut and
natural ending. Those points apply only to the stored source hash. New media
uses scene candidates and chronological visual samples; uncertainty pauses
production. Successful shot review is persisted before separation starts.

The source video hash, real probe, source ID, official NBA channel, both teams
and explicit game date are checked on recovery. Upload date alone cannot
establish game identity. A corrupt arena track is regenerated independently.

## Job Artifacts

`editorial.json` locks the original body/game identity and Chinese translation
with `mode: "translation-only"`. English articles use one complete translation
call; Chinese articles use the original text. There is no factual review,
paragraph mapping requirement, or correction loop. Valid saved translations
are reused even if a legacy review failed; that review is archived as
`previousReview` and never gates production or publication.
`voice-cache.json` binds the
spoken text, voice, speed and provider identity to an actual audio hash.
Whisper JSON is keyed by audio hash. Captions must cover the complete locked
spoken text and have no long internal gaps. `ending-plan.json` records
source-specific cuts and frame counts.

Final video publication inside the local job directory is atomic: rendering
writes `video.pending.mp4`; successful verification promotes it to
`video-<fingerprint>.mp4`. Delivery metadata records full decoding, exact
frame/duration checks, final-frame fade, tail audio, true peak, hashes,
caption coverage and narration pauses. It also records
`contentMode: "translation-only"` and `factReviewPerformed: false`.
This is a local artifact only.

New covers use real upper-body or full-body action photographs of actual
participants, Chinese team names, the final score, local game date and the
current article's translated headline. A player mentioned in the English
headline takes priority, followed by that game's scoring order, with at most
three candidates per team. TheSportsDB exact-name search and player lookup
provide original transparent PNGs. Visual inspection checks the actual jersey
team and visible torso and arms; old-team jerseys and headshots are rejected.
Body crops retain the complete head, arms and basketball. Default production
preserves the original photograph, including natural jersey and basketball
brands, without local repainting. Missing body photos fall back to
team-name typography without blocking production; headshots are never reused.
Landscape (1920x1080) and portrait (1080x1440) PNGs are laid out independently;
`portraitCoverPath` prevents the uploader from cropping the landscape poster.
Photo source dimensions and hashes are recorded separately from canvas size.
Legacy deliveries without an independent portrait retain crop compatibility.
`ensureNbaDeliveryCover` repairs covers independently of source video,
narration and rendering. Existing submitted uploads retain their own identity.

To generate local samples without changing a job or operating a platform:

```sh
cd backend
node run-tsx.mjs scripts/nba-cover-samples.ts nba-b58390cfe063609a0a5b
node run-tsx.mjs scripts/nba-cover-samples.ts --team-names nba-b58390cfe063609a0a5b
```

The poster renderer uses the existing Chrome installation or
`PUPPETEER_EXECUTABLE_PATH`. Photo downloads reuse `NBA_NEWS_PROXY` and the
existing proxy fallbacks, with verified offline caches. Image inspection uses
the configured text provider with the `gpt-6.1-terra` vision model. Optional
explicit mark repairs require Python with OpenCV and NumPy, selected by `NBA_COVER_PYTHON`,
then `NBA_AUDIO_PYTHON`, then the existing audio environment or `python3`.
Inspection errors are retried on later attempts rather than cached as missing.
Default photo production does not require OpenCV. Changing the local repair
revision regenerates only the photograph output and
reuses the source-bound visual decision, without repeating the model request.
Current Luka and Bam sample originals are 500x500 and 700x700; output canvas
dimensions do not imply additional native photographic detail.

## Baijiahao Publication

NBA uploads default to `publicationMode: "publish"`, `tags: ["#NBA#"]`, and
`topicPolicy: "required-exact"`. The bridge selects and reads back the actual
platform topic before submitting. New descriptions follow the CBA convention:
`YYYY-MM-DD NBA｜player performance or event, teams and score #NBA#`.
The date is the verified local game date, never the article or collection date.
Copy keeps complete clauses and quotations within 50 UTF-16 units, including
the topic, without changing the article title or narration. `publicationCopy`
binds the new description to the immutable upload manifest. Historical uploads
without that field continue using their original description and identity.
Published descriptions can be revised on the original article; the verified
revision is stored separately from the original upload payload and displayed
in the workbench. Copy changes never trigger another upload of a submitted video.

Use the existing CBA account and shared publication executor. A saved draft
is not a completed publication. Its `previousDraft` binding allows revised
covers and topics to be applied in the original editor, preserving the same
video, upload job and platform article ID. Submission intent is durable before
the publish click. Unknown submissions reconcile read-only rather than
uploading the video or clicking publish again. Report platform `submitted`
and `published` states distinctly.

To register a previously verified delivery for recovery, set:

```ts
delivery.verification.productionInputHash = nbaProductionFingerprint(
  { article, game, script, media }, settings, manifest.reducedAudioSha256,
)
```

Recovery still rehashes and decodes the video and checks the final frame and
tail audio. A failed check never becomes a completed job.

## Focused Checks

```sh
cd backend
node --import tsx --test src/services/nba-production.test.ts
npm run typecheck
```
