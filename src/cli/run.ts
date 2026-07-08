import { runWorkerLoop } from "../worker/loop.js";

runWorkerLoop().catch((err) => {
  console.error("worker loop crashed:", err);
  process.exit(1);
});
