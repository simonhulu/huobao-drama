import {randomUUID} from 'node:crypto';

const dimensions = [
  'agentRequests',
  'browserProcesses',
  'cpuSlots',
  'ffmpegProcesses',
  'memoryMiB',
  'telemetryMiB',
  'temporaryDiskMiB',
];
const codedError = (code, message) => Object.assign(new Error(message), {code});
const normalize = (values = {}) => Object.fromEntries(
  dimensions.map((dimension) => [dimension, values[dimension] ?? 0]),
);

export class ResourceGovernor {
  constructor(capacity) {
    this.capacity = normalize(capacity);
    const diskReserve = capacity.temporaryDiskReserveMiB ?? 0;
    if (!Number.isFinite(diskReserve) || diskReserve < 0 || diskReserve > this.capacity.temporaryDiskMiB) {
      throw codedError('INVALID_RESOURCE_CAPACITY', 'Temporary disk reserve exceeds capacity');
    }
    this.capacity.temporaryDiskMiB -= diskReserve;
    this.used = normalize();
    this.queue = [];
    this.sequence = 0;
    this.drainScheduled = false;
  }

  acquire(claim, {orderKey = '', parentLeaseId, signal} = {}) {
    const normalized = normalize(claim);
    if (parentLeaseId !== undefined) {
      return Promise.reject(codedError(
        'NESTED_RESOURCE_CLAIM',
        'Resource leases cannot acquire nested claims',
      ));
    }
    if (signal?.aborted) {
      return Promise.reject(codedError('CANCELLED', 'Resource claim cancelled'));
    }
    for (const dimension of dimensions) {
      if (!Number.isFinite(normalized[dimension]) || normalized[dimension] < 0) {
        return Promise.reject(codedError(
          'INVALID_RESOURCE_CLAIM',
          `Invalid ${dimension} claim: ${normalized[dimension]}`,
        ));
      }
      if (normalized[dimension] > this.capacity[dimension]) {
        return Promise.reject(codedError(
          'RESOURCE_CLAIM_IMPOSSIBLE',
          `${dimension} claim exceeds capacity`,
        ));
      }
    }

    return new Promise((resolve, reject) => {
      const request = {
        claim: normalized,
        orderKey,
        reject,
        resolve,
        sequence: this.sequence++,
        signal,
      };
      request.onAbort = () => {
        const index = this.queue.indexOf(request);
        if (index < 0) return;
        this.queue.splice(index, 1);
        reject(codedError('CANCELLED', 'Resource claim cancelled'));
        this.#scheduleDrain();
      };
      signal?.addEventListener('abort', request.onAbort, {once: true});
      this.queue.push(request);
      this.#scheduleDrain();
    });
  }

  snapshot() {
    return {
      capacity: {...this.capacity},
      queued: this.queue.length,
      used: {...this.used},
    };
  }

  #scheduleDrain() {
    if (this.drainScheduled) return;
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.#drain();
    });
  }

  #drain() {
    this.queue.sort((left, right) =>
      left.orderKey.localeCompare(right.orderKey) || left.sequence - right.sequence,
    );
    while (this.queue.length > 0 && this.#fits(this.queue[0].claim)) {
      const request = this.queue.shift();
      request.signal?.removeEventListener('abort', request.onAbort);
      for (const dimension of dimensions) {
        this.used[dimension] += request.claim[dimension];
      }
      const id = randomUUID();
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        request.signal?.removeEventListener('abort', release);
        for (const dimension of dimensions) {
          this.used[dimension] -= request.claim[dimension];
        }
        this.#scheduleDrain();
      };
      request.signal?.addEventListener('abort', release, {once: true});
      request.resolve({
        id,
        release,
      });
    }
  }

  #fits(claim) {
    return dimensions.every(
      (dimension) => this.used[dimension] + claim[dimension] <= this.capacity[dimension],
    );
  }
}
