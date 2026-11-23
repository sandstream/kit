import { parentPort, workerData } from "node:worker_threads";

const data = workerData as { parent: number; delay: number };
const stop = () => process.kill(process.pid, "SIGKILL");
const check = () => {
  if (process.ppid !== data.parent) stop();
};

check();
setInterval(check, 50);
setTimeout(stop, data.delay);
parentPort?.postMessage("ready");
