import assert from 'node:assert/strict';
import test from 'node:test';

import {ResourceGovernor} from '../../scripts/lib/resource-governor.mjs';

test('ResourceGovernor applies deterministic FIFO backpressure across dimensions', async () => {
  const governor = new ResourceGovernor({
    cpuSlots: 1,
    memoryMiB: 128,
    ffmpegProcesses: 1,
  });
  const blocker = await governor.acquire(
    {cpuSlots: 1, memoryMiB: 64, ffmpegProcesses: 1},
    {orderKey: '00:blocker'},
  );
  const acquired = [];
  const later = governor
    .acquire(
      {cpuSlots: 1, memoryMiB: 64, ffmpegProcesses: 1},
      {orderKey: '20:later'},
    )
    .then((lease) => {
      acquired.push('later');
      return lease;
    });
  const earlier = governor
    .acquire(
      {cpuSlots: 1, memoryMiB: 64, ffmpegProcesses: 1},
      {orderKey: '10:earlier'},
    )
    .then((lease) => {
      acquired.push('earlier');
      return lease;
    });

  blocker.release();
  const earlierLease = await earlier;
  assert.deepEqual(acquired, ['earlier']);
  earlierLease.release();
  const laterLease = await later;
  assert.deepEqual(acquired, ['earlier', 'later']);
  laterLease.release();
  assert.deepEqual(governor.snapshot().used, {
    agentRequests: 0,
    browserProcesses: 0,
    cpuSlots: 0,
    ffmpegProcesses: 0,
    memoryMiB: 0,
    telemetryMiB: 0,
    temporaryDiskMiB: 0,
  });
});

test('ResourceGovernor rejects impossible and nested claims', async () => {
  const governor = new ResourceGovernor({cpuSlots: 1, memoryMiB: 64});
  await assert.rejects(
    governor.acquire({cpuSlots: 2, memoryMiB: 32}, {orderKey: 'a'}),
    (error) => error.code === 'RESOURCE_CLAIM_IMPOSSIBLE',
  );
  const lease = await governor.acquire(
    {cpuSlots: 1, memoryMiB: 32},
    {orderKey: 'b'},
  );
  await assert.rejects(
    governor.acquire(
      {cpuSlots: 0, memoryMiB: 1},
      {orderKey: 'c', parentLeaseId: lease.id},
    ),
    (error) => error.code === 'NESTED_RESOURCE_CLAIM',
  );
  lease.release();
});

test('ResourceGovernor enforces disk reserve and cancels queued claims', async () => {
  const governor = new ResourceGovernor({
    browserProcesses: 1,
    cpuSlots: 1,
    memoryMiB: 64,
    temporaryDiskMiB: 100,
    temporaryDiskReserveMiB: 20,
  });
  await assert.rejects(
    governor.acquire({temporaryDiskMiB: 81}, {orderKey: 'disk'}),
    (error) => error.code === 'RESOURCE_CLAIM_IMPOSSIBLE',
  );
  const blocker = await governor.acquire(
    {browserProcesses: 1, cpuSlots: 1, memoryMiB: 32},
    {orderKey: 'blocker'},
  );
  const controller = new AbortController();
  const queued = governor.acquire(
    {browserProcesses: 1, cpuSlots: 1, memoryMiB: 32},
    {orderKey: 'queued', signal: controller.signal},
  );
  controller.abort();
  await assert.rejects(queued, (error) => error.code === 'CANCELLED');
  assert.equal(governor.snapshot().queued, 0);
  blocker.release();
});
