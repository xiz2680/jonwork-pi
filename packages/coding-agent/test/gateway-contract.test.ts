import { readFile } from "node:fs/promises";
import { describe, expect, test, vi } from "vitest";
import { parse } from "yaml";
import {
	GatewayContractError,
	type GatewayEvent,
	GatewayEventJournal,
	GatewayEventSequenceValidator,
	GatewayMutationCoordinator,
	PI_GATEWAY_CONTRACT_ID,
	PI_GATEWAY_ERROR_CODES,
} from "../src/experimental/gateway-contract.ts";

const fixtures = new URL("./fixtures/gateway-v1/", import.meta.url);
const openApi = new URL("../docs/pi-gateway-v1.openapi.yaml", import.meta.url);

async function jsonFixture(name: string): Promise<unknown> {
	return JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
}

async function eventFixture(name: string): Promise<GatewayEvent[]> {
	return (await jsonFixture(name)) as GatewayEvent[];
}

function object(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Expected object");
	return value as Record<string, unknown>;
}

describe("Pi Gateway v1 OpenAPI contract", () => {
	test("declares every stateful route and forbids a stateless chat fallback", async () => {
		const document = object(parse(await readFile(openApi, "utf8")));
		const paths = object(document.paths);
		expect(Object.keys(paths).sort()).toEqual(
			[
				"/.well-known/pi-gateway",
				"/v1/attachments",
				"/v1/models",
				"/v1/repositories",
				"/v1/sessions",
				"/v1/sessions/{sessionId}",
				"/v1/sessions/{sessionId}/commands",
				"/v1/sessions/{sessionId}/events",
				"/v1/sessions/{sessionId}/release",
				"/v1/sessions/{sessionId}/restore",
				"/v1/sessions/{sessionId}/takeover",
			].sort(),
		);
		expect(paths["/v1/chat/completions"]).toBeUndefined();

		for (const path of [
			"/v1/sessions/{sessionId}/commands",
			"/v1/sessions/{sessionId}/release",
			"/v1/sessions/{sessionId}/restore",
			"/v1/sessions/{sessionId}/takeover",
		]) {
			const post = object(object(paths[path]).post);
			const parameters = post.parameters as Array<Record<string, string>>;
			expect(parameters.map((parameter) => parameter.$ref)).toContain("#/components/parameters/IdempotencyKey");
			expect(parameters.map((parameter) => parameter.$ref)).toContain("#/components/parameters/IfMatch");
		}
	});

	test("keeps documented errors synchronized with the implementation", async () => {
		const document = object(parse(await readFile(openApi, "utf8")));
		const components = object(document.components);
		const schemas = object(components.schemas);
		const errorResponse = object(schemas.ErrorResponse);
		const error = object(object(object(errorResponse.properties).error).properties);
		expect(object(error.code).enum).toEqual(PI_GATEWAY_ERROR_CODES);
	});

	test("publishes every versioned event data variant through the SSE schema", async () => {
		const document = object(parse(await readFile(openApi, "utf8")));
		const schemas = object(object(document.components).schemas);
		const gatewayEvent = object(schemas.GatewayEvent);
		const mappings = object(object(gatewayEvent.discriminator).mapping);
		expect(Object.keys(mappings).sort()).toEqual(
			[
				"abort.requested",
				"assistant.message.completed",
				"assistant.message.started",
				"assistant.reasoning.delta",
				"assistant.text.delta",
				"controller.changed",
				"gateway.error",
				"operation.accepted",
				"operation.settled",
				"session.released",
				"tool.completed",
				"tool.started",
				"tool.updated",
				"turn.completed",
				"turn.started",
				"user.message",
			].sort(),
		);
		const eventResponse = object(
			object(object(object(object(document.paths)["/v1/sessions/{sessionId}/events"]).get).responses)["200"],
		);
		expect(object(eventResponse["x-event-schema"]).$ref).toBe("#/components/schemas/GatewayEvent");
	});
});

describe("Pi Gateway v1 fixtures", () => {
	test("advertises the fail-closed capability and PKCE boundary", async () => {
		const discovery = object(await jsonFixture("discovery.json"));
		expect(discovery.contract).toBe(PI_GATEWAY_CONTRACT_ID);
		expect(object(discovery.authentication).pkceMethods).toEqual(["S256"]);
		const capabilities = object(discovery.capabilities);
		for (const required of [
			"repositories",
			"models",
			"thinking",
			"sessions",
			"commands",
			"sse",
			"authoritativeSnapshot",
			"eventIds",
			"replay",
			"idempotency",
			"singleWriter",
			"takeover",
			"release",
			"abort",
			"retry",
		]) {
			expect(capabilities[required], required).toBe(true);
		}
		expect(object(capabilities.attachments)).toEqual({ images: true, files: false });
	});

	test("contains reasoning and a successful tool lifecycle after an authoritative cursor", async () => {
		const snapshot = object(await jsonFixture("snapshot.json"));
		const events = await eventFixture("events.json");
		expect(snapshot.lastEventId).toBe("12");
		expect(events.map((event) => Number(event.id))).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
		expect(events.map((event) => event.type)).toContain("assistant.reasoning.delta");
		expect(events.map((event) => event.type)).toContain("assistant.text.delta");
		expect(events.map((event) => event.type)).toContain("tool.updated");
		expect(events.find((event) => event.type === "tool.completed")?.data).toMatchObject({
			toolCallId: "tool-01",
			parentCallId: null,
			status: "success",
		});
		expect(events.every((event) => event.sessionId === snapshot.sessionId)).toBe(true);
		const validator = new GatewayEventSequenceValidator(String(snapshot.sessionId), String(snapshot.lastEventId));
		for (const event of events) validator.accept(event);
		expect(validator.lastEventId).toBe("24");
	});

	test("validates tool failure and structured error termination", async () => {
		const events = await eventFixture("tool-failure.json");
		const validator = new GatewayEventSequenceValidator("session-tool-failure");
		for (const event of events) validator.accept(event);
		expect(events.find((event) => event.type === "tool.completed")?.data).toMatchObject({
			status: "failure",
			error: { code: "tool_execution_failed" },
		});
		expect(events.filter((event) => event.type === "operation.settled")).toHaveLength(1);
	});

	test("preserves nested tool identity and requires the child to terminate first", async () => {
		const events = await eventFixture("nested-tool.json");
		const validator = new GatewayEventSequenceValidator("session-nested");
		for (const event of events) validator.accept(event);
		const childEvents = events.flatMap((event) => {
			if (event.type !== "tool.started" && event.type !== "tool.updated" && event.type !== "tool.completed")
				return [];
			return event.data.toolCallId === "tool-child" ? [event.data] : [];
		});
		expect(childEvents).toHaveLength(3);
		expect(childEvents.every((data) => data.parentCallId === "tool-parent")).toBe(true);
		const childTerminal = events.findIndex(
			(event) => event.type === "tool.completed" && event.data.toolCallId === "tool-child",
		);
		const parentTerminal = events.findIndex(
			(event) => event.type === "tool.completed" && event.data.toolCallId === "tool-parent",
		);
		expect(childTerminal).toBeLessThan(parentTerminal);
	});

	test("settles abort exactly once after abort.requested", async () => {
		const events = await eventFixture("abort.json");
		const validator = new GatewayEventSequenceValidator("session-abort");
		for (const event of events) validator.accept(event);
		expect(events.filter((event) => event.type === "abort.requested")).toHaveLength(1);
		expect(events.filter((event) => event.type === "operation.settled")).toEqual([
			expect.objectContaining({ data: expect.objectContaining({ status: "aborted" }) }),
		]);
	});

	test("links retry admission and settlement to one settled operation", async () => {
		const events = await eventFixture("retry.json");
		const validator = new GatewayEventSequenceValidator("session-retry");
		for (const event of events) validator.accept(event);
		const retryAcceptedLinks = events.flatMap((event) =>
			event.type === "operation.accepted" && event.data.operationId === "operation-retry"
				? [event.data.retryOfOperationId]
				: [],
		);
		const retrySettledLinks = events.flatMap((event) =>
			event.type === "operation.settled" && event.data.operationId === "operation-retry"
				? [event.data.retryOfOperationId]
				: [],
		);
		expect(retryAcceptedLinks).toEqual(["operation-original"]);
		expect(retrySettledLinks).toEqual(["operation-original"]);
	});

	test("orders controller release before session.released", async () => {
		const events = await eventFixture("control.json");
		const validator = new GatewayEventSequenceValidator("session-control");
		for (const event of events) validator.accept(event);
		expect(events.map((event) => event.type)).toEqual([
			"controller.changed",
			"controller.changed",
			"session.released",
		]);
	});

	test("rejects duplicate, out-of-order, gap, repeated terminal, and missing-parent fixtures", async () => {
		const fixtures = object(await jsonFixture("invalid-sequences.json"));
		for (const value of Object.values(fixtures)) {
			const fixture = object(value);
			const validator = new GatewayEventSequenceValidator(String(fixture.sessionId), String(fixture.afterEventId));
			let failure: unknown;
			for (const event of fixture.events as GatewayEvent[]) {
				try {
					validator.accept(event);
				} catch (error) {
					failure = error;
					break;
				}
			}
			expect(failure).toMatchObject({ code: fixture.expectedCode });
		}
	});

	test("keeps attachment and structured error examples bounded", async () => {
		const attachment = object(await jsonFixture("attachment.json"));
		const errors = (await jsonFixture("errors.json")) as Array<Record<string, unknown>>;
		expect(attachment.byteLength).toBeLessThanOrEqual(10 * 1024 * 1024);
		expect(attachment.sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(errors.map((entry) => object(entry.error).code)).toEqual([
			"not_controller",
			"revision_conflict",
			"replay_cursor_expired",
		]);
	});
});

describe("GatewayEventJournal", () => {
	test("assigns monotonic IDs and replays strictly after a cursor", () => {
		const journal = new GatewayEventJournal("session-01", 3);
		journal.append(
			"controller.changed",
			1,
			{ previousControllerClientId: null, controllerClientId: "one", reason: "takeover" },
			"2026-10-13T08:00:00.000Z",
		);
		journal.append(
			"controller.changed",
			2,
			{ previousControllerClientId: "one", controllerClientId: null, reason: "release" },
			"2026-10-13T08:00:01.000Z",
		);
		expect(journal.replay("1").events.map((event) => event.id)).toEqual(["2"]);
		expect(journal.replay().events).toEqual([]);
		expect(journal.lastEventId).toBe("2");
	});

	test("rejects expired, malformed, and future cursors", () => {
		const journal = new GatewayEventJournal("session-01", 2);
		journal.append("controller.changed", 1, {
			previousControllerClientId: null,
			controllerClientId: "one",
			reason: "takeover",
		});
		journal.append("controller.changed", 2, {
			previousControllerClientId: "one",
			controllerClientId: "two",
			reason: "takeover",
		});
		journal.append("controller.changed", 3, {
			previousControllerClientId: "two",
			controllerClientId: "three",
			reason: "takeover",
		});
		expect(() => journal.replay("0")).toThrowError(expect.objectContaining({ code: "replay_cursor_expired" }));
		expect(() => journal.replay("invalid")).toThrowError(expect.objectContaining({ code: "invalid_replay_cursor" }));
		expect(() => journal.replay("4")).toThrowError(expect.objectContaining({ code: "invalid_replay_cursor" }));
		expect(journal.replay("1").events.map((event) => event.id)).toEqual(["2", "3"]);
	});
});

describe("GatewayMutationCoordinator", () => {
	test("replays identical successful commands and rejects key reuse", async () => {
		const coordinator = new GatewayMutationCoordinator<string>({ controllerClientId: "controller", revision: 4 });
		const operation = vi.fn(async () => "accepted");
		const request = {
			clientId: "controller",
			idempotencyKey: "command-0001",
			fingerprint: "prompt:hello",
			expectedRevision: 4,
		};
		expect(await coordinator.execute(request, operation)).toEqual({
			value: "accepted",
			revision: 5,
			replayed: false,
		});
		expect(await coordinator.execute(request, operation)).toEqual({ value: "accepted", revision: 5, replayed: true });
		expect(operation).toHaveBeenCalledTimes(1);
		await expect(
			coordinator.execute({ ...request, fingerprint: "prompt:different" }, operation),
		).rejects.toMatchObject({ code: "idempotency_conflict", status: 409 });
	});

	test("rejects viewers before invoking a mutation", async () => {
		const coordinator = new GatewayMutationCoordinator<void>({ controllerClientId: "controller" });
		const operation = vi.fn(async () => undefined);
		await expect(
			coordinator.execute(
				{ clientId: "viewer", idempotencyKey: "abort-0001", fingerprint: "abort", expectedRevision: 0 },
				operation,
			),
		).rejects.toMatchObject({ code: "not_controller", status: 403 });
		expect(operation).not.toHaveBeenCalled();
	});

	test("serializes concurrent writers so only one stale revision wins", async () => {
		const coordinator = new GatewayMutationCoordinator<string>({ controllerClientId: "controller", revision: 9 });
		const results = await Promise.allSettled([
			coordinator.execute(
				{ clientId: "controller", idempotencyKey: "writer-0001", fingerprint: "first", expectedRevision: 9 },
				async () => "first",
			),
			coordinator.execute(
				{ clientId: "controller", idempotencyKey: "writer-0002", fingerprint: "second", expectedRevision: 9 },
				async () => "second",
			),
		]);
		expect(results[0]).toMatchObject({ status: "fulfilled", value: { value: "first", revision: 10 } });
		expect(results[1]).toMatchObject({
			status: "rejected",
			reason: expect.objectContaining({ code: "revision_conflict", status: 409 }),
		});
	});

	test("controller changes fence old writers with a new revision", async () => {
		const coordinator = new GatewayMutationCoordinator<void>({ controllerClientId: "old", revision: 2 });
		expect(await coordinator.setController("new", 2)).toBe(3);
		await expect(
			coordinator.execute(
				{ clientId: "old", idempotencyKey: "writer-0003", fingerprint: "abort", expectedRevision: 2 },
				async () => undefined,
			),
		).rejects.toBeInstanceOf(GatewayContractError);
	});

	test("serializes controller changes behind admitted mutations", async () => {
		const coordinator = new GatewayMutationCoordinator<void>({ controllerClientId: "old", revision: 0 });
		let finishOperation: (() => void) | undefined;
		const operation = coordinator.execute(
			{ clientId: "old", idempotencyKey: "writer-0004", fingerprint: "prompt", expectedRevision: 0 },
			() =>
				new Promise<void>((resolve) => {
					finishOperation = resolve;
				}),
		);
		await vi.waitFor(() => expect(finishOperation).toBeTypeOf("function"));
		const controllerChange = coordinator.setController("new", 1);
		expect(coordinator.controllerClientId).toBe("old");
		finishOperation?.();
		await operation;
		expect(await controllerChange).toBe(2);
		expect(coordinator.controllerClientId).toBe("new");
	});
});
