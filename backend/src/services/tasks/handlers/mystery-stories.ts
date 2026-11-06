import { z } from 'zod'
import { registerTaskHandler } from '../registry.js'
import { NonRetryableTaskError, type TaskHandler } from '../types.js'
import { getMysteryWorkflowService, type MysteryWorkflowService } from '../../mystery-workflow.js'

export function createMysteryWorkflowHandler(service?:MysteryWorkflowService):TaskHandler {
  return {resumable:true,maxAttempts:3,async run(ctx){
    const input=z.object({storyId:z.number().int().positive(),runId:z.string().uuid()}).safeParse(ctx.payload)
    if(!input.success)throw new NonRetryableTaskError('奇闻故事任务参数无效')
    return (service||getMysteryWorkflowService()).execute(input.data.storyId,input.data.runId,ctx)
  }}
}
export function createMysteryCollectionHandler(service?:MysteryWorkflowService):TaskHandler {
  return {resumable:true,maxAttempts:3,async run(ctx){
    const input=z.object({collectionId:z.string().uuid()}).safeParse(ctx.payload)
    if(!input.success)throw new NonRetryableTaskError('奇闻故事采集参数无效')
    await(service||getMysteryWorkflowService()).executeCollection(input.data.collectionId,ctx)
    return {collectionId:input.data.collectionId}
  }}
}
export function registerMysteryStoryHandlers(){registerTaskHandler('mystery.workflow',createMysteryWorkflowHandler());registerTaskHandler('mystery.collection',createMysteryCollectionHandler())}
