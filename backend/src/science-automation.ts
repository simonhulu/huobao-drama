import { getScienceWorkflowService } from './services/science-workflow.js'
import { getScienceCollectionService } from './services/science-collection.js'

export function startScienceAutomation(environment: NodeJS.ProcessEnv = process.env) {
  const workersEnabled = environment.TASK_WORKER_DISABLED !== '1'
  const delivery = environment.SCIENCE_DELIVERY_AUTOMATION_ENABLED
  const collection = environment.SCIENCE_COLLECTION_AUTOMATION_ENABLED
  if (delivery === '1' || workersEnabled && delivery !== '0')
    getScienceWorkflowService().startAutomaticExports()
  if (collection === '1' || workersEnabled && collection !== '0')
    getScienceCollectionService().startAutomaticRecovery()
}
