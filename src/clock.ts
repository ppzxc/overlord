import type { Clock } from "./types.js";

/** 실제 시계. 종료 신호가 오면 쉬는 것을 바로 끝낸다. */
export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      signal?.addEventListener("abort", done, { once: true });
      function done() {
        clearTimeout(timer);
        resolve();
      }
    }),
};
