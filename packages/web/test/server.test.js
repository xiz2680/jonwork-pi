import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";

const port = 4327;
let child;

before(async () => {
	child = spawn(process.execPath, ["server.js", "--port", String(port)], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, PI_DISABLE_RPC: "1" },
		stdio: "ignore",
	});
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/api/health`);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("test server did not start");
});

after(() => child?.kill("SIGTERM"));

test("serves the application with security headers", async () => {
	const response = await fetch(`http://127.0.0.1:${port}/`);
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.match(await response.text(), /Jonwork/);
});

test("validates empty prompts", async () => {
	const response = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: " " }),
	});
	assert.equal(response.status, 400);
});

test("accepts a prompt in explicit demo mode", async () => {
	const response = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "test" }),
	});
	assert.deepEqual(await response.json(), { accepted: true, mode: "demo" });
});
