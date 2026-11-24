// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Shapes shared by the provider layer, the agent core and the UI. Only JSDoc and frozen constants live here, so every
 * module can require it without pulling in the AWS SDK or the vscode API.
 */

/**
 * A conversation message in the provider-neutral form the agent keeps. Adapters convert to and from each API.
 * @typedef {{ role: 'user' | 'assistant', content: ContentBlock[] }} Message
 */

/**
 * @typedef {(
 *   { type: 'text', text: string } |
 *   { type: 'image', mediaType: string, data: string } |
 *   { type: 'toolUse', id: string, name: string, input: object } |
 *   { type: 'toolResult', toolUseId: string, content: Array<{ type: 'text', text: string } | { type: 'image', mediaType: string, data: string }>, isError?: boolean } |
 *   { type: 'reasoning', text: string, providerId?: string, opaque?: unknown }
 * )} ContentBlock
 * `image.data` is base64. `reasoning.opaque` is whatever the provider must get back unchanged (a signature, encrypted
 * content); it is only sent back to the provider named by `providerId` and dropped for any other.
 */

/**
 * @typedef {{ name: string, description: string, inputSchema: object }} ToolSpec  JSON Schema for the input.
 */

/**
 * @typedef {{
 *   model: ModelInfo,
 *   system: Array<{ text: string, cache?: boolean }>,
 *   messages: Message[],
 *   tools: ToolSpec[],
 *   maxOutputTokens?: number,
 *   effort?: 'low' | 'medium' | 'high',
 *   cacheLastMessage?: boolean
 * }} ChatRequest
 * `cache: true` on a system part and `cacheLastMessage` mark prompt-cache points; adapters drop them where unsupported.
 */

/**
 * @typedef {{
 *   id: string,
 *   invokeId: string,
 *   name: string,
 *   vendor: string,
 *   providerId: string,
 *   contextWindow: number,
 *   maxOutputTokens: number,
 *   supports: {
 *     tools: boolean, parallelTools: boolean, images: boolean, documents: boolean,
 *     temperature: boolean, promptCache: boolean, reasoning: 'none' | 'effort' | 'always'
 *   },
 *   pricing?: { input: number, output: number, cacheRead?: number, cacheWrite?: number },
 *   known: boolean
 * }} ModelInfo
 * `invokeId` is what the API is called with (for Bedrock, the inference profile id when the model needs one).
 * Prices are USD per million tokens. `known` is false when the numbers are defaults rather than from the catalog.
 */

/**
 * @typedef {(
 *   { type: 'text', delta: string } |
 *   { type: 'reasoning', delta: string, opaque?: unknown } |
 *   { type: 'toolUseStart', index: number, id: string, name: string } |
 *   { type: 'toolUseDelta', index: number, inputDelta: string } |
 *   { type: 'toolUseEnd', index: number } |
 *   { type: 'usage', input: number, output: number, cacheRead?: number, cacheWrite?: number } |
 *   { type: 'stop', reason: StopReason } |
 *   { type: 'error', error: ProviderError }
 * )} StreamEvent
 */

/** @typedef {'endTurn' | 'toolUse' | 'maxTokens' | 'refused' | 'reasoningOnly'} StopReason */

/**
 * @typedef {(
 *   { kind: 'auth', message: string } |
 *   { kind: 'permission', message: string, action?: string } |
 *   { kind: 'modelNotEnabled', message: string } |
 *   { kind: 'throttled', message: string, retryAfterMs?: number } |
 *   { kind: 'contextTooLong', message: string } |
 *   { kind: 'badRequest', message: string, field?: string } |
 *   { kind: 'refused', message: string } |
 *   { kind: 'unavailable', message: string } |
 *   { kind: 'aborted', message: string }
 * )} ProviderError
 */

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   checkAuth(signal?: AbortSignal): Promise<{ ok: boolean, detail: string }>,
 *   listModels(signal?: AbortSignal): Promise<ModelInfo[]>,
 *   stream(req: ChatRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>
 * }} ModelProvider
 */

/**
 * A tool the agent can call. `run` gets the parsed input and a context; it never throws for an ordinary failure, it
 * returns `isError: true` with a message the model can read.
 * @typedef {{
 *   spec: ToolSpec,
 *   needsPermission(input: object, ctx: ToolContext): PermissionRequest | null,
 *   run(input: object, ctx: ToolContext): Promise<{ content: string, isError?: boolean, display?: object }>
 * }} Tool
 */

/**
 * @typedef {{ cwd: string, signal: AbortSignal, sessionId: string }} ToolContext
 */

/**
 * @typedef {{
 *   kind: 'edit' | 'write' | 'command' | 'read-outside' | 'other',
 *   tool: string,
 *   summary: string,
 *   detail?: string,
 *   path?: string,
 *   command?: string,
 *   diff?: { path: string, before: string, after: string }
 * }} PermissionRequest
 * `other` is any permission outside the four, such as fetching a web page or starting a subagent: `summary` names it and
 * `detail` carries its input.
 */

/** @typedef {'allowOnce' | 'allowSession' | 'deny'} PermissionDecision */

/**
 * Events the agent core emits for one conversation; the UI draws from these and nothing else. A userMessage with
 * `synthetic: true` is text a plugin added for the model (a work-plan line, a turn-end note), not something the user typed.
 * `turnStart.modelId` is the model the turn runs on (provider/model) and `effort` the effort it runs with when one is
 * set; `unsolicited: true` marks a turn the agent began itself (a subagent or a background command it waited for has
 * finished), which has no userMessage. `usage.contextWindow` is that model's context window when the agent reports it,
 * so the share in use can be shown before the model list knows the window. `retry` says the agent will try the model
 * again in `waitMs`; attempt 0 says that try has started. `options` carries the conversation's settings anew whenever
 * they change.
 * @typedef {(
 *   { type: 'turnStart', turnId: string, at: number, modelId?: string, effort?: string, unsolicited?: true } |
 *   { type: 'userMessage', text: string, at: number, synthetic?: boolean } |
 *   { type: 'text', delta: string } |
 *   { type: 'reasoning', delta: string } |
 *   { type: 'toolCall', id: string, name: string, input: object, at: number } |
 *   { type: 'toolResult', id: string, content: string, isError: boolean, display?: object, at: number } |
 *   { type: 'permission', requestId: string, request: PermissionRequest } |
 *   { type: 'permissionSettled', requestId: string, decision: PermissionDecision } |
 *   { type: 'usage', input: number, output: number, cacheRead?: number, cacheWrite?: number, contextUsed: number, contextWindow?: number, costUsd?: number } |
 *   { type: 'turnEnd', turnId: string, reason: StopReason | 'aborted' | 'error', at: number, error?: ProviderError } |
 *   { type: 'title', title: string } |
 *   { type: 'retry', attempt: number, waitMs?: number, error?: ProviderError, at: number } |
 *   { type: 'options', options: ConfigOption[] }
 * )} AgentEvent
 */

/**
 * A setting of one conversation the agent offers, such as OpenCode's mode (build / plan) or effort.
 * @typedef {{ id: string, name: string, value: string, values: Array<{ value: string, name: string, description?: string }> }} ConfigOption
 */

/**
 * A conversation as the agent core hands it to the UI (src/opencode/index.js makes them; src/host/backend.js lists
 * what the host relies on). `send` resolves with the turnEnd of its message's turn and never rejects; a message sent
 * while a turn runs waits for it. `options()` lists the settings the agent offers for this conversation, [] when none,
 * and `setOption` changes one from the next turn on.
 * @typedef {{
 *   id: string, cwd: string, title: string, status: 'working' | 'waiting' | 'idle', waitingTool: string,
 *   lastUserAt: number, lastReplyAt: number,
 *   on(listener: (ev: AgentEvent) => void): () => void,
 *   send(text: string, images?: Array<{ mediaType: string, data: string }>): Promise<AgentEvent | null>,
 *   abort(): void,
 *   setModel(model: ModelInfo | string): Promise<void>,
 *   getModel(): string,
 *   options(): ConfigOption[],
 *   setOption(id: string, value: string): Promise<void>,
 *   respondPermission(requestId: string, decision: PermissionDecision): boolean,
 *   history(): Promise<AgentEvent[]>,
 *   dispose(): void
 * }} Conversation
 */

/**
 * One line of a session file (`<sessionsDir>/<id>.jsonl`), appended in order.
 * @typedef {(
 *   { kind: 'meta', format: 1, id: string, cwd: string, createdAt: number, providerId: string, modelId: string, title?: string } |
 *   { kind: 'message', at: number, message: Message } |
 *   { kind: 'usage', at: number, input: number, output: number, cacheRead?: number, cacheWrite?: number, costUsd?: number } |
 *   { kind: 'title', at: number, title: string } |
 *   { kind: 'model', at: number, providerId: string, modelId: string }
 * )} SessionRecord
 */

const STOP_REASONS = Object.freeze(['endTurn', 'toolUse', 'maxTokens', 'refused', 'reasoningOnly']);
const ERROR_KINDS = Object.freeze(['auth', 'permission', 'modelNotEnabled', 'throttled', 'contextTooLong', 'badRequest', 'refused', 'unavailable', 'aborted']);
const PERMISSION_DECISIONS = Object.freeze(['allowOnce', 'allowSession', 'deny']);

module.exports = { STOP_REASONS, ERROR_KINDS, PERMISSION_DECISIONS };
