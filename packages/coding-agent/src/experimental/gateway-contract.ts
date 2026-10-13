import type { JsonValue } from "@earendil-works/chord";

export const PI_GATEWAY_API_VERSION = "1.0" as const;
export const PI_GATEWAY_CONTRACT_ID = "pi-gateway/1.0" as const;

export const PI_GATEWAY_ERROR_CODES = [
	"invalid_request",
	"unauthenticated",
	"forbidden",
	"capability_unavailable",
	"version_incompatible",
	"session_not_found",
	"session_not_running",
	"restore_in_progress",
	"session_deleting",
	"not_controller",
	"session_busy",
	"revision_conflict",
	"idempotency_conflict",
	"mutation_not_found",
	"invalid_replay_cursor",
	"replay_cursor_expired",
	"duplicate_event",
	"out_of_order_event",
	"event_gap",
	"invalid_event_lifecycle",
	"attachment_not_found",
	"attachment_too_large",
	"attachment_type_unsupported",
	"attachment_limit_exceeded",
	"attachment_model_incompatible",
	"thinking_not_supported",
	"timeout",
	"rate_limited",
	"internal_error",
] as const;
export type GatewayErrorCode = (typeof PI_GATEWAY_ERROR_CODES)[number];

export class GatewayContractError extends Error {
	readonly code: GatewayErrorCode;
	readonly status: number;

	constructor(code: GatewayErrorCode, message: string, status: number) {
		super(message);
		this.name = "GatewayContractError";
		this.code = code;
		this.status = status;
	}
}

export type GatewayOperationCommand =
	| "prompt"
	| "steer"
	| "follow_up"
	| "abort"
	| "retry"
	| "compact"
	| "set_model"
	| "set_thinking_level";

export interface GatewayEventError {
	readonly code: string;
	readonly message: string;
	readonly retryable: boolean;
}

export interface GatewayEventDataByType {
	readonly "operation.accepted": {
		readonly operationId: string;
		readonly command: GatewayOperationCommand;
		readonly retryOfOperationId: string | null;
	};
	readonly "user.message": {
		readonly operationId: string;
		readonly messageId: string;
		readonly text: string;
		readonly attachmentIds: readonly string[];
	};
	readonly "turn.started": {
		readonly operationId: string;
		readonly turnId: string;
	};
	readonly "assistant.message.started": {
		readonly operationId: string;
		readonly turnId: string;
		readonly messageId: string;
	};
	readonly "assistant.text.delta": {
		readonly operationId: string;
		readonly turnId: string;
		readonly messageId: string;
		readonly delta: string;
	};
	readonly "assistant.reasoning.delta": {
		readonly operationId: string;
		readonly turnId: string;
		readonly messageId: string;
		readonly delta: string;
	};
	readonly "tool.started": {
		readonly operationId: string;
		readonly turnId: string;
		readonly messageId: string;
		readonly toolCallId: string;
		readonly parentCallId: string | null;
		readonly toolName: string;
		readonly arguments: JsonValue;
	};
	readonly "tool.updated": {
		readonly operationId: string;
		readonly turnId: string;
		readonly messageId: string;
		readonly toolCallId: string;
		readonly parentCallId: string | null;
		readonly updateSequence: number;
		readonly partialResult: JsonValue;
	};
	readonly "tool.completed": {
		readonly operationId: string;
		readonly turnId: string;
		readonly messageId: string;
		readonly toolCallId: string;
		readonly parentCallId: string | null;
		readonly status: "success" | "failure";
		readonly result: JsonValue | null;
		readonly error: GatewayEventError | null;
	};
	readonly "assistant.message.completed": {
		readonly operationId: string;
		readonly turnId: string;
		readonly messageId: string;
		readonly status: "completed" | "aborted" | "error";
		readonly error: GatewayEventError | null;
	};
	readonly "turn.completed": {
		readonly operationId: string;
		readonly turnId: string;
		readonly status: "completed" | "aborted" | "failed";
	};
	readonly "abort.requested": {
		readonly operationId: string;
		readonly requestedByClientId: string;
	};
	readonly "operation.settled": {
		readonly operationId: string;
		readonly status: "completed" | "aborted" | "failed";
		readonly retryOfOperationId: string | null;
		readonly error: GatewayEventError | null;
	};
	readonly "gateway.error": {
		readonly operationId: string | null;
		readonly error: GatewayEventError;
	};
	readonly "controller.changed": {
		readonly previousControllerClientId: string | null;
		readonly controllerClientId: string | null;
		readonly reason: "takeover" | "release" | "disconnect" | "expired";
	};
	readonly "session.released": {
		readonly byClientId: string;
	};
}

export type GatewayEventType = keyof GatewayEventDataByType;

export interface GatewayEventEnvelope<T extends GatewayEventType = GatewayEventType> {
	readonly contract: typeof PI_GATEWAY_CONTRACT_ID;
	readonly id: string;
	readonly sessionId: string;
	readonly sessionRevision: number;
	readonly occurredAt: string;
	readonly type: T;
	readonly data: GatewayEventDataByType[T];
}

export type GatewayEvent = {
	readonly [T in GatewayEventType]: GatewayEventEnvelope<T>;
}[GatewayEventType];

export interface GatewayReplay {
	readonly events: readonly GatewayEvent[];
	readonly lastEventId: string;
}

/**
 * Bounded, session-local event journal for an SSE adapter. IDs are monotonically
 * increasing decimal integers. Durable gateways must persist equivalent state;
 * this in-memory implementation is a reusable reference primitive, not storage.
 */
export class GatewayEventJournal {
	readonly #sessionId: string;
	readonly #capacity: number;
	readonly #events: GatewayEvent[] = [];
	#lastSequence = 0;
	#discardedThrough = 0;

	constructor(sessionId: string, capacity = 2048) {
		if (sessionId.length === 0) throw new TypeError("Gateway event journal requires a session ID");
		if (!Number.isSafeInteger(capacity) || capacity < 1) {
			throw new TypeError("Gateway event journal capacity must be a positive safe integer");
		}
		this.#sessionId = sessionId;
		this.#capacity = capacity;
	}

	get lastEventId(): string {
		return String(this.#lastSequence);
	}

	append<T extends GatewayEventType>(
		type: T,
		sessionRevision: number,
		data: GatewayEventDataByType[T],
		occurredAt = new Date().toISOString(),
	): GatewayEvent {
		if (type.length === 0) throw new TypeError("Gateway event type must not be empty");
		if (!Number.isSafeInteger(sessionRevision) || sessionRevision < 0) {
			throw new TypeError("Gateway session revision must be a non-negative safe integer");
		}
		this.#lastSequence += 1;
		const event = Object.freeze({
			contract: PI_GATEWAY_CONTRACT_ID,
			id: String(this.#lastSequence),
			sessionId: this.#sessionId,
			sessionRevision,
			occurredAt,
			type,
			data,
		}) as GatewayEvent;
		this.#events.push(event);
		if (this.#events.length > this.#capacity) {
			const discarded = this.#events.shift();
			if (discarded) this.#discardedThrough = Number(discarded.id);
		}
		return event;
	}

	replay(afterEventId?: string): GatewayReplay {
		const after = afterEventId === undefined ? this.#lastSequence : parseEventId(afterEventId);
		if (after > this.#lastSequence) {
			throw new GatewayContractError("invalid_replay_cursor", "Replay cursor is ahead of the event journal", 400);
		}
		if (after < this.#discardedThrough) {
			throw new GatewayContractError(
				"replay_cursor_expired",
				"Replay cursor is older than the retained event journal; fetch an authoritative snapshot",
				409,
			);
		}
		return {
			events: this.#events.filter((event) => Number(event.id) > after),
			lastEventId: this.lastEventId,
		};
	}
}

interface OperationSequenceState {
	readonly retryOfOperationId: string | null;
	settled: boolean;
	abortRequested: boolean;
}

interface MessageSequenceState {
	readonly operationId: string;
	readonly turnId: string;
	completed: boolean;
}

interface ToolSequenceState {
	readonly operationId: string;
	readonly turnId: string;
	readonly messageId: string;
	readonly parentCallId: string | null;
	lastUpdateSequence: number;
	completed: boolean;
}

/** Stateful reference validator for the event order an iOS reducer may accept. */
export class GatewayEventSequenceValidator {
	readonly #sessionId: string;
	readonly #operations = new Map<string, OperationSequenceState>();
	readonly #turns = new Map<string, { readonly operationId: string; completed: boolean }>();
	readonly #messages = new Map<string, MessageSequenceState>();
	readonly #tools = new Map<string, ToolSequenceState>();
	#lastEventId: number;
	#pendingReleaseClientId: string | null = null;

	constructor(sessionId: string, afterEventId = "0") {
		if (sessionId.length === 0) throw new TypeError("Event validator requires a session ID");
		this.#sessionId = sessionId;
		this.#lastEventId = parseEventId(afterEventId);
	}

	get lastEventId(): string {
		return String(this.#lastEventId);
	}

	accept(event: GatewayEvent): void {
		const id = parseEventId(event.id);
		if (id === this.#lastEventId) this.#reject("duplicate_event", `Duplicate event ID ${event.id}`);
		if (id < this.#lastEventId) this.#reject("out_of_order_event", `Event ID ${event.id} is out of order`);
		if (id > this.#lastEventId + 1) this.#reject("event_gap", `Expected event ID ${this.#lastEventId + 1}`);
		if (event.contract !== PI_GATEWAY_CONTRACT_ID || event.sessionId !== this.#sessionId) {
			this.#reject("invalid_event_lifecycle", "Event contract or Session does not match the stream");
		}
		this.#acceptLifecycle(event);
		this.#lastEventId = id;
	}

	#acceptLifecycle(event: GatewayEvent): void {
		switch (event.type) {
			case "operation.accepted": {
				const data = event.data;
				if (this.#operations.has(data.operationId)) this.#invalid(`Operation ${data.operationId} already exists`);
				if ((data.command === "retry") !== (data.retryOfOperationId !== null)) {
					this.#invalid("Retry command and retryOfOperationId must be present together");
				}
				if (data.retryOfOperationId !== null && !this.#operations.get(data.retryOfOperationId)?.settled) {
					this.#invalid(`Retry source ${data.retryOfOperationId} is not settled`);
				}
				this.#operations.set(data.operationId, {
					retryOfOperationId: data.retryOfOperationId,
					settled: false,
					abortRequested: false,
				});
				return;
			}
			case "user.message": {
				const data = event.data;
				this.#activeOperation(data.operationId);
				if (this.#messages.has(data.messageId)) this.#invalid(`Message ${data.messageId} already exists`);
				this.#messages.set(data.messageId, { operationId: data.operationId, turnId: "", completed: true });
				return;
			}
			case "turn.started": {
				const data = event.data;
				this.#activeOperation(data.operationId);
				if (this.#turns.has(data.turnId)) this.#invalid(`Turn ${data.turnId} already exists`);
				this.#turns.set(data.turnId, { operationId: data.operationId, completed: false });
				return;
			}
			case "assistant.message.started": {
				const data = event.data;
				this.#activeTurn(data.operationId, data.turnId);
				if (this.#messages.has(data.messageId)) this.#invalid(`Message ${data.messageId} already exists`);
				this.#messages.set(data.messageId, {
					operationId: data.operationId,
					turnId: data.turnId,
					completed: false,
				});
				return;
			}
			case "assistant.text.delta":
			case "assistant.reasoning.delta": {
				const data = event.data;
				this.#activeMessage(data.operationId, data.turnId, data.messageId);
				return;
			}
			case "tool.started": {
				const data = event.data;
				this.#activeMessage(data.operationId, data.turnId, data.messageId);
				if (this.#tools.has(data.toolCallId)) this.#invalid(`Tool ${data.toolCallId} already exists`);
				if (data.parentCallId !== null) this.#activeTool(data.parentCallId);
				this.#tools.set(data.toolCallId, {
					operationId: data.operationId,
					turnId: data.turnId,
					messageId: data.messageId,
					parentCallId: data.parentCallId,
					lastUpdateSequence: 0,
					completed: false,
				});
				return;
			}
			case "tool.updated": {
				const data = event.data;
				const tool = this.#matchingTool(data);
				if (data.updateSequence !== tool.lastUpdateSequence + 1) {
					this.#invalid(`Tool ${data.toolCallId} update sequence is not contiguous`);
				}
				tool.lastUpdateSequence = data.updateSequence;
				return;
			}
			case "tool.completed": {
				const data = event.data;
				const tool = this.#matchingTool(data);
				if (
					[...this.#tools.values()].some(
						(candidate) => candidate.parentCallId === data.toolCallId && !candidate.completed,
					)
				) {
					this.#invalid(`Tool ${data.toolCallId} completed before its nested tool`);
				}
				if (data.status === "success" && data.error !== null) this.#invalid("Successful tool has an error");
				if (data.status === "failure" && data.error === null) this.#invalid("Failed tool has no error");
				tool.completed = true;
				return;
			}
			case "assistant.message.completed": {
				const data = event.data;
				const message = this.#activeMessage(data.operationId, data.turnId, data.messageId);
				if ([...this.#tools.values()].some((tool) => tool.messageId === data.messageId && !tool.completed)) {
					this.#invalid(`Message ${data.messageId} completed with an active tool`);
				}
				if (data.status === "error" && data.error === null) this.#invalid("Errored message has no error");
				if (data.status !== "error" && data.error !== null) this.#invalid("Non-errored message has an error");
				message.completed = true;
				return;
			}
			case "turn.completed": {
				const data = event.data;
				const turn = this.#activeTurn(data.operationId, data.turnId);
				if ([...this.#messages.values()].some((message) => message.turnId === data.turnId && !message.completed)) {
					this.#invalid(`Turn ${data.turnId} completed with an active message`);
				}
				turn.completed = true;
				return;
			}
			case "abort.requested": {
				const data = event.data;
				const operation = this.#activeOperation(data.operationId);
				if (operation.abortRequested) this.#invalid(`Abort already requested for ${data.operationId}`);
				operation.abortRequested = true;
				return;
			}
			case "operation.settled": {
				const data = event.data;
				const operation = this.#activeOperation(data.operationId);
				if (data.retryOfOperationId !== operation.retryOfOperationId) {
					this.#invalid(`Retry linkage changed for ${data.operationId}`);
				}
				if (data.status === "aborted" && !operation.abortRequested) {
					this.#invalid("Aborted operation has no request");
				}
				if (data.status === "failed" && data.error === null) this.#invalid("Failed operation has no error");
				if (data.status !== "failed" && data.error !== null) this.#invalid("Non-failed operation has an error");
				if ([...this.#turns.values()].some((turn) => turn.operationId === data.operationId && !turn.completed)) {
					this.#invalid(`Operation ${data.operationId} settled with an active turn`);
				}
				operation.settled = true;
				return;
			}
			case "gateway.error": {
				const data = event.data;
				if (data.operationId !== null && !this.#operations.has(data.operationId)) {
					this.#invalid(`Error references unknown operation ${data.operationId}`);
				}
				return;
			}
			case "controller.changed": {
				const data = event.data;
				this.#pendingReleaseClientId =
					data.reason === "release" && data.controllerClientId === null ? data.previousControllerClientId : null;
				return;
			}
			case "session.released": {
				const data = event.data;
				if (this.#pendingReleaseClientId !== data.byClientId) {
					this.#invalid("Session release does not follow its controller release");
				}
				this.#pendingReleaseClientId = null;
				return;
			}
		}
	}

	#activeOperation(operationId: string): OperationSequenceState {
		const operation = this.#operations.get(operationId);
		if (!operation || operation.settled) this.#invalid(`Operation ${operationId} is not active`);
		return operation;
	}

	#activeTurn(operationId: string, turnId: string): { readonly operationId: string; completed: boolean } {
		this.#activeOperation(operationId);
		const turn = this.#turns.get(turnId);
		if (!turn || turn.operationId !== operationId || turn.completed) this.#invalid(`Turn ${turnId} is not active`);
		return turn;
	}

	#activeMessage(operationId: string, turnId: string, messageId: string): MessageSequenceState {
		this.#activeTurn(operationId, turnId);
		const message = this.#messages.get(messageId);
		if (!message || message.operationId !== operationId || message.turnId !== turnId || message.completed) {
			this.#invalid(`Message ${messageId} is not active`);
		}
		return message;
	}

	#activeTool(toolCallId: string): ToolSequenceState {
		const tool = this.#tools.get(toolCallId);
		if (!tool || tool.completed) this.#invalid(`Tool ${toolCallId} is not active`);
		return tool;
	}

	#matchingTool(
		data: GatewayEventDataByType["tool.updated"] | GatewayEventDataByType["tool.completed"],
	): ToolSequenceState {
		const tool = this.#activeTool(data.toolCallId);
		if (
			tool.operationId !== data.operationId ||
			tool.turnId !== data.turnId ||
			tool.messageId !== data.messageId ||
			tool.parentCallId !== data.parentCallId
		) {
			this.#invalid(`Tool identity changed for ${data.toolCallId}`);
		}
		return tool;
	}

	#invalid(message: string): never {
		return this.#reject("invalid_event_lifecycle", message);
	}

	#reject(code: GatewayErrorCode, message: string): never {
		throw new GatewayContractError(code, message, 409);
	}
}

export interface GatewayMutationRequest {
	readonly clientId: string;
	readonly idempotencyKey: string;
	/** Stable hash or canonical serialization of the command body. */
	readonly fingerprint: string;
	readonly expectedRevision: number;
}

export interface GatewayMutationResult<T> {
	readonly value: T;
	readonly revision: number;
	readonly replayed: boolean;
}

interface StoredMutation<T> {
	readonly clientId: string;
	readonly fingerprint: string;
	readonly result: GatewayMutationResult<T>;
}

/**
 * Serializes controller mutations, rejects stale writers, and replays successful
 * idempotent results. The embedding gateway remains responsible for persistence.
 */
export class GatewayMutationCoordinator<T> {
	readonly #completed = new Map<string, StoredMutation<T>>();
	readonly #maxCompleted: number;
	#controllerClientId: string | null;
	#revision: number;
	#tail = Promise.resolve();

	constructor(options: { controllerClientId: string | null; revision?: number; maxCompleted?: number }) {
		const revision = options.revision ?? 0;
		const maxCompleted = options.maxCompleted ?? 1024;
		if (!Number.isSafeInteger(revision) || revision < 0) throw new TypeError("Revision must be non-negative");
		if (!Number.isSafeInteger(maxCompleted) || maxCompleted < 1) {
			throw new TypeError("Completed mutation capacity must be positive");
		}
		this.#controllerClientId = options.controllerClientId;
		this.#revision = revision;
		this.#maxCompleted = maxCompleted;
	}

	get revision(): number {
		return this.#revision;
	}

	get controllerClientId(): string | null {
		return this.#controllerClientId;
	}

	setController(clientId: string | null, expectedRevision: number): Promise<number> {
		const result = this.#tail
			.catch(() => {})
			.then(() => {
				if (clientId !== null && clientId.length === 0) {
					throw new GatewayContractError("invalid_request", "Controller clientId must not be empty", 400);
				}
				if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
					throw new GatewayContractError(
						"invalid_request",
						"Expected revision must be a non-negative integer",
						400,
					);
				}
				if (expectedRevision !== this.#revision) {
					throw new GatewayContractError("revision_conflict", "Session revision does not match", 409);
				}
				this.#controllerClientId = clientId;
				this.#revision += 1;
				return this.#revision;
			});
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	execute(request: GatewayMutationRequest, operation: () => Promise<T>): Promise<GatewayMutationResult<T>> {
		const result = this.#tail.catch(() => {}).then(() => this.#executeNow(request, operation));
		this.#tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	async #executeNow(request: GatewayMutationRequest, operation: () => Promise<T>): Promise<GatewayMutationResult<T>> {
		validateMutationRequest(request);
		const previous = this.#completed.get(request.idempotencyKey);
		if (previous) {
			if (previous.clientId !== request.clientId || previous.fingerprint !== request.fingerprint) {
				throw new GatewayContractError(
					"idempotency_conflict",
					"Idempotency key was already used for a different command",
					409,
				);
			}
			return { ...previous.result, replayed: true };
		}
		if (this.#controllerClientId !== request.clientId) {
			throw new GatewayContractError("not_controller", "Only the current controller may mutate a Session", 403);
		}
		if (request.expectedRevision !== this.#revision) {
			throw new GatewayContractError("revision_conflict", "Session revision does not match", 409);
		}
		const value = await operation();
		this.#revision += 1;
		const result = Object.freeze({ value, revision: this.#revision, replayed: false });
		this.#completed.set(request.idempotencyKey, {
			clientId: request.clientId,
			fingerprint: request.fingerprint,
			result,
		});
		if (this.#completed.size > this.#maxCompleted) {
			const oldest = this.#completed.keys().next().value;
			if (oldest !== undefined) this.#completed.delete(oldest);
		}
		return result;
	}
}

function parseEventId(value: string): number {
	if (!/^(0|[1-9][0-9]*)$/.test(value)) {
		throw new GatewayContractError("invalid_replay_cursor", "Replay cursor must be a decimal event ID", 400);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) {
		throw new GatewayContractError("invalid_replay_cursor", "Replay cursor exceeds the supported range", 400);
	}
	return parsed;
}

function validateMutationRequest(request: GatewayMutationRequest): void {
	if (request.clientId.length === 0) throw new GatewayContractError("invalid_request", "clientId is required", 400);
	if (request.idempotencyKey.length < 8 || request.idempotencyKey.length > 128) {
		throw new GatewayContractError("invalid_request", "Idempotency-Key must contain 8 to 128 characters", 400);
	}
	if (request.fingerprint.length === 0) {
		throw new GatewayContractError("invalid_request", "Command fingerprint is required", 400);
	}
	if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
		throw new GatewayContractError("invalid_request", "Expected revision must be a non-negative integer", 400);
	}
}
