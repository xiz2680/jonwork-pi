const elements = {
	composer: document.querySelector("#composer"),
	prompt: document.querySelector("#promptInput"),
	send: document.querySelector("#sendButton"),
	stop: document.querySelector("#stopButton"),
	retry: document.querySelector("#retryButton"),
	runPanel: document.querySelector("#runPanel"),
	progress: document.querySelector("#progressBar"),
	inlineProgress: document.querySelector("#inlineProgress"),
	progressCount: document.querySelector("#progressCount"),
	activeStepDetail: document.querySelector("#activeStepDetail"),
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

function showToast(message) {
	elements.toast.textContent = message;
	elements.toast.classList.add("show");
	setTimeout(() => elements.toast.classList.remove("show"), 2200);
}

function setRunning(running) {
	isRunning = running;
	elements.send.classList.toggle("running", running);
	elements.send.innerHTML = `<iconify-icon icon="${running ? "solar:stop-bold" : "solar:arrow-up-linear"}"></iconify-icon>`;
	elements.runStatus.textContent = running ? "运行中" : "空闲";
	elements.stop.disabled = !running;
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

function resetRunSteps() {
	document.querySelector("#steps").replaceChildren();
	stepSequence = 0;
	updateRunProgress();
}

function currentTime() {
	return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
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
	const content = document.createElement(role === "user" ? "div" : "p");
	content.className = role === "user" ? "user-bubble" : "assistant-text";
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
	empty.innerHTML = '<span class="ai-avatar avatar">J</span><h2>今天想设计什么？</h2><p>输入任务后，Jonwork 会通过 Pi 完成分析、工具调用和方案输出。</p>';
	elements.messageScroll.append(empty);
	document.querySelector(".conversation-header h1").textContent = "新对话";
	document.querySelector("#runTitle").textContent = "等待任务";
	document.querySelector("#elapsed").textContent = "00:00";
	elements.progress.style.width = "0";
	elements.progressCount.textContent = "0 / 6";
	elements.permission.classList.add("resolved");
	resetRunSteps();
	document.querySelector("#steps").hidden = true;
	setRunning(false);
}

function addHistoryItem(title) {
	const list = document.querySelector("#historyList");
	list.querySelector(".history-empty")?.remove();
	list.querySelectorAll(".history-item").forEach((item) => item.classList.remove("selected"));
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

function updateStep({ index, status, detail, progress }) {
	const item = document.querySelectorAll("#steps > li")[index];
	if (!item) return;
	item.className = status;
	const state = item.querySelector(".step-state");
	if (status === "done") state.innerHTML = '<iconify-icon icon="solar:check-circle-bold"></iconify-icon>';
	const small = item.querySelector("small");
	if (small && detail) small.textContent = detail;
	if (typeof progress === "number") {
		elements.progress.style.width = `${progress}%`;
		elements.inlineProgress.style.width = `${progress}%`;
		const time = item.querySelector(":scope > time");
		if (time) time.textContent = `${progress}%`;
	}
	const completed = document.querySelectorAll("#steps > li.done").length;
	elements.progressCount.textContent = `${Math.max(completed, index + (status === "running" ? 1 : 0))} / 6`;
}

function handlePiEvent(record) {
	if (record.type === "agent_start") {
		setRunning(true);
		completeRunStep("connection", "Pi 已开始处理");
		addRunStep("analysis", "Pi 分析任务", "正在理解上下文并规划响应");
	}
	if (record.type === "agent_settled" || record.type === "agent_end") {
		if (!document.querySelector('#steps [data-step-key="response"]')) addRunStep("response", "生成回复", "Pi 已结束本轮处理", "done");
		completeRunStep("response", "回复已生成");
		document.querySelectorAll("#steps > li.running").forEach((item) => completeRunStep(item.dataset.stepKey, "已完成"));
		setRunning(false);
		elements.runStatus.textContent = "已完成";
	}
	if (record.type === "tool_execution_start") {
		completeRunStep("analysis", "分析完成");
		const key = `tool-${++stepSequence}`;
		addRunStep(key, record.toolName || "Pi 工具调用", "正在执行工具");
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
		target.textContent = streamedText;
	}
	if (record.type === "message_end") {
		const finalText = messageText(record.message);
		if (finalText) {
			streamedText = finalText;
			const target = [...document.querySelectorAll(".assistant-text")].at(-1) || appendMessage("assistant");
			target.textContent = finalText;
		}
	}
	if (record.type === "agent_end" && Array.isArray(record.messages)) {
		const finalText = messageText([...record.messages].reverse().find((message) => message?.role === "assistant"));
		if (finalText) {
			streamedText = finalText;
			const target = [...document.querySelectorAll(".assistant-text")].at(-1) || appendMessage("assistant");
			target.textContent = finalText;
		}
	}
	if (record.type === "extension_ui_request") {
		if (record.method === "notify") return showToast(record.message);
		if (record.method === "setTitle") document.querySelector(".conversation-header h1").textContent = record.title;
		if (record.method === "set_editor_text") elements.prompt.value = record.text;
		if (["confirm", "select", "input", "editor"].includes(record.method)) {
			pendingPermission = record;
			elements.permission.querySelector("strong").textContent = record.title || "Pi 需要你的确认";
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
	elements.connectionLabel.textContent = state.mode === "demo" ? "演示模式" : state.connected ? "Pi 已连接" : "Pi 可连接";
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
events.addEventListener("step", ({ data }) => updateStep(JSON.parse(data)));
events.addEventListener("tool", ({ data }) => {
	const tool = JSON.parse(data);
	document.querySelector("#toolCall strong").textContent = tool.name;
	document.querySelector("#toolCall time").textContent = tool.elapsed;
	document.querySelector("#toolCall p").textContent = tool.prompt;
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
	showToast(result.allowed ? "已允许本次访问" : "已拒绝访问，Pi 将调整方案");
});
events.addEventListener("aborted", () => setRunning(false));
events.addEventListener("gateway_error", ({ data }) => showToast(JSON.parse(data).message));

elements.composer.addEventListener("submit", async (event) => {
	event.preventDefault();
	if (isRunning) return elements.stop.click();
	const message = elements.prompt.value.trim();
	if (!message) return elements.prompt.focus();
	streamedText = "";
	appendMessage("user", message);
	appendMessage("assistant", "正在思考…");
	const title = message.slice(0, 22);
	document.querySelector(".conversation-header h1").textContent = title;
	document.querySelector("#runTitle").textContent = title;
	resetRunSteps();
	document.querySelector("#steps").hidden = false;
	addRunStep("submitted", "任务已提交", "请求已发送到 Pi", "done");
	addRunStep("connection", "等待 Pi 响应", "已连接真实 Pi RPC");
	if (!document.querySelector("#historyList .history-item.selected")) addHistoryItem(title);
	setRunning(true);
	try {
		const result = await post("/api/prompt", { message, thinking: document.querySelector("#thinkingToggle").checked, images: attachments });
		elements.prompt.value = "";
		attachments = [];
		elements.attachmentList.replaceChildren();
		showToast(result.mode === "rpc" ? "任务已发送给 Pi" : "已启动交互演示；连接 Pi 后将使用真实事件");
	} catch (error) {
		setRunning(false);
		showToast(error.message);
	}
});

elements.prompt.addEventListener("input", () => {
	elements.prompt.style.height = "auto";
	elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 140)}px`;
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
	elements.prompt.value = "重试当前步骤，并保留已完成的调研结果";
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
	showToast(`已添加 ${files.length} 张图片`);
});
document.querySelector("#modeButton").addEventListener("click", () => showToast("当前使用设计协作模式"));
document.querySelector("#modelButton").addEventListener("click", async () => {
	try {
		const state = await fetch("/api/state").then((response) => response.json());
		document.querySelector("#modelLabel").textContent = state.model?.name || "Pi 默认模型";
		showToast(`当前模型：${state.model?.name || "Pi 默认模型"}`);
	} catch { showToast("暂时无法读取模型状态"); }
});
document.querySelector("#voiceButton").addEventListener("click", () => {
	const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
	if (!SpeechRecognition) return showToast("当前浏览器不支持语音输入");
	const recognition = new SpeechRecognition();
	recognition.lang = "zh-CN";
	recognition.onresult = (event) => { elements.prompt.value += event.results[0][0].transcript; };
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
	if (tab.dataset.tab === "results") panel.innerHTML = '<strong>本次产出</strong><ul><li>概念方案 A</li><li>模块拆解说明</li><li>关键体验建议</li></ul>';
	if (tab.dataset.tab === "resources") panel.innerHTML = '<strong>相关资源</strong><ul><li>产品概念图</li><li>设计任务上下文</li><li>Pi 工具调用记录</li></ul>';
}));
document.querySelector("#toolCall button").addEventListener("click", (event) => {
	const prompt = document.querySelector("#toolCall p");
	const expanded = prompt.classList.toggle("expanded");
	event.currentTarget.textContent = expanded ? "收起完整参数" : "查看完整参数";
});
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
		elements.prompt.focus();
		showToast("已创建新的 Pi 会话");
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

document.querySelector("#steps").hidden = true;
setRunning(false);
