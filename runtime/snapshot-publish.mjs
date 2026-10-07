import fs from "node:fs";

const delays = [10, 20, 40, 80, 160];
const wait = new Int32Array(new SharedArrayBuffer(4));
const transient = new Set(["EPERM", "EBUSY", "EACCES"]);

// Publish a complete staged directory. Existing destinations belong to another
// publication and must be checked by the caller, never replaced or removed.
export function publishSnapshot(staging, destination) {
  for (let attempt = 0; ; attempt++) {
    if (fs.existsSync(destination)) return false;
    try { fs.renameSync(staging, destination); return true; }
    catch (error) {
      if (fs.existsSync(destination)) return false;
      if (!transient.has(error.code) || attempt >= delays.length) throw error;
      Atomics.wait(wait, 0, 0, delays[attempt]);
    }
  }
}
