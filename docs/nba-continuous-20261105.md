# NBA continuous workflow

The previous per-channel scan maximum of 50 was an application limit, not a YouTube requirement. Increasing a round's budget alone did not provide continuous operation: the deployed settings had scheduling and automatic publishing disabled, channel scans always restarted at the newest entries, and interrupted processing required manual recovery.

## Behavior

- API and workbench accept a per-channel scan budget from 1 to 1000. This is a bounded round, not a lifetime channel cap.
- Every round checks the latest videos first. When production is idle, the remaining budget continues historical scanning from `.channel-scan.json`. Busy rounds keep the historical position. Historical scans overlap a few entries and existing source/article/language deduplication remains enabled.
- Videos already assigned to production jobs are skipped before metadata and news requests, even if earlier source failures left language coverage incomplete. They cannot repeatedly consume the news quota and prevent the next video from being considered.
- Article jobs and channel history are saved before advancing the cursor. Interrupted saves cannot silently skip uncommitted content.
- Scheduled production tries publication for completed checkpoints before more rendering, and after each newly completed video. Slow later sources do not withhold already completed videos.
- Service restart automatically resumes interrupted processing in continuous mode, preserving accepted settings and publication account. Explicitly stopped scopes remain stopped. Temporary production/publication faults receive up to three delayed recoveries in the same run at 1, 5 and 15 minutes; collection faults retry on the next scan interval. Unknown publication outcomes reuse the original identity and existing receipt protection.
- Default settings can be saved while production runs, including switching scheduling off. Accepted batches keep their original settings snapshot.
- macOS LaunchAgent `com.huobao.nba-video` starts after login, restarts the service after process failure, and runs `caffeinate -i` to prevent idle system sleep. Logs: `.logs/nba-video-service.log`. Closing the browser does not stop production. Shutdown, logout, forced lid sleep, unavailable network or a platform login challenge can still interrupt operation.

## Deployed Settings

- Scan interval: 10 minutes after the previous collection finishes.
- Per-channel round scan budget: 100; configurable up to 1000.
- Languages: English and Chinese.
- New article target: 6 per round, configurable up to 100.
- Automatic production and direct publication: enabled.
- Publication account: existing CBA account `体育`, with required exact NBA topic.
- Existing voice, speed, arena mix, jobs and publication receipts retained.

An immediate real collection was started alongside the restored original processing queue. The original last video's staging process did not promptly honor stop; its saved state confirmed video and both covers existed without a publication request. Only that verified staging process was terminated, then the same upload identity resumed by checking the original editor's video fingerprint.

The original editor subsequently revealed an uncommitted portrait crop despite saved cover proofs. Recovery now checks the current preview slots as well as the saved proofs, verifies the original video digest, repairs missing covers, and only then waits for editor readiness. The project adapter also recognizes the platform's failed-image placeholder without treating it as an uploaded cover. Forty-two focused browser and upload recovery tests passed.

The next real collection advanced to channel position 13 and admitted three candidates. Runtime inspection removed a fashion story matched through "Jelly" and a recap with a different opponent before either was produced or submitted. The remaining sports story is queued for production. Matching now requires sports context and rejects a clearly different matchup when both teams are explicit, while preserving interviews and topics without fixture details. Fifty-five topic/news tests cover these corrections; no factual review or rewriting was introduced.

## Verification

111 focused backend route/collection/queue/deletion/recovery tests and backend typecheck passed. This includes four regression cases added after the real first scan exposed quota starvation from already assigned videos. Four installer tests passed, including excluding inherited credentials from launch configuration. Forty-six workbench controller tests passed, and read-only Playwright desktop/mobile checks cover schedule visibility, the next collection time and 1000/1001 native form boundaries.

Live checks confirmed the LaunchAgent is running, its idle-sleep assertion is active, scheduling and direct publication are enabled, original processing run ID and receipts remain intact, and the previously deleted unwanted task remains absent.

Artifacts: `outputs/nba-continuous-20261105/deployment.json`, initial-state snapshots, and `browser/result.json` with desktop/mobile screenshots.
