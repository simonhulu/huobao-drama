import { Hono } from 'hono';
import { eq, isNull, desc } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { success, badRequest, notFound, created, now } from '../utils/response.js';
import { toSnakeCase, toSnakeCaseArray } from '../utils/transform.js';
import { createTask } from '../services/tasks/store.js';
import { getDefaultMediaAccountRow, getMediaAccountRow } from '../services/media-accounts.js';
import { DEFAULT_NARRATION_SPEED } from '../services/narration-defaults.js';
import { createScienceWorkflowRoute } from './science-workflow.js';
const app = new Hono();
app.route('/workflow', createScienceWorkflowRoute());
const WORKFLOW_TYPE = 'science_pop';
const RENDER_MODE = 'science_pop';
// GET /science-pop/projects - list science-pop episodes with drama info
app.get('/projects', async (c) => {
    const page = Number(c.req.query('page') || 1);
    const pageSize = Number(c.req.query('page_size') || 20);
    const keyword = c.req.query('keyword');
    const allEpisodes = db.select().from(schema.episodes)
        .where(eq(schema.episodes.workflowType, WORKFLOW_TYPE))
        .orderBy(desc(schema.episodes.updatedAt))
        .all();
    let filtered = allEpisodes;
    if (keyword) {
        filtered = filtered.filter(ep => ep.title.includes(keyword) || (ep.description ?? '').includes(keyword));
    }
    const total = filtered.length;
    const items = filtered.slice((page - 1) * pageSize, page * pageSize);
    const dramas = db.select().from(schema.dramas).where(isNull(schema.dramas.deletedAt)).all();
    const dramasById = new Map(dramas.map(d => [d.id, d]));
    const enriched = items.map(ep => {
        const drama = dramasById.get(ep.dramaId);
        return {
            ...toSnakeCase(ep),
            drama: drama ? toSnakeCase(drama) : null,
        };
    });
    return success(c, {
        items: enriched,
        pagination: { page, page_size: pageSize, total, total_pages: Math.ceil(total / pageSize) },
    });
});
// POST /science-pop/projects - create a new science-pop project (drama + episode)
app.post('/projects', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ts = now();
    const title = String(body.title || '').trim();
    if (!title)
        return badRequest(c, 'title is required');
    const requestedAccountId = Number(body.media_account_id ?? body.mediaAccountId);
    const account = Number.isInteger(requestedAccountId) && requestedAccountId > 0
        ? getMediaAccountRow(requestedAccountId)
        : getDefaultMediaAccountRow();
    if (!account)
        return badRequest(c, 'media account not found');
    const dramaRes = db.insert(schema.dramas).values({
        mediaAccountId: account.id,
        title,
        description: body.description,
        genre: body.genre ?? '科普',
        style: body.style ?? 'realistic',
        workflowType: WORKFLOW_TYPE,
        status: 'draft',
        createdAt: ts,
        updatedAt: ts,
    }).run();
    const dramaId = Number(dramaRes.lastInsertRowid);
    const episodeRes = db.insert(schema.episodes).values({
        dramaId,
        episodeNumber: 1,
        title: body.episode_title ?? `${title} 第1集`,
        videoTitle: body.video_title ?? body.episode_title ?? title,
        description: body.description,
        aspectRatio: body.aspect_ratio ?? '16:9',
        renderMode: RENDER_MODE,
        workflowType: WORKFLOW_TYPE,
        narrationMode: 'verbatim',
        dialogueMode: 'narration_only',
        narrationSpeed: DEFAULT_NARRATION_SPEED,
        status: 'draft',
        createdAt: ts,
        updatedAt: ts,
    }).run();
    const episodeId = Number(episodeRes.lastInsertRowid);
    const [episode] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all();
    return created(c, {
        episode: toSnakeCase(episode),
        drama: toSnakeCase(drama),
    });
});
// GET /science-pop/projects/:id - get episode detail with storyboards and latest tasks
app.get('/projects/:id', async (c) => {
    const episodeId = Number(c.req.param('id'));
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
    if (!ep)
        return notFound(c, 'Episode not found');
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, ep.dramaId)).all();
    const storyboards = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId))
        .orderBy(schema.storyboards.storyboardNumber)
        .all();
    const tasks = db.select().from(schema.creationTasks)
        .where(eq(schema.creationTasks.episodeId, episodeId))
        .orderBy(desc(schema.creationTasks.id))
        .all();
    return success(c, {
        episode: toSnakeCase(ep),
        drama: drama ? toSnakeCase(drama) : null,
        storyboards: toSnakeCaseArray(storyboards),
        tasks: toSnakeCaseArray(tasks),
    });
});
// PUT /science-pop/projects/:id/intake - save source video url + narration script
app.put('/projects/:id/intake', async (c) => {
    const episodeId = Number(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
    if (!ep)
        return notFound(c, 'Episode not found');
    const sourceVideoUrl = body.source_video_url ?? body.sourceVideoUrl;
    const scriptContent = body.script_content ?? body.scriptContent ?? body.narration_script ?? body.narrationScript;
    const updates: Partial<typeof schema.episodes.$inferInsert> = {
        updatedAt: now(),
    };
    if (sourceVideoUrl !== undefined)
        updates.sourceVideoUrl = String(sourceVideoUrl || '');
    if (scriptContent !== undefined)
        updates.scriptContent = String(scriptContent || '');
    if (body.title !== undefined)
        updates.title = String(body.title);
    if (body.video_title !== undefined)
        updates.videoTitle = String(body.video_title);
    if (body.description !== undefined)
        updates.description = String(body.description);
    db.update(schema.episodes).set(updates).where(eq(schema.episodes.id, episodeId)).run();
    const [updated] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
    return success(c, toSnakeCase(updated));
});
// POST /science-pop/projects/:id/segment - trigger video segmentation
app.post('/projects/:id/segment', async (c) => {
    const episodeId = Number(c.req.param('id'));
    const body = await c.req.json().catch(() => ({}));
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
    if (!ep)
        return notFound(c, 'Episode not found');
    if (!ep.sourceVideoUrl)
        return badRequest(c, 'Source video not uploaded yet');
    const task = createTask({
        type: 'science_pop.segment',
        dramaId: ep.dramaId,
        episodeId,
        scopeType: 'episode',
        scopeId: episodeId,
        idempotencyKey: `science_pop.segment:${episodeId}`,
        payload: {
            episode_id: episodeId,
            scene_threshold: body.scene_threshold,
            target_shot_seconds: body.target_shot_seconds,
        },
    });
    return success(c, { task_id: task.id, status: 'queued' });
});
// POST /science-pop/projects/:id/tts - trigger unified narration TTS
app.post('/projects/:id/tts', async (c) => {
    const episodeId = Number(c.req.param('id'));
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
    if (!ep)
        return notFound(c, 'Episode not found');
    if (!ep.scriptContent?.trim())
        return badRequest(c, 'Narration script is empty');
    const task = createTask({
        type: 'tts.episode_unified',
        dramaId: ep.dramaId,
        episodeId,
        scopeType: 'episode',
        scopeId: episodeId,
        idempotencyKey: `tts.episode_unified:${episodeId}`,
        payload: {
            episode_id: episodeId,
        },
    });
    return success(c, { task_id: task.id, status: 'queued' });
});
// POST /science-pop/projects/:id/compose - trigger final composition
app.post('/projects/:id/compose', async (c) => {
    const episodeId = Number(c.req.param('id'));
    const [ep] = db.select().from(schema.episodes).where(eq(schema.episodes.id, episodeId)).all();
    if (!ep)
        return notFound(c, 'Episode not found');
    const task = createTask({
        type: 'science_pop.compose',
        dramaId: ep.dramaId,
        episodeId,
        scopeType: 'episode',
        scopeId: episodeId,
        idempotencyKey: `science_pop.compose:${episodeId}`,
        payload: {
            episode_id: episodeId,
        },
    });
    return success(c, { task_id: task.id, status: 'queued' });
});
export default app;

