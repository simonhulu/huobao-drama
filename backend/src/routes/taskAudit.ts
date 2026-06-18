import { Hono } from 'hono'
import { success } from '../utils/response.js'
import { getStuckTaskAudit } from '../services/tasks/audit.js'

const app = new Hono()

// GET /task-audit/stuck — read-only view of legacy in-memory task rows that may be stranded.
app.get('/stuck', (c) => {
  return success(c, getStuckTaskAudit())
})

export default app
