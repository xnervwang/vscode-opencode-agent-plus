# Settings and Commands

Back to the [README](../README.md).

## Settings

You can change these settings under OpenCode Agent Plus in the VS Code Settings editor.

| Setting | Default | What it does |
|---|---|---|
| `opencodeAgentPlus.model` | Empty | Sets the [model for new conversations](setup.md#installing-opencode-agent-plus). Use `provider/model`, such as `amazon-bedrock/us.xai.grok-4.7`. If you leave it empty, OpenCode Agent Plus asks you to choose a model when you send your first message. |
| `opencodeAgentPlus.openCodeModels` | `auto` | Whether the model lists of chat tabs (each conversation's editor tab) and of `OpenCode Agent Plus: Choose Model for New Conversations` include OpenCode's own free models, which run on opencode.ai: `auto` lists them while no other provider is connected, `show` always, and `hide` leaves them out and turns off OpenCode's own provider. When `auto` or `hide` leaves them out, a chat tab still lists the free model its conversation uses, and with `auto` the command still lists the one in `opencodeAgentPlus.model`. |
| `opencodeAgentPlus.autosave` | On | Saves edited files before a message is sent or a [permission request](features.md#permission-prompts) is allowed, so that OpenCode works with the text you see in the editor. |
| `opencodeAgentPlus.attachOpenFile` | On | Sends a [reference to the file open in the editor](features.md#files-and-selections-from-the-editor) with your messages. When off, only the lines you select in the file are sent automatically, if `opencodeAgentPlus.attachSelection` is on. |
| `opencodeAgentPlus.attachSelection` | On | Sends the lines you select in the editor with your messages. When off, add them by clicking the [pill under the input box](features.md#files-and-selections-from-the-editor) or with Alt+K. |
| `opencodeAgentPlus.useCtrlEnterToSend` | Off | Sends with Ctrl+Enter (Cmd+Enter on macOS), so that Enter starts a new line. |
| `opencodeAgentPlus.showFixActions` | On | Shows Fix with OpenCode Agent Plus, which puts the problem into a draft message, among the quick fixes where the editor reports an error or a warning. |
| `opencodeAgentPlus.opencode.path` | Empty | Sets the path to the [OpenCode executable](setup.md#how-opencode-agent-plus-finds-opencode). If you leave it empty, OpenCode Agent Plus searches for it. Set it in User or Remote settings, not Workspace settings. |
| `opencodeAgentPlus.opencode.askPermissions` | On | Applies [OpenCode Agent Plus's permission rules](features.md#permission-prompts) for edits, commands, web requests and access outside the project. Set it in User or Remote settings, not Workspace settings. |
| `opencodeAgentPlus.opencode.environment` | Empty | Adds environment variables to the OpenCode process the extension starts, such as `{ "OPENAI_BASE_URL": "https://…" }`. The `opencodeAgentPlus.bedrock.profile` and `opencodeAgentPlus.bedrock.region` settings and the Bedrock API key stored with `OpenCode Agent Plus: Set Amazon Bedrock API Key` take precedence over `AWS_PROFILE`, `AWS_REGION` and `AWS_BEARER_TOKEN_BEDROCK` set here. Set it in User or Remote settings, not Workspace settings. |
| `opencodeAgentPlus.todoList` | On | Turns on OpenCode 2's experimental [todo list tool](features.md#todo-list) by adding `todo` to the `OPENCODE_FLAGS` environment variable. |
| `opencodeAgentPlus.bedrock.profile` | Empty | Sets the [AWS profile for Amazon Bedrock](setup.md#through-opencode-agent-plus-settings). Set it in User or Remote settings, not Workspace settings. |
| `opencodeAgentPlus.bedrock.region` | Empty | Sets the [AWS Region for Amazon Bedrock](setup.md#through-opencode-agent-plus-settings). Set it in User or Remote settings, not Workspace settings. |
| `opencodeAgentPlus.workPlan` | On | In Custom [token mode](features.md#token-mode), lets the model keep a work plan. |
| `opencodeAgentPlus.planBar` | On | Shows the [plan bar](features.md#work-plan-and-plan-bar) above the input box. |
| `opencodeAgentPlus.conversationLinks` | On | Turns mentions of other conversations into [links in replies](features.md#links-and-images-in-replies). |
| `opencodeAgentPlus.focusView` | Off | Shows only your messages, the last reply of each turn and the permission requests and questions waiting for your answer ([Focus view](features.md#focus-view)). |
| `opencodeAgentPlus.pinPrompt` | On | Keeps your message [pinned at the top](features.md#pinned-message) while you scroll through its reply. |
| `opencodeAgentPlus.loadRestoredTabs` | Off | After a reload, or when the window opens, loads the OpenCode conversations in background tabs too, instead of each one when you first click its tab. Each tab comes to the front for a moment, then the tab you had in front comes back. |
| `opencodeAgentPlus.conversationBrief` | On | In Custom token mode, lets the model keep a [conversation brief](features.md#conversation-brief). |
| `opencodeAgentPlus.tellOpenCodeYourTimeZone` | On | In Custom token mode, tells the model [your time zone](setup.md#remote-ssh) when it differs from the OpenCode machine's time zone. |

### Settings That Restart OpenCode

**Let a running turn finish before you change the OpenCode path, permission rules, environment variables, todo list setting, Bedrock profile, Region or stored Bedrock API key, or switch `opencodeAgentPlus.openCodeModels` from `auto` or `show` to `hide` or from `hide` to `auto` or `show`.** Changing any of them restarts OpenCode, which ends a running turn with an error. The other settings take effect without a restart.

## Turning Features Off

[Token Mode](features.md#token-mode) controls what OpenCode Agent Plus adds to the model's context. In any token mode, you can adjust the plan bar, conversation links, permission rules and chimes, turn OpenCode 2's todo list tool on or off (`opencodeAgentPlus.todoList`), and choose whether to attach the open file (`opencodeAgentPlus.attachOpenFile`) or the selected lines (`opencodeAgentPlus.attachSelection`) to your messages.

| What | How |
|---|---|
| Everything OpenCode Agent Plus adds to the model's context | Choose Interface features as the token mode. |
| Work plan | Choose Custom and turn off `opencodeAgentPlus.workPlan`. |
| Conversation brief | Choose Custom and turn off `opencodeAgentPlus.conversationBrief`. |
| Time-zone note | Choose Custom and turn off `opencodeAgentPlus.tellOpenCodeYourTimeZone`. |
| Note about images in replies | Choose Interface features. This note has no separate switch. |
| Plan bar | Turn off `opencodeAgentPlus.planBar`. |
| Links to other conversations | Turn off `opencodeAgentPlus.conversationLinks`. |
| OpenCode's todo list tool | Turn off `opencodeAgentPlus.todoList`. |
| Sending the open file and selected lines | Turn off `opencodeAgentPlus.attachOpenFile` and `opencodeAgentPlus.attachSelection`. |
| OpenCode Agent Plus's permission rules | Turn off `opencodeAgentPlus.opencode.askPermissions` to use your own OpenCode rules. |
| Chimes | Click the music-note button under the input box. |

## Commands

In the Command Palette, search for `OpenCode Agent Plus:` to find these commands.

| Command | What it does |
|---|---|
| `OpenCode Agent Plus: New Conversation` | Opens a new conversation in an editor tab. |
| `OpenCode Agent Plus: Fork Conversation` | Copies the conversation into a new tab. Available when a chat tab is active. |
| `OpenCode Agent Plus: Choose Model for New Conversations` | Lists the models OpenCode offers, grouped by provider, and saves your choice in `opencodeAgentPlus.model`. |
| `OpenCode Agent Plus: Test OpenCode Connection` | Checks whether OpenCode is installed and reports [model counts or Bedrock credential errors](setup.md#checking-the-connection) when available. |
| `OpenCode Agent Plus: Download OpenCode 2.4.1` | Downloads [OpenCode 2.4.1](setup.md#installing-opencode) from GitHub into `~/.opencode-agent-plus/opencode/2.4.1/`. An OpenCode you install yourself is used first. |
| `OpenCode Agent Plus: Set Amazon Bedrock API Key` | Saves your Bedrock API key in VS Code's secret storage. |
| `OpenCode Agent Plus: Clear Amazon Bedrock API Key` | Removes the stored Bedrock API key. |
| `OpenCode Agent Plus: Download Python for Work Plans` | Downloads Python for the work plan on Windows. |
| `OpenCode Agent Plus: Look for Python Again for Work Plans` | Checks again for a Python installation the work plan can use. |
| `OpenCode Agent Plus: Show MCP Servers` | Runs `opencode mcp list` and shows OpenCode's MCP (Model Context Protocol) servers in a VS Code output channel. |
| `OpenCode Agent Plus: Show Logs` | Opens OpenCode Agent Plus's log in the Output panel. |
| `OpenCode Agent Plus: Toggle Focus View` | Turns [Focus view](features.md#focus-view) on or off. Ctrl+Alt+F in a chat tab does the same. |
| `OpenCode Agent Plus: Connect a Model Provider` | Runs OpenCode's own sign-in (`opencode auth login`) in a terminal, then refreshes the chat tabs' model lists when you close the terminal and tells you whether the sign-in connected a provider, saved new credentials for one already connected, or saved nothing. |
| `OpenCode Agent Plus: Focus the Message Box` | Moves to the input box of the chat tab in front (the one you used last), or opens a new conversation. Cmd+Esc on macOS, the Windows or Super key with Esc on Windows and Linux, as in the Claude Code extension. |
| `OpenCode Agent Plus: Insert @-Mention Reference` | Inserts an @ reference to the file in the editor, or to its selected lines, into the chat tab in front. Alt+K. |

To add an MCP server, run `opencode mcp add` or edit OpenCode's configuration file.

With a chat tab in front, press Cmd+Shift+Esc on macOS, or the Windows or Super key with Shift+Esc on Windows and Linux, to start a new conversation. Use `Agent Plus: Reopen Closed Conversation` (Cmd+Shift+T on macOS or Ctrl+Shift+T on Windows and Linux) to reopen the last conversation whose tab you closed, or click a conversation in the Recently closed section of Agent Plus's [Conversations list](features.md#the-conversations-list) to reopen it.

Choose Add to Conversation from the editor's context menu to put a reference to the open file or its selected lines in the input box of the chat tab in front, or from the Explorer's context menu to add references to the files you selected there.

When the editor reports an error or warning, choose Fix with OpenCode Agent Plus from its quick fixes to append a draft naming the file, line and problem after any text in that input box. In a chat tab, the keys for `OpenCode Agent Plus: Focus the Message Box` (Cmd+Esc on macOS, Windows+Esc on Windows, or Super+Esc on Linux) take you back to the file editor that was in front last.

Rename Conversation is not in the Command Palette. Choose it from [the chat tab's context menu or the editor title's `...` menu](features.md#chat-tabs-and-windows), or from a row's menu in Agent Plus's [Conversations list](features.md#the-conversations-list), where you can also archive or delete the conversation.
