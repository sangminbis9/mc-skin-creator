import { KeepAwake } from "@capacitor-community/keep-awake";

type ScreenWake = { keepAwake(): Promise<void>; allowSleep(): Promise<void> };

// Serialize plugin calls so a fast unmount/remount cannot release a newer lock.
export function createScreenWakeController(plugin: ScreenWake) {
  let leases = 0;
  let queue: Promise<void> = Promise.resolve();
  const schedule = (operation: () => Promise<void>) => {
    queue = queue.then(operation).catch(() => undefined);
  };
  return {
    acquire() {
      leases++;
      schedule(async () => { if (leases > 0) await plugin.keepAwake(); });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leases--;
        schedule(async () => { if (leases === 0) await plugin.allowSleep(); });
      };
    },
  };
}

export const generationScreenWake = createScreenWakeController(KeepAwake);
