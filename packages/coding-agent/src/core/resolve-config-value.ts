/**
 * Resolve configuration values that may be shell commands, environment variables, or literals.
 * Used by auth-storage.ts and model-registry.ts.
 */

import { spawnSync } from "child_process";
import { getShellConfig } from "../utils/shell.ts";

// Cache for shell command results (persists for process lifetime)
const commandResultCache = new Map<string, string | undefined>();
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

type TemplatePart = { type: "literal"; value: string } | { type: "env"; name: string };

type ConfigValueReference = { type: "command"; config: string } | { type: "template"; parts: TemplatePart[] };

const CREDENTIAL_HELPER_TIMEOUT_MS = 10_000;
const CREDENTIAL_HELPER_KILL_GRACE_MS = 250;
const CREDENTIAL_HELPER_OUTPUT_LIMIT = 64 * 1024;
const CREDENTIAL_HELPER_RUNNER = `
const { spawn } = require("node:child_process");
const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
let output = Buffer.alloc(0);
let outputExceeded = false;
let timedOut = false;
let settled = false;
let termTimer;
let hardTimer;
const child = spawn(input.shell, [...input.args, ...(input.commandFromStdin ? [] : [input.command])], {
  detached: process.platform !== "win32",
  stdio: [input.commandFromStdin ? "pipe" : "ignore", "pipe", "ignore"],
  windowsHide: true,
});
function signalTree(signal) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", ...(signal === "SIGKILL" ? ["/f"] : [])], { stdio: "ignore", windowsHide: true });
    killer.on("error", () => { try { child.kill(signal); } catch {} });
    return;
  }
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}
function terminate(reason) {
  if (settled) return;
  if (reason === "timeout") timedOut = true;
  if (reason === "output") outputExceeded = true;
  signalTree("SIGTERM");
  termTimer = setTimeout(() => signalTree("SIGKILL"), input.killGraceMs);
}
function finish(result) {
  if (settled) return;
  settled = true;
  clearTimeout(termTimer);
  clearTimeout(hardTimer);
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}
const timeout = setTimeout(() => terminate("timeout"), input.timeoutMs);
hardTimer = setTimeout(() => { signalTree("SIGKILL"); finish({ ok: false, timedOut: true }); }, input.timeoutMs + input.killGraceMs + 1000);
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { signalTree("SIGKILL"); process.exit(1); });
child.once("error", error => { clearTimeout(timeout); finish({ ok: false, spawnErrorCode: error.code }); });
child.stdout.on("data", chunk => {
  if (outputExceeded) return;
  if (output.length + chunk.length > input.outputLimit) { terminate("output"); return; }
  output = Buffer.concat([output, chunk]);
});
child.once("close", code => {
  clearTimeout(timeout);
  finish({ ok: !timedOut && !outputExceeded && code === 0, value: output.toString("utf8"), timedOut, outputExceeded, code });
});
if (input.commandFromStdin) child.stdin.end(input.command);
`;

type CredentialHelperResult = {
	ok: boolean;
	value?: string;
	spawnErrorCode?: string;
};

function runCredentialHelper(
	shell: string,
	args: string[],
	command: string,
	commandFromStdin: boolean,
): CredentialHelperResult {
	const input = Buffer.from(
		JSON.stringify({
			shell,
			args,
			command,
			commandFromStdin,
			timeoutMs: CREDENTIAL_HELPER_TIMEOUT_MS,
			killGraceMs: CREDENTIAL_HELPER_KILL_GRACE_MS,
			outputLimit: CREDENTIAL_HELPER_OUTPUT_LIMIT,
		}),
	).toString("base64");
	const result = spawnSync(process.execPath, ["-e", CREDENTIAL_HELPER_RUNNER, input], {
		encoding: "utf-8",
		timeout: CREDENTIAL_HELPER_TIMEOUT_MS + CREDENTIAL_HELPER_KILL_GRACE_MS + 2_000,
		maxBuffer: CREDENTIAL_HELPER_OUTPUT_LIMIT * 2,
		stdio: ["ignore", "pipe", "ignore"],
		windowsHide: true,
	});
	if (result.error || result.status !== 0 || !result.stdout) return { ok: false };
	try {
		return JSON.parse(result.stdout) as CredentialHelperResult;
	} catch {
		return { ok: false };
	}
}

function appendLiteral(parts: TemplatePart[], value: string): void {
	if (!value) return;
	const previousPart = parts[parts.length - 1];
	if (previousPart?.type === "literal") {
		previousPart.value += value;
		return;
	}
	parts.push({ type: "literal", value });
}

function parseConfigValueTemplate(config: string): TemplatePart[] {
	const parts: TemplatePart[] = [];
	let index = 0;

	while (index < config.length) {
		const dollarIndex = config.indexOf("$", index);
		if (dollarIndex < 0) {
			appendLiteral(parts, config.slice(index));
			break;
		}

		appendLiteral(parts, config.slice(index, dollarIndex));
		const nextChar = config[dollarIndex + 1];

		if (nextChar === "$" || nextChar === "!") {
			appendLiteral(parts, nextChar);
			index = dollarIndex + 2;
			continue;
		}

		if (nextChar === "{") {
			const endIndex = config.indexOf("}", dollarIndex + 2);
			if (endIndex < 0) {
				appendLiteral(parts, "$");
				index = dollarIndex + 1;
				continue;
			}

			const name = config.slice(dollarIndex + 2, endIndex);
			if (ENV_VAR_NAME_RE.test(name)) {
				parts.push({ type: "env", name });
			} else {
				appendLiteral(parts, config.slice(dollarIndex, endIndex + 1));
			}
			index = endIndex + 1;
			continue;
		}

		const match = config.slice(dollarIndex + 1).match(ENV_VAR_NAME_PREFIX_RE);
		if (match) {
			parts.push({ type: "env", name: match[0] });
			index = dollarIndex + 1 + match[0].length;
			continue;
		}

		appendLiteral(parts, "$");
		index = dollarIndex + 1;
	}

	return parts;
}

function parseConfigValueReference(config: string): ConfigValueReference {
	if (config.startsWith("!")) {
		return { type: "command", config };
	}

	return { type: "template", parts: parseConfigValueTemplate(config) };
}

function resolveEnvConfigValue(name: string, env?: Record<string, string>): string | undefined {
	return env?.[name] || process.env[name] || undefined;
}

function getTemplateEnvVarNames(parts: TemplatePart[]): string[] {
	const names: string[] = [];
	for (const part of parts) {
		if (part.type !== "env" || names.includes(part.name)) continue;
		names.push(part.name);
	}
	return names;
}

function resolveTemplate(parts: TemplatePart[], env?: Record<string, string>): string | undefined {
	let resolved = "";
	for (const part of parts) {
		if (part.type === "literal") {
			resolved += part.value;
			continue;
		}
		const envValue = resolveEnvConfigValue(part.name, env);
		if (envValue === undefined) return undefined;
		resolved += envValue;
	}
	return resolved;
}

export function getConfigValueEnvVarName(config: string): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type !== "template") return undefined;
	return reference.parts.length === 1 && reference.parts[0]?.type === "env" ? reference.parts[0].name : undefined;
}

export function getConfigValueEnvVarNames(config: string): string[] {
	const reference = parseConfigValueReference(config);
	return reference.type === "template" ? getTemplateEnvVarNames(reference.parts) : [];
}

export function getMissingConfigValueEnvVarNames(config: string, env?: Record<string, string>): string[] {
	return getConfigValueEnvVarNames(config).filter((name) => resolveEnvConfigValue(name, env) === undefined);
}

export function isCommandConfigValue(config: string): boolean {
	return parseConfigValueReference(config).type === "command";
}

export function isConfigValueConfigured(config: string, env?: Record<string, string>): boolean {
	return getMissingConfigValueEnvVarNames(config, env).length === 0;
}

/**
 * Resolve a config value (API key, header value, etc.) to an actual value.
 * - If starts with "!", executes the rest as a shell command and uses stdout (cached)
 * - Interpolates "$ENV_VAR" or "${ENV_VAR}" references with the named environment variable
 * - In non-command values, "$$" escapes a literal "$" and "$!" escapes a literal "!"
 * - Otherwise treats the value as a literal
 */
export function resolveConfigValue(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommand(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

function executeWithConfiguredShell(command: string): { executed: boolean; value: string | undefined } {
	try {
		const { shell, args, commandTransport } = getShellConfig();
		const commandFromStdin = commandTransport === "stdin";
		const result = runCredentialHelper(shell, args, command, commandFromStdin);
		if (result.spawnErrorCode === "ENOENT") return { executed: false, value: undefined };
		const value = result.ok ? result.value?.trim() : undefined;
		return { executed: true, value: value || undefined };
	} catch {
		return { executed: false, value: undefined };
	}
}

function executeWithDefaultShell(command: string): string | undefined {
	const result = runCredentialHelper(
		process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "/bin/sh",
		process.platform === "win32" ? ["/d", "/s", "/c"] : ["-c"],
		command,
		false,
	);
	return result.ok ? result.value?.trim() || undefined : undefined;
}

function executeCommandUncached(commandConfig: string): string | undefined {
	const command = commandConfig.slice(1);
	return process.platform === "win32"
		? (() => {
				const configuredResult = executeWithConfiguredShell(command);
				return configuredResult.executed ? configuredResult.value : executeWithDefaultShell(command);
			})()
		: executeWithDefaultShell(command);
}

function executeCommand(commandConfig: string): string | undefined {
	if (commandResultCache.has(commandConfig)) {
		return commandResultCache.get(commandConfig);
	}

	const result = executeCommandUncached(commandConfig);
	commandResultCache.set(commandConfig, result);
	return result;
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveConfigValueUncached(config: string, env?: Record<string, string>): string | undefined {
	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		return executeCommandUncached(reference.config);
	}
	return resolveTemplate(reference.parts, env);
}

export function resolveConfigValueOrThrow(config: string, description: string, env?: Record<string, string>): string {
	const resolvedValue = resolveConfigValueUncached(config, env);
	if (resolvedValue !== undefined) {
		return resolvedValue;
	}

	const reference = parseConfigValueReference(config);
	if (reference.type === "command") {
		throw new Error(`Failed to resolve ${description} from shell command: ${reference.config.slice(1)}`);
	}

	if (reference.type === "template") {
		const missingEnvVars = getMissingConfigValueEnvVarNames(config, env);
		if (missingEnvVars.length === 1) {
			throw new Error(`Failed to resolve ${description} from environment variable: ${missingEnvVars[0]}`);
		}
		if (missingEnvVars.length > 1) {
			throw new Error(`Failed to resolve ${description} from environment variables: ${missingEnvVars.join(", ")}`);
		}
	}

	throw new Error(`Failed to resolve ${description}`);
}

/**
 * Resolve all header values using the same resolution logic as API keys.
 */
export function resolveHeaders(
	headers: Record<string, string> | undefined,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		const resolvedValue = resolveConfigValue(value, env);
		if (resolvedValue) {
			resolved[key] = resolvedValue;
		}
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export function resolveHeadersOrThrow(
	headers: Record<string, string> | undefined,
	description: string,
	env?: Record<string, string>,
): Record<string, string> | undefined {
	if (!headers) return undefined;
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		resolved[key] = resolveConfigValueOrThrow(value, `${description} header "${key}"`, env);
	}
	return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/** Clear the config value command cache. Exported for testing. */
export function clearConfigValueCache(): void {
	commandResultCache.clear();
}
