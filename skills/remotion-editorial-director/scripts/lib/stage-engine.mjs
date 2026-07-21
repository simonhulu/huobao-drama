import {randomUUID} from 'node:crypto';

const codedError = (code, message, details = {}) => Object.assign(new Error(message), {
  code,
  ...details,
});

const flatten = (steps) => steps.flatMap((step) => Array.isArray(step) ? step : [step]);

export const validateWorkflow = ({stages, operations}) => {
  const registry = new Map();
  for (const definition of stages) {
    if (registry.has(definition.id)) {
      throw codedError('DUPLICATE_STAGE', `Duplicate stage definition: ${definition.id}`);
    }
    if (!Array.isArray(definition.outputs) || definition.outputs.length === 0) {
      throw codedError('STAGE_OUTPUT_MISSING', `Stage must declare outputs: ${definition.id}`);
    }
    registry.set(definition.id, definition);
  }

  for (const [operation, steps] of Object.entries(operations)) {
    const ordered = flatten(steps);
    const present = new Set(ordered);
    for (const id of ordered) {
      if (!registry.has(id)) {
        throw codedError('UNKNOWN_STAGE', `Unknown stage ${id} in ${operation}`);
      }
    }
    for (const id of ordered) {
      for (const prerequisite of registry.get(id).prerequisites) {
        if (!registry.has(prerequisite)) {
          throw codedError('UNKNOWN_STAGE', `Unknown prerequisite ${prerequisite}`);
        }
        if (!present.has(prerequisite)) {
          throw codedError(
            'MISSING_STAGE_PREREQUISITE',
            `${operation} omits prerequisite ${prerequisite} for ${id}`,
          );
        }
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) {
      throw codedError('STAGE_DEPENDENCY_CYCLE', `Stage dependency cycle includes ${id}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const prerequisite of registry.get(id).prerequisites) visit(prerequisite);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of registry.keys()) visit(id);
  return registry;
};

const assertResumeLocks = (run, inputLockHash, implementationLockHash) => {
  if (
    run.inputLockHash !== inputLockHash ||
    run.implementationLockHash !== implementationLockHash
  ) {
    throw codedError(
      'RUN_REVISION_REQUIRED',
      'Locked inputs or implementation identity changed; create a new run revision',
      {supersedes: run},
    );
  }
};

const cancellationRecord = () => ({
  code: 'CANCELLED',
  exitCode: 130,
  recordedAt: new Date().toISOString(),
});

export class DirectorEngine {
  constructor({stages, operations}) {
    this.operations = operations;
    this.registry = validateWorkflow({stages, operations});
  }

  async execute({
    operation,
    run,
    context,
    commit,
    inputLockHash,
    implementationLockHash,
    resume = false,
    from,
    signal,
  }) {
    const steps = this.operations[operation];
    if (!steps) throw codedError('UNKNOWN_OPERATION', `Unknown operation: ${operation}`);
    if (resume) assertResumeLocks(run, inputLockHash, implementationLockHash);

    let state = structuredClone(run);
    state.attempts ??= [];
    state.completedStages ??= [];
    state.outputHashes ??= {};
    state.inputLockHash = inputLockHash;
    state.implementationLockHash = implementationLockHash;
    state.operation = operation;
    state.status = 'running';

    const ordered = flatten(steps);
    let startIndex = 0;
    if (from !== undefined) {
      startIndex = ordered.indexOf(from);
      if (startIndex < 0) {
        throw codedError('UNKNOWN_STAGE', `Stage ${from} is not part of ${operation}`);
      }
      for (const prerequisite of this.registry.get(from).prerequisites) {
        if (!state.completedStages.includes(prerequisite)) {
          throw codedError(
            'FROM_PREREQUISITE_MISSING',
            `Cannot start from ${from}; prerequisite ${prerequisite} is not committed`,
          );
        }
      }
    }
    const allowed = new Set(ordered.slice(startIndex));

    for (const step of steps) {
      const ids = (Array.isArray(step) ? step : [step]).filter(
        (id) => allowed.has(id) && !state.completedStages.includes(id),
      );
      if (ids.length === 0) continue;
      if (signal?.aborted) {
        state = {...state, cancellation: cancellationRecord(), status: 'cancelled'};
        await commit(state);
        return state;
      }
      for (const id of ids) {
        for (const prerequisite of this.registry.get(id).prerequisites) {
          if (!state.completedStages.includes(prerequisite)) {
            throw codedError(
              'STAGE_PREREQUISITE_NOT_COMMITTED',
              `Cannot dispatch ${id}; prerequisite ${prerequisite} is not committed`,
            );
          }
        }
      }

      const pending = ids.map((id) => this.#executeStage({
        baseContext: context,
        definition: this.registry.get(id),
        outputHashes: state.outputHashes,
        signal,
      }));
      let completed;
      try {
        completed = await Promise.all(pending);
      } catch (error) {
        if (signal?.aborted || error.code === 'CANCELLED' || error.name === 'AbortError') {
          state = {...state, cancellation: cancellationRecord(), status: 'cancelled'};
          await commit(state);
          return state;
        }
        state = {
          ...state,
          failure: {
            code: typeof error.code === 'string' ? error.code : 'INTERNAL_ERROR',
            message: error.message,
            retryable: error.retryable ?? false,
            stage: error.stage ?? ids[0],
          },
          status: 'failed',
        };
        await commit(state);
        throw error;
      }

      for (const item of completed) {
        state.attempts.push(item.attempt);
        state.completedStages.push(item.id);
        Object.assign(state.outputHashes, item.result.outputHashes);
        state.currentStage = item.id;
        state.artifacts = [...(state.artifacts ?? []), ...(item.result.artifacts ?? [])];
        await commit(state);
        if (item.result.awaitingAgent) {
          if (completed.filter(({result}) => result.awaitingAgent).length > 1) {
            throw codedError('MULTIPLE_AGENT_WAITS', 'A parallel stage group cannot await multiple agents');
          }
          state = {
            ...state,
            awaitingAgent: item.result.awaitingAgent,
            currentStage: `${item.result.awaitingAgent.stage}_AWAITING_AGENT`,
            status: 'awaiting_agent',
          };
          await commit(state);
          return state;
        }
      }
    }

    if (signal?.aborted) {
      state = {...state, cancellation: cancellationRecord(), status: 'cancelled'};
    } else {
      state = {...state, status: 'complete'};
    }
    await commit(state);
    return state;
  }

  async #executeStage({baseContext, definition, outputHashes, signal}) {
    const attemptId = randomUUID();
    const startedAt = new Date().toISOString();
    const stageContext = Object.freeze({
      ...baseContext,
      attemptId,
      previousOutputHashes: Object.freeze({...outputHashes}),
      signal,
      stageId: definition.id,
    });
    const result = await definition.execute(stageContext);
    if (result === null || typeof result !== 'object' || !result.outputHashes) {
      throw codedError(
        'INVALID_STAGE_RESULT',
        `Stage ${definition.id} did not return validated output hashes`,
        {stage: definition.id},
      );
    }
    return {
      attempt: {
        attemptId,
        completedAt: new Date().toISOString(),
        stage: definition.id,
        startedAt,
        status: 'succeeded',
      },
      id: definition.id,
      result,
    };
  }
}
