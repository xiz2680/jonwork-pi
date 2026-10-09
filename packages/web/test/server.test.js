import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { after, before, test } from "node:test";

const port = 4327;
let child;

async function waitForServer(targetPort) {
	for (let attempt = 0; attempt < 30; attempt++) {
		try {
			const response = await fetch(`http://127.0.0.1:${targetPort}/api/health`);
			if (response.ok) return;
		} catch {}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`test server ${targetPort} did not start`);
}

before(async () => {
	child = spawn(process.execPath, ["server.js", "--port", String(port)], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, PI_DISABLE_RPC: "1" },
		stdio: "ignore",
	});
	await waitForServer(port);
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
	assert.match(html, /aria-label="快捷创作"/);
	assert.match(html, /data-quick-action="image"/);
});

test("rejects relay image generation when its server secret is absent", async () => {
	const response = await fetch(`http://127.0.0.1:${port}/api/images/generate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ prompt: "生成产品概念图" }),
	});
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: "图片生成服务尚未配置" });
});

test("uses gpt-6.1-sol to orchestrate relay image generation", async () => {
	const relayPort = 4328;
	const appPort = 4329;
	let relayRequest;
	const relay = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		relayRequest = { url: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ output: [{ type: "image_generation_call", result: Buffer.from("fake-png").toString("base64"), revised_prompt: "精炼后的概念图提示" }] }));
	});
	await new Promise((resolve) => relay.listen(relayPort, "127.0.0.1", resolve));
	const relayApp = spawn(process.execPath, ["server.js", "--port", String(appPort)], {
		cwd: new URL("..", import.meta.url),
		env: { ...process.env, PI_DISABLE_RPC: "1", JONWORK_API_KEY: "test-only-key", JONWORK_API_BASE_URL: `http://127.0.0.1:${relayPort}/v1` },
		stdio: "ignore",
	});
	try {
		await waitForServer(appPort);
		const response = await fetch(`http://127.0.0.1:${appPort}/api/images/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ prompt: "生成产品概念图" }),
		});
		assert.equal(response.status, 200);
		assert.equal((await response.json()).mimeType, "image/png");
		assert.equal(relayRequest.url, "/v1/responses");
		assert.equal(relayRequest.authorization, "Bearer test-only-key");
		assert.equal(relayRequest.body.model, "gpt-6.1-sol");
		assert.equal(relayRequest.body.tools[0].type, "image_generation");
		assert.equal(relayRequest.body.tools[0].model, "gpt-image-2");
		assert.deepEqual(relayRequest.body.tool_choice, { type: "image_generation" });
	} finally {
		relayApp.kill("SIGTERM");
		await new Promise((resolve) => relay.close(resolve));
	}
});
