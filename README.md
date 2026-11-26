# OpenCode Agent Plus

OpenCode Agent Plus starts OpenCode, an open-source coding agent, and opens your conversations in VS Code editor tabs. **You can use any model provider OpenCode connects to.** For Amazon Bedrock, the extension lets you set an AWS profile, a Region and a Bedrock API key, and has a command to test the connection.

The chat interface follows Anthropic's Claude Code extension for VS Code and Claude Code Plus, an extension from the publisher of OpenCode Agent Plus that adds features to Anthropic's extension.

The model keeps a work plan for what's still open in each conversation, and the companion extension Agent Plus (`xnervwang.agent-plus`) shows conversations and their work plans from OpenCode Agent Plus, Claude Code Plus and Codex Plus in one place.

## Getting Started

You need VS Code 1.96 or later and OpenCode on the machine where the extension runs; the work plan also needs Python 3.7 or later.

1. Install OpenCode 2 with `npm install -g @opencode/cli` (npm comes with Node.js). Of the two release lines, OpenCode 1 is enough for chatting, but the work plan and several other features need OpenCode 2. You can also skip this step: once installed, OpenCode Agent Plus offers to download OpenCode 2.4.1 on macOS, Linux and Windows when it can't find OpenCode. See [Installing OpenCode](docs/setup.md#installing-opencode).
2. Search for OpenCode Agent Plus in the Extensions view and install it, or run `code --install-extension xnervwang.opencode-agent-plus`. VS Code installs Agent Plus along with it. See [Installing OpenCode Agent Plus](docs/setup.md#installing-opencode-agent-plus).
3. Give OpenCode your provider credentials as described in [Connecting a Model Provider](#connecting-a-model-provider).
4. Open Agent Plus's Conversations list from its Conversations icon in the activity bar. In the New bar at the top of the list, click the agent logo on the left, choose OpenCode Agent Plus, then click New in tab and send your first message.

See [Checking the Connection](docs/setup.md#checking-the-connection).

## Connecting a Model Provider

OpenCode Agent Plus uses the model providers you set up in OpenCode. For Amazon Bedrock, you can configure credentials through the extension's settings or OpenCode's own configuration:

- [Through OpenCode Agent Plus Settings](docs/setup.md#through-opencode-agent-plus-settings): Set your AWS profile and Region, or store a Bedrock API key with the `OpenCode Agent Plus: Set Amazon Bedrock API Key` command.
- [Through OpenCode's Own Configuration](docs/setup.md#through-opencodes-own-configuration): Put your AWS profile and Region in `~/.config/opencode/opencode.json`, or set AWS environment variables in the environment VS Code starts with.

In a chat tab, you can also select Connect a provider… from the model list under the message box. This opens OpenCode's sign-in (`opencode auth login`) in a VS Code terminal, where the Amazon Bedrock entry in OpenCode 2 accepts an AWS profile or a Bedrock API key. For [other model providers](docs/setup.md#other-model-providers), select Connect a provider… from the model list or run `opencode auth login` on the machine where OpenCode runs.

## Remote-SSH

In a [Remote-SSH](docs/setup.md#remote-ssh) window, the extension and OpenCode run on the remote machine, where you configure your provider credentials. If you store a Bedrock API key with `OpenCode Agent Plus: Set Amazon Bedrock API Key`, the key stays in VS Code's secret storage on your own computer, and the extension passes it to OpenCode. The chat page runs on your computer and reports its time zone.

## Features

### In a Conversation

| Feature | What it does |
| --- | --- |
| [Chat tabs](docs/features.md#messages-tools-and-permissions) | Each conversation opens in an editor tab with streaming replies and a row for each tool call, such as a command or a file edit; the row opens to show the call's input and output. |
| [Permission prompts](docs/features.md#permission-prompts) | OpenCode asks before it edits files, runs commands, fetches web pages or works outside the project, and you can review a proposed edit as a diff. |
| [Questions from the model](docs/features.md#questions-from-the-model) | You answer them in a form. |
| [Slash commands, files and images](docs/features.md#writing-a-message) | Type `/` to list OpenCode commands or `@` to list workspace files, or add your editor selection and images to a message. |
| [Model, mode and effort](docs/features.md#models-modes-and-reply-figures) | You choose them in the row of buttons under the input box; the mode sets whether OpenCode asks before editing files, edits on its own or only plans, and effort sets how much the model reasons. |
| [Reply figures](docs/features.md#models-modes-and-reply-figures) | How long the reply took, context use (how full the model's context window is), the conversation's cost so far, model and effort, shown on each reply's last row after the time it arrived. |
| [Context and compaction](docs/features.md#context-compaction-and-retries) | A ring shows how full the context window is, and a divider marks where OpenCode summarized older turns to make room. |
| [Outline, session information and chimes](docs/features.md#getting-around-a-long-conversation) | A rail on the right edge moves between your messages and opens a list of them, a box shows the conversation's details, and a chime sounds when a turn ends or OpenCode waits for you. |
| [Links and images in replies](docs/features.md#links-and-images-in-replies) | Replies link to other conversations by title or ID and display images from the machine where OpenCode runs. |
| [Rewind and Fork](docs/features.md#rewinding-and-forking) | You can rewind to before one of your messages, which in a Git repository also restores files, or fork a copy of the conversation. |
| [Subagents and background work](docs/features.md#subagents-and-background-work) | You can track running commands and subagents, the helper agents the model starts for part of a task. |

### In the Conversations List and on Tabs

| Feature | What it does |
| --- | --- |
| [Conversations list](docs/features.md#the-conversations-list) | For each OpenCode conversation in this window's workspace folders or their linked Git worktrees (other checkouts of the same repository), you can see what it's doing and whether it's open in another VS Code window or in OpenCode's terminal interface, or is handling a prompt sent with `opencode run`, and you can rename, fork, archive or delete it. |
| [Find Conversation](docs/features.md#the-conversations-list) | If you know part of an OpenCode conversation's title or ID, run `Agent Plus: Find Conversation by Title or ID...` from the Command Palette to find it. |
| [Tab dots and envelopes](docs/features.md#chat-tabs-and-windows) | A green dot shows that a conversation is working and a red dot that it needs your permission or an answer; an envelope marks an unread reply. |
| [One window at a time](docs/features.md#chat-tabs-and-windows) | You can take over a conversation that's open in another window; that window then stops any running turn and closes the conversation. |

### With Agent Plus

| Feature | What it does |
| --- | --- |
| [Work plan](docs/features.md#work-plan-and-plan-bar) | The model maintains the conversation's plan, and the Work plan view in Agent Plus lists its rows. |
| [Plan bar](docs/features.md#work-plan-and-plan-bar) | A bar above the input box shows where the plan stands. |
| [Conversation brief](docs/features.md#conversation-brief) | Agent Plus shows a short summary and status for each conversation, both kept up to date by the model. |
| [Your time zone for the model](docs/setup.md#remote-ssh) | When OpenCode runs in a different time zone, OpenCode Agent Plus tells the model yours. |
| [Token mode](docs/features.md#token-mode) | This Agent Plus setting controls which features add text to the messages OpenCode sends to the model. |

## Settings and Commands

You'll find the extension's settings under OpenCode Agent Plus in the VS Code Settings editor. See [Settings and Commands](docs/settings.md) for the full list and instructions for turning features off.

## Known Limits

[Known Limits](docs/known-limits.md) covers reopening and rewinding conversations and what happens when another window holds a conversation.

## License

OpenCode Agent Plus is licensed under the BSD 3-Clause license. Its icons include the OpenCode mark under OpenCode's MIT license; see [ThirdPartyNotices.txt](ThirdPartyNotices.txt).
