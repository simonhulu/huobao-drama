# Episode publication recovery

Load this lesson only for `EPISODE_PUBLISH_FAILED`.

1. Keep the verified delivery bytes unchanged. Do not rerender or replace the MP4.
2. Inspect `episodePublicationIntent`, `episodes.video_url`, and `metadata.dharmaComic` for the same episode.
3. If the database already contains the same run ID, props SHA, delivery SHA, verification SHA, and video URL, retry the action; the runner must reuse the original intent timestamp and finish with footage API readback.
4. If the database pointer is empty, repair API/database availability and retry the action.
5. If the database points to a different URL or immutable evidence, do not overwrite it. Preserve both records and start a revision run only after identifying ownership.
6. Completion requires the footage endpoint to echo the exact `static/remotion/*.mp4` URL.
7. A visible MP4 on disk with a frontend “未渲染” state is publication failure, not render failure. Keep the MP4 unchanged and repair only `episode_publish`.
