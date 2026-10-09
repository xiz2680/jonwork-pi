import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(root, "public");
const portArgument = process.argv.findIndex((value) => value === "--port");
const hostArgument = process.argv.findIndex((value) => value === "--host");
const port = Number(process.env.PORT || (portArgument >= 0 ? process.argv[portArgument + 1] : 4318));
const host = process.env.HOST || (hostArgument >= 0 ? process.argv[hostArgument + 1] : "127.0.0.1");
const relayBaseUrl = (process.env.JONWORK_API_BASE_URL || "https://newapi.rivarouter.com/v1").replace(/\/$/, "");
const relayChatModel = process.env.JONWORK_CHAT_MODEL || "gpt-6.1-sol";
const relayImageModel = process.env.JONWORK_IMAGE_MODEL || "gpt-image-2";
const clients = new Set();
const pending = new Map();
let rpcProcess;
let rpcBuffer = "";
let requestSequence = 0;
const systemPrompt = "You are Jonwork, an industrial design assistant. Speak only from the product user's perspective and never mention Pi, RPC, CLI, OpenRouter, providers, credentials, backend implementation, or other infrastructure. Never claim that an image, file, research result, or tool output exists unless a tool actually produced it in this turn. For image or concept-render requests, use codemode image generation when an available image model exists. If image generation is unavailable, state only that image generation is currently unavailable and still provide a useful text design specification.";

const mimeTypes = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".png": "image/png",
};

function emit(event, data) {
	const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const client of clients) client.write(frame);
}

function resolvePiCommand() {
	if (process.env.PI_DISABLE_RPC === "1") return null;
	if (process.env.PI_CLI_PATH) return { command: process.execPath, args: [process.env.PI_CLI_PATH] };
	const localCli = join(root, "../coding-agent/dist/cli.js");
	if (existsSync(localCli)) return { command: process.execPath, args: [localCli] };
	return null;
}

function handleRpcRecord(record) {
	if (record.type === "response" && record.id) {
		const resolver = pending.get(record.id);
		if (resolver) {
			pending.delete(record.id);
			resolver(record);
		}
	}
	emit("pi", record);
}

async function startPi() {
	if (rpcProcess) return true;
	const resolved = resolvePiCommand();
	if (!resolved) return false;
	rpcProcess = spawn(resolved.command, [...resolved.args, "--mode", "rpc", "--no-session", "--tools", "+codemode", "--append-system-prompt", systemPrompt], {
		cwd: process.env.PI_WORKING_DIRECTORY || process.cwd(),
		stdio: ["pipe", "pipe", "pipe"],
	});
	rpcProcess.stdout.on("data", (chunk) => {
		rpcBuffer += chunk.toString("utf8");
		for (;;) {
			const newline = rpcBuffer.indexOf("\n");
			if (newline < 0) break;
			const line = rpcBuffer.slice(0, newline).replace(/\r$/, "");
			rpcBuffer = rpcBuffer.slice(newline + 1);
			if (!line) continue;
			try {
				handleRpcRecord(JSON.parse(line));
			} catch (error) {
				emit("gateway_error", { message: `设计服务返回了无效数据：${error.message}` });
			}
		}
	});
	rpcProcess.stderr.on("data", (chunk) => emit("diagnostic", { message: chunk.toString("utf8") }));
	rpcProcess.on("exit", (code) => {
		rpcProcess = undefined;
		emit("connection", { connected: false, mode: "offline", detail: `Pi 进程已退出 (${code ?? "signal"})` });
	});
	emit("connection", { connected: true, mode: "rpc", detail: "Pi RPC 已连接" });
	return true;
}

async function sendRpc(command) {
	if (!(await startPi())) return null;
	const id = `web-${++requestSequence}`;
	const record = { ...command, id };
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			pending.delete(id);
			reject(new Error("设计服务响应超时"));
		}, 15000);
		pending.set(id, (response) => {
			clearTimeout(timeout);
			resolve(response);
		});
		rpcProcess.stdin.write(`${JSON.stringify(record)}\n`);
	});
}

async function sendExtensionResponse(response) {
	if (!(await startPi())) return false;
	rpcProcess.stdin.write(`${JSON.stringify({ type: "extension_ui_response", ...response })}\n`);
	return true;
}

function hasImageGeneration() {
	if (process.env.JONWORK_API_KEY) return true;
	if (process.env.OPENROUTER_API_KEY) return true;
	try {
		const auth = JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8"));
		return Boolean(auth.openrouter);
	} catch {
		return false;
	}
}

async function generateRelayImage(prompt) {
	if (!process.env.JONWORK_API_KEY) throw new Error("图片生成服务尚未配置");
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 180_000);
	try {
		const relayResponse = await fetch(`${relayBaseUrl}/responses`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${process.env.JONWORK_API_KEY}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: relayChatModel,
				input: prompt,
				tools: [{ type: "image_generation", model: relayImageModel, size: "1536x1024", quality: "high", output_format: "png" }],
				tool_choice: { type: "image_generation" },
			}),
			signal: controller.signal,
		});
		if (!relayResponse.ok) throw new Error(`图片服务请求失败（${relayResponse.status}）`);
		const payload = await relayResponse.json();
		const output = Array.isArray(payload.output) ? payload.output.find((item) => item?.type === "image_generation_call" && typeof item.result === "string") : undefined;
		if (!output) throw new Error("图片服务未返回有效图片");
		return { data: output.result, mimeType: "image/png", revisedPrompt: output.revised_prompt || prompt };
	} catch (error) {
		if (error?.name === "AbortError") throw new Error("图片生成超时，请稍后重试");
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function readJson(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 5 * 1024 * 1024) throw new Error("请求内容超过 5 MB 限制");
		chunks.push(chunk);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function json(response, status, payload) {
	response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(payload));
}

function applySecurityHeaders(response) {
	response.setHeader("x-content-type-options", "nosniff");
	response.setHeader("referrer-policy", "no-referrer");
	response.setHeader("permissions-policy", "camera=(), geolocation=(), payment=()");
	response.setHeader("content-security-policy", "default-src 'self'; script-src 'self' https://code.iconify.design; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'");
}

function serveFile(pathname, response) {
	const relative = pathname === "/" ? "index.html" : pathname.slice(1);
	const target = normalize(join(publicDirectory, relative));
	if (!target.startsWith(publicDirectory) || !existsSync(target)) return false;
	response.writeHead(200, { "content-type": mimeTypes[extname(target)] || "application/octet-stream" });
	createReadStream(target).pipe(response);
	return true;
}

const server = createServer(async (request, response) => {
	applySecurityHeaders(response);
	const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
	try {
		if (request.method === "GET" && url.pathname === "/api/events") {
			response.writeHead(200, {
				"cache-control": "no-cache",
				connection: "keep-alive",
				"content-type": "text/event-stream",
			});
			clients.add(response);
			response.write(`event: connection\ndata: ${JSON.stringify({ connected: Boolean(rpcProcess), mode: resolvePiCommand() ? "rpc-ready" : "unavailable", detail: resolvePiCommand() ? "Pi 可连接" : "Pi CLI 不可用" })}\n\n`);
			request.on("close", () => clients.delete(response));
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/prompt") {
			const body = await readJson(request);
			if (typeof body.message !== "string" || !body.message.trim()) return json(response, 400, { error: "请输入任务" });
			const thinkingResponse = await sendRpc({ type: "set_thinking_level", level: body.thinking ? "high" : "off" });
			if (!thinkingResponse) return json(response, 503, { error: "设计服务暂不可用，请稍后重试" });
			const images = Array.isArray(body.images)
				? body.images.filter((image) => image && image.type === "image" && typeof image.data === "string" && /^image\/(png|jpeg|webp)$/.test(image.mimeType)).slice(0, 4)
				: undefined;
			const rpcResponse = await sendRpc({ type: "prompt", message: body.message.trim(), ...(images?.length ? { images } : {}) });
			if (!rpcResponse) return json(response, 503, { error: "设计服务暂不可用，请稍后重试" });
			return json(response, 202, { accepted: true, mode: "rpc", imageGeneration: hasImageGeneration(), relayImageGeneration: Boolean(process.env.JONWORK_API_KEY) });
		}
		if (request.method === "POST" && url.pathname === "/api/images/generate") {
			const body = await readJson(request);
			if (typeof body.prompt !== "string" || !body.prompt.trim()) return json(response, 400, { error: "请输入图片设计要求" });
			if (!process.env.JONWORK_API_KEY) return json(response, 503, { error: "图片生成服务尚未配置" });
			const image = await generateRelayImage(body.prompt.trim());
			return json(response, 200, image);
		}
		if (request.method === "POST" && url.pathname === "/api/abort") {
			const rpcResponse = await sendRpc({ type: "abort" });
			if (!rpcResponse) return json(response, 503, { error: "设计服务暂不可用，请稍后重试" });
			emit("aborted", { at: Date.now() });
			return json(response, 200, { stopped: true, mode: "rpc" });
		}
		if (request.method === "POST" && url.pathname === "/api/permission") {
			const body = await readJson(request);
			if (typeof body.id === "string") {
				const reply = body.cancelled ? { id: body.id, cancelled: true } : body.method === "confirm" ? { id: body.id, confirmed: Boolean(body.allowed) } : { id: body.id, value: String(body.value ?? "") };
				await sendExtensionResponse(reply);
			}
			emit("permission_resolved", { allowed: Boolean(body.allowed) });
			return json(response, 200, { ok: true });
		}
		if (request.method === "POST" && url.pathname === "/api/session/new") {
			const rpcResponse = await sendRpc({ type: "new_session" });
			if (!rpcResponse) return json(response, 503, { error: "设计服务暂不可用，不能创建新会话" });
			if (rpcResponse && rpcResponse.success === false) return json(response, 409, { error: rpcResponse.error || "暂时无法创建新会话" });
			if (rpcResponse?.data?.cancelled) return json(response, 409, { error: "新会话已取消" });
			emit("session_created", { at: Date.now() });
			return json(response, 201, { created: true, mode: "rpc" });
		}
		if (request.method === "GET" && url.pathname === "/api/state") {
			const rpcResponse = await sendRpc({ type: "get_state" });
			if (!rpcResponse) return json(response, 503, { error: "设计服务暂不可用，请稍后重试" });
			return json(response, 200, rpcResponse.data);
		}
		if (request.method === "POST" && url.pathname === "/api/model/cycle") {
			const rpcResponse = await sendRpc({ type: "cycle_model" });
			if (!rpcResponse) return json(response, 503, { error: "设计服务暂不可用，请稍后重试" });
			if (rpcResponse.success === false) return json(response, 409, { error: rpcResponse.error || "无法切换模型" });
			return json(response, 200, rpcResponse.data || { model: null });
		}
		if (request.method === "GET" && url.pathname === "/api/health") {
			return json(response, 200, { ok: true, pi: resolvePiCommand() ? "available" : "unavailable", imageGeneration: hasImageGeneration(), relayImageGeneration: Boolean(process.env.JONWORK_API_KEY), chatModel: relayChatModel });
		}
		if (request.method === "GET" && serveFile(url.pathname, response)) return;
		json(response, 404, { error: "Not found" });
	} catch (error) {
		json(response, 500, { error: error instanceof Error ? error.message : String(error) });
	}
});

server.listen(port, host, () => {
	console.log(`Jonwork Pi Web: http://${host}:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		rpcProcess?.stdin.end();
		server.close(() => process.exit(0));
	});
}
