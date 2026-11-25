# Settings and Commands

Back to the [README](../README.md).

## Settings

You can change these settings under OpenCode Agent Plus in the VS Code Settings editor.

| Setting | Default | What it does |
|---|---|---|
| `opencodeAgentPlus.model` | Empty | Sets the [model for new conversations](setup.md#installing-opencode-agent-plus). Use `provider/model`, such as `amazon-bedrock/us.xai.grok-4.7`. If you leave it empty, OpenCode Agent Plus asks you to choose a model when you send your first message. |
| `opencodeAgentPlus.autosave` | On | Saves edited files before a message is sent or a permission request is allowed, so OpenCode reads and changes what the editor shows. |
| `opencodeAgentPlus.attachOpenFile` | On | Sends the file open in the editor with your messages, as a reference OpenCode reads. When off, a file goes along only with the lines you select. |
| `opencodeAgentPlus.attachSelection` | On | Sends the lines you select in the editor with your messages. When off, add them with the selection button or Alt+K. |
| `opencodeAgentPlus.useCtrlEnterToSend` | Off | Sends with Ctrl+Enter (Cmd+Enter on macOS), so that Enter starts a new line. |
| `opencodeAgentPlus.showFixActions` | On | Shows Fix with OpenCode Agent Plus among the quick fixes where the editor reports an error or a warning. |
| `opencodeAgentPlus.opencode.path` | Empty | Sets the path to the [OpenCode executable](setup.md#how-opencode-agent-plus-finds-opencode). If you leave it empty, OpenCode Agent Plus searches for it. Set it in User or Remote settings, not Workspace settings. |
| `opencodeAgentPlus.opencode.askPermissions` | On | Applies [OpenCode Agent Plus's permission rules](features.md#permission-prompts) for edits, commands, web requests and access outside the project. Set it in User or Remote settings, not Workspace settings. |
| `opencodeAgentPlus.opencode.environment` | Empty | Adds environment variables for the OpenCode that OpenCode Agent Plus starts, such as `{ "OPENAI_BASE_URL": "https://…" }`. The two Bedrock settings and the stored Bedrock API key take precedence over the same names. Set it in User or Remote settings, not Workspace settings. |
| `opencodeAgentPlus.todoList` | On | Turns on OpenCode 2's experimental [todo list tool](features.md#todo-list) by adding `todo` to `OPENCODE_FLAGS`. |
| `opencodeAgentPlus.bedrock.profile` | Empty | Sets the [AWS profile for Amazon Bedrock](setup.md#through-opencode-agent-plus-settings). Set it in User or Remote settings, not Workspace settings. |
| `opencodeAgentPlus.bedrock.region` | Empty | Sets the [AWS Region for Amazon Bedrock](setup.md#through-opencode-agent-plus-settings). Set it in User or Remote settings, not Workspace settings. |
| `opencodeAgentPlus.workPlan` | On | In Custom [token mode](features.md#token-mode), lets the model keep a work plan. |
| `opencodeAgentPlus.planBar` | On | Shows the [plan bar](features.md#work-plan-and-plan-bar) above the input box. |
| `opencodeAgentPlus.conversationLinks` | On | Turns mentions of other conversations into [links in replies](features.md#links-and-images-in-replies). |
| `opencodeAgentPlus.focusView` | Off | Shows only your messages and the last reply of each turn ([Focus view](features.md#focus-view)). |
| `opencodeAgentPlus.pinPrompt` | On | Keeps your message [pinned at the top](features.md#pinned-message) while you scroll through its reply. |
| `opencodeAgentPlus.conversationBrief` | On | In Custom token mode, lets the model keep a [conversation brief](features.md#conversation-brief). |
| `opencodeAgentPlus.tellOpenCodeYourTimeZone` | On | In Custom token mode, tells the model [your time zone](setup.md#remote-ssh) when it differs from the OpenCode machine's time zone. |

### Settings That Restart OpenCode

**Let a running turn finish before you change the OpenCode path, permission rules, environment variables, todo list setting, Bedrock profile, Region or stored Bedrock API key.** Changing any of them restarts OpenCode, which ends a running turn with an error. The other settings take effect without a restart.

## Turning Features Off

Agent Plus's [Token Mode](features.md#token-mode) controls what OpenCode Agent Plus adds to the model's context. In any token mode, you can adjust the plan bar, conversation links, permission rules and chimes.

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
| OpenCode Agent Plus's permission rules | Turn off `opencodeAgentPlus.opencode.askPermissions` to use your own OpenCode rules. |
| Chimes | Click the note button under the input box. |

## Commands

In the Command Palette, search for `OpenCode Agent Plus:` to find these commands.

| Command | What it does |
|---|---|
| `OpenCode Agent Plus: New Conversation` | Opens a new conversation in an editor tab. |
| `OpenCode Agent Plus: Fork Conversation` | Copies the conversation into a new tab. Available when a chat tab is active. |
| `OpenCode Agent Plus: Find Conversation…` | Finds a conversation by title, session ID or folder. |
| `OpenCode Agent Plus: Clear Recently Closed` | Clears the Recently closed group in the Conversations view. |
| `OpenCode Agent Plus: Choose Model for New Conversations` | Lists the models OpenCode offers and saves your choice in `opencodeAgentPlus.model`. |
| `OpenCode Agent Plus: Test OpenCode Connection` | Checks whether OpenCode is installed and reports [model counts or Bedrock credential errors](setup.md#checking-the-connection) when available. |
| `OpenCode Agent Plus: Download OpenCode 2.4.1` | Downloads [OpenCode 2.4.1](setup.md#installing-opencode) from GitHub into `~/.opencode-agent-plus/opencode/2.4.1/`. An OpenCode you install yourself is used first. |
| `OpenCode Agent Plus: Set Amazon Bedrock API Key` | Saves your Bedrock API key in VS Code's secret storage. |
| `OpenCode Agent Plus: Clear Amazon Bedrock API Key` | Removes the stored Bedrock API key. |
| `OpenCode Agent Plus: Download Python for Work Plans` | Downloads Python for the work plan on Windows. |
| `OpenCode Agent Plus: Look for Python Again for Work Plans` | Checks again for a Python installation the work plan can use. |
| `OpenCode Agent Plus: Show MCP Servers` | Runs `opencode mcp list` and shows OpenCode's MCP (Model Context Protocol) servers in a VS Code output channel. |
| `OpenCode Agent Plus: Show Logs` | Opens OpenCode Agent Plus's log in the Output panel. |
| `OpenCode Agent Plus: Toggle Focus View` | Turns [Focus view](features.md#focus-view) on or off. Ctrl+Alt+F in a chat tab does the same. |
| `OpenCode Agent Plus: Connect a Model Provider` | Runs OpenCode's own sign-in (`opencode auth login`) in a terminal, then lists the models again when you close it. |
| `OpenCode Agent Plus: Focus the Message Box` | Moves to the input box of the chat tab in front, or opens a new conversation. Cmd+Esc on macOS, the Windows or Super key with Esc on Windows and Linux, as in the Claude Code extension. |
| `OpenCode Agent Plus: Insert @-Mention Reference` | Inserts the file in the editor, or its selected lines, into the chat tab in front. Alt+K. |

To add an MCP server, run `opencode mcp add` or edit OpenCode's configuration file.

With a chat tab in front, press Cmd+Shift+Esc on macOS, or Meta+Shift+Esc on Windows and Linux, to start a new conversation. To reopen a chat tab you closed, use VS Code's Reopen Closed Editor (Cmd+Shift+T on macOS, Ctrl+Shift+T on Windows and Linux) or the Recently closed group in the Conversations view.

Add to Conversation is in the editor's and the Explorer's context menus, and Fix with OpenCode Agent Plus among the editor's quick fixes. In a chat tab, the same keys go back to the editor.

Rename Conversation and Delete Conversation are menu actions outside the Command Palette. Both are available in the [Conversations view](features.md#the-conversations-list). You can also [rename a conversation from its tab or editor title menu](features.md#chat-tabs-and-windows).
