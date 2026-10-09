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

test("rejects prompts when Pi RPC is unavailable", async () => {
	const response = await fetch(`http://127.0.0.1:${port}/api/prompt`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ message: "test" }),
	});
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "设计服务暂不可用，请稍后重试" });
});

test("rejects fake sessions when Pi RPC is unavailable", async () => {
	const response = await fetch(`http://127.0.0.1:${port}/api/session/new`, { method: "POST" });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "设计服务暂不可用，不能创建新会话" });
});

test("contains no runtime sample content", async () => {
	const response = await fetch(`http://127.0.0.1:${port}/`);
	const html = await response.text();
	assert.doesNotMatch(html, /mrwang|espresso-system|概念方案 A|10:19|68%/);
	assert.doesNotMatch(html, />[^<]*Pi[^<]*</);
	assert.match(html, /id="resultCount">0</);
	assert.match(html, /id="resourceCount">0</);
});
