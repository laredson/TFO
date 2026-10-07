import fs from "node:fs";

const delays = [10, 20, 40, 80, 160];
const wait = new Int32Array(new SharedArrayBuffer(4));
const transient = new Set(["EPERM", "EBUSY", "EACCES"]);

// Retry publication of the same staged bytes. The previous state stays intact
// until rename succeeds; callers retain their own locks, cleanup and CAS rules.
export function replaceAtomicFile(staged, destination) {
  for (let attempt = 0; ; attempt++) {
    try { return fs.renameSync(staged, destination); }
    catch (error) {
      if (!transient.has(error.code) || attempt >= delays.length) throw error;
      Atomics.wait(wait, 0, 0, delays[attempt]);
    }
  }
}
