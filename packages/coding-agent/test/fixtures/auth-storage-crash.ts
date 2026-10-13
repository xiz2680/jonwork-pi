import { FileAuthStorageBackend } from "../../src/core/auth-storage.ts";

const [authPath, boundary] = process.argv.slice(2);
if (!authPath || !boundary) throw new Error("auth path and crash boundary are required");

const crash = () => process.kill(process.pid, "SIGKILL");
const backend = new FileAuthStorageBackend(authPath, {
	...(boundary === "temp-fsync" ? { afterTempFsync: crash } : {}),
	...(boundary === "rename" ? { afterRename: crash } : {}),
});
backend.withLock((current) => {
	const data = current ? (JSON.parse(current) as Record<string, unknown>) : {};
	return {
		result: undefined,
		next: JSON.stringify({ ...data, openai: { type: "api_key", key: "new" } }),
	};
});
