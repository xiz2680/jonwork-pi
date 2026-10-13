import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidPath = process.argv[2];
if (!pidPath) throw new Error("pid path is required");
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
if (!descendant.pid) throw new Error("descendant failed to start");
writeFileSync(pidPath, String(descendant.pid));
setInterval(() => {}, 1000);
