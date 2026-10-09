import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const publicDirectory = join(root, "public");
const portArgument = process.argv.findIndex((value) => value === "--port");
const hostArgument = process.argv.findIndex((value) => value === "--host");
const port = Number(process.env.PORT || (portArgument >= 0 ? process.argv[portArgument + 1] : 4318));
const host = process.env.HOST || (hostArgument >= 0 ? process.argv[hostArgument + 1] : "127.0.0.1");
const clients = new Set();
const pending = new Map();
let rpcProcess;
let rpcBuffer = "";
let requestSequence = 0;
let mockTimers = [];

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
	rpcProcess = spawn(resolved.command, [...resolved.args, "--mode", "rpc", "--no-session"], {
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
				emit("gateway_error", { message: `Pi 返回了无效数据：${error.message}` });
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
			reject(new Error("Pi RPC 请求超时"));
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

function clearMockTimers() {
	for (const timer of mockTimers) clearTimeout(timer);
	mockTimers = [];
}

function runMock(message) {
	clearMockTimers();
	const steps = [
		[500, "run_started", { title: message.slice(0, 36), startedAt: Date.now() }],
		[900, "step", { index: 0, status: "done", detail: "已提取场景、尺寸与体验目标" }],
		[1500, "step", { index: 1, status: "done", detail: "完成 8 个竞品特征归纳" }],
		[2100, "step", { index: 2, status: "done", detail: "确定模块化、便携、专业萃取" }],
		[2300, "step", { index: 3, status: "running", detail: "正在生成产品概念图…", progress: 24 }],
		[3000, "tool", { name: "AI 图像生成", elapsed: "00:00:18", prompt: "模块化便携式意式咖啡机，户外场景，极简工业设计，金属质感" }],
		[3900, "step", { index: 3, status: "running", detail: "概念图细节渲染中…", progress: 68 }],
		[4700, "permission", { title: "需要访问素材库", description: "为保证 CMF 建议准确，需要读取当前项目的材质样本（仅用于本次任务分析）。" }],
	];
	mockTimers = steps.map(([delay, event, payload]) => setTimeout(() => emit(event, payload), delay));
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
			response.write(`event: connection\ndata: ${JSON.stringify({ connected: Boolean(rpcProcess), mode: resolvePiCommand() ? "rpc-ready" : "demo", detail: resolvePiCommand() ? "Pi 可连接" : "演示模式：构建 Pi CLI 或设置 PI_CLI_PATH 后自动连接" })}\n\n`);
			request.on("close", () => clients.delete(response));
			return;
		}
		if (request.method === "POST" && url.pathname === "/api/prompt") {
			const body = await readJson(request);
			if (typeof body.message !== "string" || !body.message.trim()) return json(response, 400, { error: "请输入任务" });
			if (body.thinking) await sendRpc({ type: "set_thinking_level", level: "high" });
			const images = Array.isArray(body.images)
				? body.images.filter((image) => image && image.type === "image" && typeof image.data === "string" && /^image\/(png|jpeg|webp)$/.test(image.mimeType)).slice(0, 4)
				: undefined;
			const rpcResponse = await sendRpc({ type: "prompt", message: body.message.trim(), ...(images?.length ? { images } : {}) });
			if (!rpcResponse) runMock(body.message.trim());
			return json(response, 202, { accepted: true, mode: rpcResponse ? "rpc" : "demo" });
		}
		if (request.method === "POST" && url.pathname === "/api/abort") {
			clearMockTimers();
			const rpcResponse = await sendRpc({ type: "abort" });
			emit("aborted", { at: Date.now() });
			return json(response, 200, { stopped: true, mode: rpcResponse ? "rpc" : "demo" });
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
		if (request.method === "GET" && url.pathname === "/api/state") {
			const rpcResponse = await sendRpc({ type: "get_state" });
			return json(response, 200, rpcResponse?.data || { mode: "demo" });
		}
		if (request.method === "GET" && url.pathname === "/api/health") {
			return json(response, 200, { ok: true, pi: resolvePiCommand() ? "available" : "demo" });
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
		clearMockTimers();
		rpcProcess?.stdin.end();
		server.close(() => process.exit(0));
	});
}
