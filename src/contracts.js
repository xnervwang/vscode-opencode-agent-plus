// BSD 3-Clause License
// Copyright (c) 2026, Xnerv Wang
// All rights reserved.

'use strict';
/*
 * Shapes shared by src/opencode/, src/host/ and src/ui/. Only JSDoc and frozen constants live here, so every module
 * can require it without pulling in the vscode API.
 */

/**
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
 * content); it is sent back only to the provider named by `providerId`.
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
 * `cache: true` on a system part, and `cacheLastMessage`, mark prompt-cache points.
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
 * `invokeId` is the part of `id` after `providerId/`.
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
 * `run` does not throw for an ordinary failure: it returns `isError: true` with a message the model can read.
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
 * Events the agent core emits for one conversation; the UI draws from these and nothing else.
 *
 *   turnStart        `modelId` is `provider/model`. `unsolicited: true` marks a turn the agent began itself, with no
 *                    userMessage, after a subagent or a background command it waited for finished.
 *   userMessage      `synthetic: true` says a plugin added the text for the model: a work-plan line, a turn-end
 *                    note. `attachments` names what was sent with the text. A replayed one carries `messageId`, the
 *                    agent's id of that message (rewinding goes by it).
 *   text, reasoning  a replayed one may carry the `at` of its message.
 *   usage            when the agent reports `contextWindow`, the share in use can be shown before the model list knows
 *                    the window.
 *   retry            the agent will call the model again in `waitMs`; `attempt` 0 says that call has started.
 *   options          all of the conversation's settings, sent again each time one of them changes.
 *   commands         the slash commands the agent offers; a message `/<name> args` runs one.
 *   compaction       the agent compacting the conversation: 'running', then 'completed' with the summary it wrote,
 *                    or 'failed' / 'cancelled'.
 *   subagent         a subagent of this conversation: its session `childId`, its title and status, `toolId` the call
 *                    of this conversation that started it, and `event` one text, reasoning, toolCall or toolResult
 *                    event of its own. `permission.subagent` and `toolCall.subagent` name the subagent
 *                    a request came from.
 *   question         a form the agent asks the user to fill in, answered with respondQuestion(); `questionSettled`
 *                    says how it was answered. Its `schema` is a JSON Schema object whose properties are strings,
 *                    enums, arrays of enums, numbers, integers or booleans.
 *   background       work the agent left running after its turn, such as a shell command it moved to the background:
 *                    'running' until the process exits, then 'done'.
 * @typedef {(
 *   { type: 'turnStart', turnId: string, at: number, modelId?: string, effort?: string, unsolicited?: true } |
 *   { type: 'userMessage', text: string, at: number, synthetic?: boolean, attachments?: Attachment[], messageId?: string } |
 *   { type: 'text', delta: string, at?: number } |
 *   { type: 'reasoning', delta: string, at?: number } |
 *   { type: 'toolCall', id: string, name: string, input: object, at: number, subagent?: { childId: string, title: string } } |
 *   { type: 'toolResult', id: string, content: string, isError: boolean, display?: object, at: number } |
 *   { type: 'permission', requestId: string, request: PermissionRequest, subagent?: { childId: string, title: string } } |
 *   { type: 'permissionSettled', requestId: string, decision: PermissionDecision } |
 *   { type: 'question', requestId: string, message: string, schema: object, toolId?: string, subagent?: { childId: string, title: string } } |
 *   { type: 'questionSettled', requestId: string, action: 'accept' | 'decline' | 'cancel' } |
 *   { type: 'usage', input: number, output: number, cacheRead?: number, cacheWrite?: number, contextUsed: number, contextWindow?: number, costUsd?: number } |
 *   { type: 'turnEnd', turnId: string, reason: StopReason | 'aborted' | 'error', at: number, error?: ProviderError } |
 *   { type: 'title', title: string } |
 *   { type: 'retry', attempt: number, waitMs?: number, error?: ProviderError, at: number } |
 *   { type: 'options', options: ConfigOption[] } |
 *   { type: 'commands', commands: Array<{ name: string, description: string }> } |
 *   { type: 'compaction', status: 'running' | 'completed' | 'failed' | 'cancelled', id?: string, summary?: string, error?: string } |
 *   { type: 'subagent', childId: string, title: string, status: 'running' | 'done' | 'stopped' | 'failed', toolId?: string, error?: string, event?: AgentEvent } |
 *   { type: 'background', id: string, kind: 'shell', title: string, status: 'running' | 'done', pid?: number, at: number }
 * )} AgentEvent
 */

/**
 * Something sent along with a message's text, as the chat page names it: an image, a file the agent reads itself,
 * or a selection.
 * @typedef {{ kind: 'image' | 'file' | 'selection', name: string, path?: string }} Attachment
 */

/**
 * A file to send with a message: `path` is absolute on the machine the agent runs on. With `text`, it is a selection
 * of lines `startLine` to `endLine` (1-based) sent with that text; without, the agent reads the file itself.
 * @typedef {{ path: string, name?: string, mimeType?: string, text?: string, startLine?: number, endLine?: number }} FileRef
 */

/**
 * A per-conversation setting the agent offers, such as OpenCode's mode (build / plan) or effort.
 * @typedef {{ id: string, name: string, value: string, values: Array<{ value: string, name: string, description?: string }> }} ConfigOption
 */

/**
 * A conversation as the agent core hands it to the UI (src/opencode/index.js makes them; src/host/backend.js lists
 * what the host relies on).
 *
 *   send             resolves with the message's turnEnd and never rejects. A message sent while a turn runs waits
 *                    for that turn. `extra` may also be the images array alone.
 *   options          returns [] when the agent offers no settings.
 *   setOption        changes a setting from the next turn on.
 *   commands         its slash commands as the agent last offered them.
 *   respondQuestion  answers a `question` event; false when that request is no longer open.
 *   reload           used after a rewind.
 * @typedef {{
 *   id: string, cwd: string, title: string, status: 'working' | 'waiting' | 'idle', waitingTool: string,
 *   waitingKind: '' | 'permission' | 'question',
 *   lastUserAt: number, lastReplyAt: number,
 *   on(listener: (ev: AgentEvent) => void): () => void,
 *   send(text: string, extra?: { images?: Array<{ mediaType: string, data: string, name?: string }>, files?: FileRef[] }): Promise<AgentEvent | null>,
 *   abort(): void,
 *   setModel(model: ModelInfo | string): Promise<void>,
 *   getModel(): string,
 *   options(): ConfigOption[],
 *   setOption(id: string, value: string): Promise<void>,
 *   commands(): Array<{ name: string, description: string }>,
 *   attachments(): { images: boolean, files: boolean, selection: boolean },
 *   respondPermission(requestId: string, decision: PermissionDecision): boolean,
 *   respondQuestion(requestId: string, answer: { action: 'accept', content: object } | { action: 'decline' | 'cancel' }): boolean,
 *   history(): Promise<AgentEvent[]>,
 *   reload(): Promise<AgentEvent[]>,
 *   checkBackground(): void,
 *   dispose(): void
 * }} Conversation
 */

/**
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
