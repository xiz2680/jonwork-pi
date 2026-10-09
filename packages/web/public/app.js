const elements = {
	composer: document.querySelector("#composer"),
	prompt: document.querySelector("#promptInput"),
	send: document.querySelector("#sendButton"),
	stop: document.querySelector("#stopButton"),
	retry: document.querySelector("#retryButton"),
	runPanel: document.querySelector("#runPanel"),
	progress: document.querySelector("#progressBar"),
	progressCount: document.querySelector("#progressCount"),
	permission: document.querySelector("#permissionCard"),
	connection: document.querySelector(".connection"),
	connectionLabel: document.querySelector("#connectionLabel"),
	runStatus: document.querySelector("#runStatus"),
	messageScroll: document.querySelector("#messageScroll"),
	toast: document.querySelector("#toast"),
	attachmentList: document.querySelector("#attachmentList"),
	fileInput: document.querySelector("#fileInput"),
};

let isRunning = false;
let streamedText = "";
let pendingPermission = null;
let attachments = [];
let runStartedAt = Date.now();
let stepSequence = 0;
let hasConversationTask = false;
let lastPrompt = "";
let sessionResults = [];
let sessionResources = [];
const renderedImages = new Set();

const toolLabels = {
	read: "读取项目资料",
	bash: "执行工作区任务",
	edit: "更新设计文件",
	write: "创建设计文件",
	codemode: "生成或分析设计产出",
};

function showToast(message) {
	elements.toast.textContent = message;
	elements.toast.classList.add("show");
	setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

function resizePrompt() {
	elements.prompt.style.height = "auto";
	const height = Math.min(elements.prompt.scrollHeight, 168);
	elements.prompt.style.height = `${height}px`;
	elements.prompt.style.overflowY = elements.prompt.scrollHeight > 168 ? "auto" : "hidden";
}

function updateSendAvailability() {
	elements.send.disabled = !isRunning && !elements.prompt.value.trim();
}

function setRunning(running) {
	isRunning = running;
	elements.send.classList.toggle("running", running);
	elements.send.innerHTML = `<iconify-icon icon="${running ? "solar:stop-bold" : "solar:arrow-up-linear"}"></iconify-icon>`;
	elements.runStatus.textContent = running ? "运行中" : "空闲";
	elements.stop.disabled = !running;
	elements.retry.disabled = running || !hasConversationTask;
	updateSendAvailability();
}

function updateRunProgress() {
	const steps = [...document.querySelectorAll("#steps > li")];
	const completed = steps.filter((step) => step.classList.contains("done")).length;
	const progress = steps.length ? Math.round((completed / steps.length) * 100) : 0;
	elements.progress.style.width = `${progress}%`;
	elements.progressCount.textContent = `${completed} / ${steps.length}`;
}

function addRunStep(key, title, detail, status = "running") {
	const list = document.querySelector("#steps");
	let item = list.querySelector(`[data-step-key="${key}"]`);
	if (!item) {
		item = document.createElement("li");
		item.dataset.stepKey = key;
		item.innerHTML = '<span class="step-state"></span><div><strong></strong><small></small></div><time></time>';
		list.append(item);
	}
	item.className = status;
	item.querySelector("strong").textContent = title;
	item.querySelector("small").textContent = detail;
	item.querySelector("time").textContent = currentTime();
	item.querySelector(".step-state").innerHTML = status === "done" ? '<iconify-icon icon="solar:check-circle-bold"></iconify-icon>' : "";
	updateRunProgress();
	return item;
}

function completeRunStep(key, detail) {
	const item = document.querySelector(`#steps [data-step-key="${key}"]`);
	if (!item) return;
	item.className = "done";
	if (detail) item.querySelector("small").textContent = detail;
	item.querySelector("time").textContent = currentTime();
	item.querySelector(".step-state").innerHTML = '<iconify-icon icon="solar:check-circle-bold"></iconify-icon>';
	updateRunProgress();
}

function messageText(message) {
	if (!message || message.role !== "assistant") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("");
}

function updateTabCounts() {
	document.querySelector("#resultCount").textContent = String(sessionResults.length);
	document.querySelector("#resourceCount").textContent = String(sessionResources.length);
}

function recordResult(text) {
	if (!text || sessionResults.at(-1) === text) return;
	sessionResults.push(text);
	updateTabCounts();
}

function wantsImage(text) {
	return /图|图片|效果图|概念图|渲染|视觉|image|render/i.test(text);
}

function appendGeneratedImage(image) {
	if (!image || typeof image.data !== "string" || typeof image.mimeType !== "string") return;
	const key = `${image.mimeType}:${image.data.length}:${image.data.slice(0, 24)}`;
	if (renderedImages.has(key)) return;
	renderedImages.add(key);
	const body = [...document.querySelectorAll(".assistant-message .message-body")].at(-1);
	if (!body) return;
	const imageNumber = sessionResources.filter((item) => item.type === "image").length + 1;
	const figure = document.createElement("figure");
	figure.className = "result-figure generated-result";
	const element = document.createElement("img");
	element.src = `data:${image.mimeType};base64,${image.data}`;
	element.alt = image.revisedPrompt || "根据当前会话动态生成的设计图";
	const caption = document.createElement("figcaption");
	caption.innerHTML = '<span><iconify-icon icon="solar:gallery-check-linear"></iconify-icon>本次会话生成的设计图</span><span class="figure-actions"><button class="icon-button download-generated" aria-label="下载图片" title="下载图片"><iconify-icon icon="solar:download-minimalistic-linear"></iconify-icon></button><button class="icon-button zoom-generated" aria-label="放大查看" title="放大查看"><iconify-icon icon="solar:maximize-square-minimalistic-linear"></iconify-icon></button></span>';
	figure.append(element, caption);
	body.append(figure);
	sessionResources.push({ type: "image", name: `生成设计图 ${imageNumber}` });
	sessionResults.push(`图片：生成设计图 ${imageNumber}`);
	updateTabCounts();
	elements.messageScroll.scrollTo({ top: elements.messageScroll.scrollHeight, behavior: "smooth" });
}

function renderImagesFromMessages(messages) {
	const images = [];
	const visit = (value) => {
		if (!value || typeof value !== "object") return;
		if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") images.push(value);
		else if (Array.isArray(value)) value.forEach(visit);
		else Object.values(value).forEach(visit);
	};
	visit(messages);
	images.forEach(appendGeneratedImage);
}

async function generateConversationImage(prompt) {
	addRunStep("image-generation", "生成概念图", "正在生成真实设计图");
	elements.runPanel.classList.add("open");
	try {
		const image = await post("/api/images/generate", { prompt });
		appendGeneratedImage(image);
		completeRunStep("image-generation", "设计图已生成");
		showToast("设计图已生成，可放大或下载");
	} catch (error) {
		completeRunStep("image-generation", "生成失败，可稍后重试");
		showToast(error.message);
	}
}

function resetRunSteps() {
	document.querySelector("#steps").replaceChildren();
	stepSequence = 0;
	updateRunProgress();
}

function currentTime() {
	return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

function appendInlineText(container, text) {
	const parts = text.split(/(\*\*[^*]+\*\*)/g);
	for (const part of parts) {
		if (part.startsWith("**") && part.endsWith("**")) {
			const strong = document.createElement("strong");
			strong.textContent = part.slice(2, -2);
			container.append(strong);
		} else if (part) container.append(document.createTextNode(part));
	}
}

function renderMarkdown(container, text) {
	container.replaceChildren();
	let list;
	let paragraph;
	const lines = text.split("\n");
	const flushParagraph = () => {
		if (paragraph) container.append(paragraph);
		paragraph = undefined;
	};
	const flushList = () => {
		if (list) container.append(list);
		list = undefined;
	};
	const tableCells = (line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index];
		const line = rawLine.trim();
		if (!line) {
			flushParagraph();
			flushList();
			continue;
		}
		if (line.startsWith("|") && /^\|?\s*:?-{3,}/.test(lines[index + 1]?.trim() || "")) {
			flushParagraph();
			flushList();
			const wrapper = document.createElement("div");
			wrapper.className = "markdown-table";
			const table = document.createElement("table");
			const head = document.createElement("thead");
			const headRow = document.createElement("tr");
			for (const value of tableCells(line)) {
				const cell = document.createElement("th");
				appendInlineText(cell, value);
				headRow.append(cell);
			}
			head.append(headRow);
			table.append(head);
			index += 2;
			const body = document.createElement("tbody");
			while (index < lines.length && lines[index].trim().startsWith("|")) {
				const row = document.createElement("tr");
				for (const value of tableCells(lines[index].trim())) {
					const cell = document.createElement("td");
					appendInlineText(cell, value);
					row.append(cell);
				}
				body.append(row);
				index += 1;
			}
			index -= 1;
			table.append(body);
			wrapper.append(table);
			container.append(wrapper);
			continue;
		}
		const heading = /^(#{1,3})\s+(.+)$/.exec(line);
		if (heading) {
			flushParagraph();
			flushList();
			const element = document.createElement(heading[1].length === 1 ? "h2" : "h3");
			appendInlineText(element, heading[2]);
			container.append(element);
			continue;
		}
		const bullet = /^[-*]\s+(.+)$/.exec(line);
		if (bullet) {
			flushParagraph();
			list ||= document.createElement("ul");
			const item = document.createElement("li");
			appendInlineText(item, bullet[1]);
			list.append(item);
			continue;
		}
		flushList();
		paragraph ||= document.createElement("p");
		if (paragraph.childNodes.length) paragraph.append(" ");
		appendInlineText(paragraph, line);
	}
	flushParagraph();
	flushList();
}

function removeEmptyState() {
	document.querySelector("#emptyConversation")?.remove();
}

function appendMessage(role, text = "") {
	removeEmptyState();
	const article = document.createElement("article");
	article.className = `message ${role}-message`;
	const avatar = document.createElement("div");
	avatar.className = `avatar ${role === "user" ? "user-avatar" : "ai-avatar"}`;
	avatar.textContent = role === "user" ? "本" : "J";
	const body = document.createElement("div");
	body.className = "message-body";
	const meta = document.createElement("div");
	meta.className = "message-meta";
	const author = document.createElement("strong");
	author.textContent = role === "user" ? "我" : "Jonwork";
	const time = document.createElement("time");
	time.textContent = currentTime();
	meta.append(author, time);
	const content = document.createElement("div");
	content.className = role === "user" ? "user-bubble" : "assistant-text assistant-content";
	content.textContent = text;
	body.append(meta, content);
	article.append(avatar, body);
	elements.messageScroll.append(article);
	elements.messageScroll.scrollTop = elements.messageScroll.scrollHeight;
	return content;
}

function resetConversation() {
	elements.messageScroll.replaceChildren();
	const empty = document.createElement("div");
	empty.className = "empty-conversation";
	empty.id = "emptyConversation";
	empty.innerHTML = '<span class="ai-avatar avatar">J</span><h2>今天想设计什么？</h2><p>输入任务后，Jonwork 会完成分析、工具调用和方案输出。</p>';
	elements.messageScroll.append(empty);
	document.querySelector(".conversation-header h1").textContent = "新对话";
	document.querySelector("#runTitle").textContent = "等待任务";
	document.querySelector("#elapsed").textContent = "00:00";
	elements.progress.style.width = "0";
	elements.progressCount.textContent = "0 / 6";
	elements.permission.classList.add("resolved");
	hasConversationTask = false;
	lastPrompt = "";
	sessionResults = [];
	sessionResources = [];
	renderedImages.clear();
	updateTabCounts();
	resetRunSteps();
	document.querySelectorAll(".run-tabs [role='tab']").forEach((tab) => {
		const active = tab.dataset.tab === "process";
		tab.classList.toggle("active", active);
		tab.setAttribute("aria-selected", String(active));
	});
	document.querySelector("#tabPanel").replaceChildren();
	document.querySelector("#tabPanel").hidden = true;
	elements.permission.hidden = false;
	runStartedAt = Date.now();
	document.querySelector("#elapsed").textContent = "00:00";
	document.querySelector("#steps").hidden = true;
	setRunning(false);
}

function addHistoryItem(title) {
	const list = document.querySelector("#historyList");
	list.replaceChildren();
	const button = document.createElement("button");
	button.className = "history-item selected";
	button.innerHTML = `<iconify-icon icon="solar:chat-round-linear"></iconify-icon><span><strong></strong><small>刚刚</small></span>`;
	button.querySelector("strong").textContent = title;
	list.prepend(button);
}

async function post(path, body = {}) {
	const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || "请求失败");
	return data;
}

function handlePiEvent(record) {
	if (record.type === "agent_start") {
		setRunning(true);
		completeRunStep("connection", "设计服务已开始处理");
		addRunStep("analysis", "分析设计任务", "正在理解需求并规划方案");
	}
	if (record.type === "agent_settled" || record.type === "agent_end") {
		if (!document.querySelector('#steps [data-step-key="response"]')) addRunStep("response", "生成回复", "本轮处理已结束", "done");
		completeRunStep("response", "回复已生成");
		document.querySelectorAll("#steps > li.running").forEach((item) => completeRunStep(item.dataset.stepKey, "已完成"));
		setRunning(false);
		elements.runStatus.textContent = "已完成";
	}
	if (record.type === "tool_execution_start") {
		completeRunStep("analysis", "分析完成");
		const key = `tool-${++stepSequence}`;
		addRunStep(key, toolLabels[record.toolName] || record.toolName || "设计工具调用", "正在执行任务");
		if (record.toolCallId) document.querySelector(`#steps [data-step-key="${key}"]`).dataset.toolCallId = record.toolCallId;
		elements.runPanel.classList.add("open");
	}
	if (record.type === "tool_execution_end") {
		const item = record.toolCallId ? document.querySelector(`#steps [data-tool-call-id="${record.toolCallId}"]`) : [...document.querySelectorAll("#steps > li.running")].at(-1);
		if (item) completeRunStep(item.dataset.stepKey, record.isError ? "工具执行失败" : "工具执行完成");
	}
	if (record.type === "message_update" && record.assistantMessageEvent?.type === "text_delta") {
		completeRunStep("analysis", "分析完成");
		addRunStep("response", "生成回复", "正在流式输出结果");
		streamedText += record.assistantMessageEvent.delta;
		const target = [...document.querySelectorAll(".assistant-text")].at(-1) || appendMessage("assistant");
		renderMarkdown(target, streamedText);
	}
	if (record.type === "message_end") {
		const finalText = messageText(record.message);
		if (finalText) {
			streamedText = finalText;
			const target = [...document.querySelectorAll(".assistant-text")].at(-1) || appendMessage("assistant");
			renderMarkdown(target, finalText);
			recordResult(finalText);
		}
		renderImagesFromMessages(record.message);
	}
	if (record.type === "agent_end" && Array.isArray(record.messages)) {
		const finalText = messageText([...record.messages].reverse().find((message) => message?.role === "assistant"));
		if (finalText) {
			streamedText = finalText;
			const target = [...document.querySelectorAll(".assistant-text")].at(-1) || appendMessage("assistant");
			renderMarkdown(target, finalText);
			recordResult(finalText);
		}
		renderImagesFromMessages(record.messages);
	}
	if (record.type === "extension_ui_request") {
		if (record.method === "notify") return showToast(record.message);
		if (record.method === "setTitle") document.querySelector(".conversation-header h1").textContent = record.title;
			if (record.method === "set_editor_text") {
				const editorText = String(record.text ?? "");
				elements.prompt.value = /^[>›❯\s]+$/.test(editorText) ? "" : editorText;
			resizePrompt();
			updateSendAvailability();
		}
		if (["confirm", "select", "input", "editor"].includes(record.method)) {
			pendingPermission = record;
			elements.permission.querySelector("strong").textContent = record.title || "需要你的确认";
			elements.permission.querySelector("p").textContent = record.message || (record.options ? `可选项：${record.options.join("、")}` : record.placeholder || "请确认是否继续");
			elements.permission.classList.remove("resolved");
			elements.runPanel.classList.add("open");
		}
	}
	if (record.type === "model_change" && record.model?.name) document.querySelector("#modelLabel").textContent = record.model.name;
}

const events = new EventSource("/api/events");
events.addEventListener("connection", ({ data }) => {
	const state = JSON.parse(data);
	elements.connection.classList.toggle("connected", state.connected || state.mode === "rpc-ready");
	elements.connectionLabel.textContent = state.mode === "unavailable" ? "服务暂不可用" : state.connected ? "服务正常" : "服务准备就绪";
});
events.addEventListener("pi", ({ data }) => handlePiEvent(JSON.parse(data)));
events.addEventListener("run_started", ({ data }) => {
	const state = JSON.parse(data);
	document.querySelector("#runTitle").textContent = state.title;
	setRunning(true);
	runStartedAt = state.startedAt || Date.now();
	elements.runPanel.classList.add("open");
	elements.permission.classList.remove("resolved");
});
events.addEventListener("permission", ({ data }) => {
	const permission = JSON.parse(data);
	elements.permission.querySelector("strong").textContent = permission.title;
	elements.permission.querySelector("p").textContent = permission.description;
	elements.permission.classList.remove("resolved");
});
events.addEventListener("permission_resolved", ({ data }) => {
	const result = JSON.parse(data);
	elements.permission.classList.add("resolved");
	showToast(result.allowed ? "已允许本次访问" : "已拒绝访问，将调整方案");
});
events.addEventListener("aborted", () => setRunning(false));
events.addEventListener("gateway_error", ({ data }) => showToast(JSON.parse(data).message));

elements.composer.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (isRunning) return elements.stop.click();
	const message = elements.prompt.value.trim();
	if (!message) return elements.prompt.focus();
	streamedText = "";
	hasConversationTask = true;
	lastPrompt = message;
	appendMessage("user", message);
	appendMessage("assistant", "正在思考…");
	const title = message.slice(0, 22);
	document.querySelector(".conversation-header h1").textContent = title;
	document.querySelector("#runTitle").textContent = title;
	resetRunSteps();
	document.querySelector("#steps").hidden = false;
	addRunStep("submitted", "任务已提交", "设计请求已成功提交", "done");
	addRunStep("connection", "正在准备", "设计服务正在接收任务");
	if (!document.querySelector("#historyList .history-item.selected")) addHistoryItem(title);
	setRunning(true);
	try {
		const result = await post("/api/prompt", { message, thinking: document.querySelector("#thinkingToggle").checked, images: attachments });
		elements.prompt.value = "";
		resizePrompt();
		updateSendAvailability();
		attachments = [];
		elements.attachmentList.replaceChildren();
		if (wantsImage(message) && result.relayImageGeneration) void generateConversationImage(message);
		showToast(!result.imageGeneration && wantsImage(message) ? "设计任务已启动；当前暂不支持生成图片" : "设计任务已启动");
	} catch (error) {
		setRunning(false);
		showToast(error.message);
	}
});

elements.prompt.addEventListener("input", () => {
	resizePrompt();
	updateSendAvailability();
});
elements.prompt.addEventListener("keydown", (event) => {
	if (event.key === "Enter" && !event.shiftKey) {
		event.preventDefault();
		elements.composer.requestSubmit();
	}
});
elements.stop.addEventListener("click", async () => {
	await post("/api/abort");
	showToast("任务已停止");
});
elements.retry.addEventListener("click", () => {
	if (!lastPrompt) return;
	elements.prompt.value = lastPrompt;
	resizePrompt();
	updateSendAvailability();
	elements.composer.requestSubmit();
});
elements.permission.addEventListener("click", async (event) => {
	const button = event.target.closest("[data-permission]");
	if (!button) return;
	const allowed = button.dataset.permission === "true";
	let value;
	if (allowed && pendingPermission?.method === "select") value = window.prompt(pendingPermission.title, pendingPermission.options?.[0] || "");
	if (allowed && ["input", "editor"].includes(pendingPermission?.method)) value = window.prompt(pendingPermission.title, pendingPermission.prefill || "");
	await post("/api/permission", { id: pendingPermission?.id, method: pendingPermission?.method, allowed, value, cancelled: !allowed && pendingPermission?.method !== "confirm" });
	pendingPermission = null;
});
document.querySelector("#openRunPanel")?.addEventListener("click", () => elements.runPanel.classList.add("open"));
document.querySelector("#closePanel").addEventListener("click", () => elements.runPanel.classList.remove("open"));
document.querySelector("#mobileMenu").addEventListener("click", () => document.querySelector("#sidebar").classList.add("open"));
document.querySelector("#collapseButton").addEventListener("click", () => document.querySelector("#sidebar").classList.remove("open"));

document.querySelector("#shareButton").addEventListener("click", async () => {
	try {
		await navigator.clipboard.writeText(window.location.href);
		showToast("对话地址已复制");
	} catch {
		showToast("浏览器未允许复制，请从地址栏复制");
	}
});
document.querySelector("#zoomButton")?.addEventListener("click", () => document.querySelector("#imageDialog").showModal());
document.querySelector("#closeImage").addEventListener("click", () => document.querySelector("#imageDialog").close());
document.querySelectorAll(".suggestions button").forEach((button) => button.addEventListener("click", () => {
	elements.prompt.value = `${button.textContent}：请基于当前方案继续，并给出可执行的下一步。`;
	resizePrompt();
	updateSendAvailability();
	elements.prompt.focus();
}));
document.querySelectorAll(".nav-item[aria-disabled='true']").forEach((item) => item.addEventListener("click", (event) => {
	event.preventDefault();
	showToast("该模块在后续里程碑开放");
}));
document.querySelector("#attachButton").addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", async () => {
	const files = [...elements.fileInput.files].slice(0, 4);
	attachments = await Promise.all(files.map((file) => new Promise((resolve) => {
		const reader = new FileReader();
		reader.onload = () => resolve({ type: "image", data: String(reader.result).split(",")[1], mimeType: file.type });
		reader.readAsDataURL(file);
	})));
	elements.attachmentList.replaceChildren(...files.map((file) => Object.assign(document.createElement("span"), { textContent: file.name })));
	sessionResources.push(...files.map((file) => ({ type: "attachment", name: file.name })));
	updateTabCounts();
	showToast(`已添加 ${files.length} 张图片`);
});
document.querySelector("#modeButton").addEventListener("click", async () => {
	const health = await fetch("/api/health").then((response) => response.json());
	showToast(health.imageGeneration ? "设计模式：文字与图像均可生成" : "设计模式：当前支持文字方案");
});
document.querySelector("#modelButton").addEventListener("click", async () => {
	try {
		const state = await post("/api/model/cycle");
		document.querySelector("#modelLabel").textContent = state.model?.name || "默认模型";
		showToast(state.model?.name ? `已切换到：${state.model.name}` : "当前只有一个可用模型");
	} catch { showToast("暂时无法切换模型"); }
});
document.querySelector("#voiceButton").addEventListener("click", () => {
	const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!SpeechRecognition) return showToast("当前浏览器不支持语音输入");
	const recognition = new SpeechRecognition();
	recognition.lang = "zh-CN";
	recognition.onresult = (event) => {
		elements.prompt.value += event.results[0][0].transcript;
		resizePrompt();
		updateSendAvailability();
	};
	recognition.onerror = () => showToast("语音识别失败，请检查麦克风权限");
	recognition.start();
});

setInterval(() => {
	if (!isRunning) return;
	const seconds = Math.floor((Date.now() - runStartedAt) / 1000);
	document.querySelector("#elapsed").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}, 1000);

document.querySelectorAll(".run-tabs [role='tab']").forEach((tab) => tab.addEventListener("click", () => {
	document.querySelectorAll(".run-tabs [role='tab']").forEach((item) => {
		item.classList.toggle("active", item === tab);
		item.setAttribute("aria-selected", String(item === tab));
	});
	const process = tab.dataset.tab === "process";
	document.querySelector("#steps").hidden = !process;
	elements.permission.hidden = !process;
	const panel = document.querySelector("#tabPanel");
	panel.hidden = process;
	panel.replaceChildren();
	if (!process) {
		const title = document.createElement("strong");
		title.textContent = tab.dataset.tab === "results" ? "本次真实产出" : "本次真实资源";
		const list = document.createElement("ul");
		const values = tab.dataset.tab === "results" ? sessionResults : sessionResources.map((item) => item.name);
		if (values.length === 0) {
			const empty = document.createElement("li");
			empty.textContent = "当前会话暂无内容";
			list.append(empty);
		} else {
			for (const value of values) {
				const item = document.createElement("li");
				item.textContent = value.length > 120 ? `${value.slice(0, 120)}…` : value;
				list.append(item);
			}
		}
		panel.append(title, list);
	}
}));
document.querySelectorAll(".primary-nav .nav-item:not(.active), .sidebar-footer .nav-item").forEach((item) => item.addEventListener("click", (event) => {
	event.preventDefault();
	showToast("该模块不在当前对话工作台里程碑范围内");
}));
document.querySelectorAll(".primary-nav .nav-item:not(.active), .sidebar-footer .nav-item").forEach((item) => {
	item.classList.add("unavailable");
	item.setAttribute("aria-disabled", "true");
	if (!item.querySelector("small")) {
		const status = document.createElement("small");
		status.textContent = "规划中";
		item.append(status);
	}
});
document.querySelector("#newConversationButton").addEventListener("click", async () => {
	const button = document.querySelector("#newConversationButton");
	button.disabled = true;
	elements.prompt.disabled = true;
	try {
		await post("/api/session/new");
		resetConversation();
		addHistoryItem("新对话");
		elements.prompt.value = "";
		resizePrompt();
		updateSendAvailability();
		elements.prompt.focus();
		showToast("已创建新会话");
	} catch (error) {
		showToast(error.message);
	} finally {
		button.disabled = false;
		elements.prompt.disabled = false;
	}
});
document.querySelector("#historyList").addEventListener("click", (event) => {
	const item = event.target.closest(".history-item");
	if (!item) return;
	document.querySelectorAll(".history-item").forEach((entry) => entry.classList.toggle("selected", entry === item));
	document.querySelector(".conversation-header h1").textContent = item.querySelector("strong").textContent;
});

elements.messageScroll.addEventListener("click", (event) => {
	const download = event.target.closest(".download-generated");
	if (download) {
		const image = download.closest("figure").querySelector("img");
		const link = document.createElement("a");
		link.href = image.src;
		link.download = `jonwork-design-${Date.now()}.png`;
		link.click();
		return;
	}
	const button = event.target.closest(".zoom-generated");
	if (!button) return;
	const image = button.closest("figure").querySelector("img");
	document.querySelector("#dialogImage").src = image.src;
	document.querySelector("#imageDialog").showModal();
});

document.querySelector(".quick-nav").addEventListener("click", (event) => {
	const action = event.target.closest("[data-quick-action]")?.dataset.quickAction;
	if (!action) return;
	if (action === "new") document.querySelector("#newConversationButton").click();
	if (action === "attach") document.querySelector("#attachButton").click();
	if (action === "image") {
		elements.prompt.value = "基于当前会话生成一张专业的工业设计产品概念图，展示整体外观、关键模块和真实使用场景。";
		resizePrompt();
		updateSendAvailability();
		elements.prompt.focus();
	}
	if (action === "results") {
		document.querySelector('[data-tab="results"]').click();
		elements.runPanel.classList.add("open");
	}
	document.querySelector("#sidebar").classList.remove("open");
});

document.querySelector("#steps").hidden = true;
setRunning(false);
