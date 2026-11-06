/**
 * 确定性分镜拆分端点（direct_script 专用）
 *
 * POST /api/v1/episodes/:id/storyboards:break-deterministic[?force=true]
 * 前置：episode 有 script 文本 + pre_tts_titles_json（tts.pre_generate 已产出）。
 * 行为见 backend/src/services/deterministic-breaker.ts。
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { badRequest, success } from '../utils/response.js';
import { breakEpisodeDeterministically, DeterministicBreakError } from '../services/deterministic-breaker.js';
const app = new Hono();
app.post('/:id/storyboards:break-deterministic', async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0)
        return badRequest(c, 'invalid episode id');
    const force = c.req.query('force') === 'true';
    try {
        const result = breakEpisodeDeterministically(id, { force });
        return success(c, {
            episode_id: result.episodeId,
            storyboard_count: result.storyboardCount,
            storyboard_ids: result.storyboardIds,
            total_chars: result.totalChars,
            script_chars: result.scriptChars,
            coverage_verified: result.coverageVerified,
            max_duration_sec: result.maxDurationSec,
            duration_ms: result.durationMs,
            cancelled_breaker_task_ids: result.cancelledBreakerTaskIds,
        });
    }
    catch (error) {
        if (error instanceof DeterministicBreakError) {
            return c.json({
                code: error.httpStatus,
                message: error.message,
                data: { error: error.code, direction: error.direction, ...error.details },
            }, error.httpStatus as ContentfulStatusCode);
        }
        throw error;
    }
});
export default app;

