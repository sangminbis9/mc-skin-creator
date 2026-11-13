import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenWakeController } from '../src/lib/keepAwake.ts';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('releases the wake lock after generation ends, including a quick remount', async () => {
  const actions: string[] = [];
  let finish!: () => void;
  const first = new Promise<void>(resolve => { finish = resolve; });
  let count = 0;
  const controller = createScreenWakeController({
    keepAwake: async () => { actions.push('awake'); if (++count === 1) await first; },
    allowSleep: async () => { actions.push('sleep'); },
  });
  const releaseFirst = controller.acquire();
  await tick();
  releaseFirst();
  const releaseSecond = controller.acquire();
  finish();
  await tick();
  assert.deepEqual(actions, ['awake', 'awake']);
  releaseSecond();
  releaseSecond();
  await tick();
  assert.deepEqual(actions, ['awake', 'awake', 'sleep']);
});

test('a failed wake request does not prevent cleanup or future attempts', async () => {
  const actions: string[] = [];
  const controller = createScreenWakeController({
    keepAwake: async () => { actions.push('awake'); throw new Error('not available'); },
    allowSleep: async () => { actions.push('sleep'); },
  });
  const release = controller.acquire();
  await tick();
  release();
  await tick();
  assert.deepEqual(actions, ['awake', 'sleep']);
});
