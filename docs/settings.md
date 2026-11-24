# Settings and Commands

Back to the [README](../README.md).

## Settings

You can change these settings under OpenCode Plus in the VS Code Settings editor.

| Setting | Default | What it does |
|---|---|---|
| `opencodePlus.model` | Empty | Sets the [model for new conversations](setup.md#installing-opencode-plus). Use `provider/model`, such as `amazon-bedrock/us.xai.grok-4.7`. If you leave it empty, your first message prompts you to choose a model. |
| `opencodePlus.opencode.path` | Empty | Sets the path to the [OpenCode executable](setup.md#how-opencode-plus-finds-opencode). If you leave it empty, OpenCode Plus searches for it. Set it in User or Remote settings, not Workspace settings. |
| `opencodePlus.opencode.askPermissions` | On | Applies [OpenCode Plus's permission rules](features.md#messages-tools-and-permissions) for edits, commands, web requests and access outside the project. Set it in User or Remote settings, not Workspace settings. |
| `opencodePlus.bedrock.profile` | Empty | Sets the [AWS profile for Amazon Bedrock](setup.md#through-opencode-plus-settings). Set it in User or Remote settings, not Workspace settings. |
| `opencodePlus.bedrock.region` | Empty | Sets the [AWS Region for Amazon Bedrock](setup.md#through-opencode-plus-settings). Set it in User or Remote settings, not Workspace settings. |
| `opencodePlus.workPlan` | On | Lets the model keep a work plan when you choose Custom in [Token Mode](features.md#token-mode). |
| `opencodePlus.planBar` | On | Shows the [plan bar](features.md#work-plan-and-plan-bar) above the input box. |
| `opencodePlus.conversationLinks` | On | Turns mentions of other conversations into [links in replies](features.md#links-and-images-in-replies). |
| `opencodePlus.conversationBrief` | On | Lets the model keep a [conversation brief](features.md#conversation-brief) when you choose Custom token mode. |
| `opencodePlus.tellOpenCodeYourTimeZone` | On | In Custom token mode, tells the model [your time zone](setup.md#remote-ssh) when it differs from the OpenCode machine's time zone. |

### When Settings Start OpenCode Again

**Let a running turn finish before you change the OpenCode path, permission rules, Bedrock profile, Region or stored Bedrock API key.** Changing any of them restarts OpenCode, and a turn still running ends with an error. The other settings take effect without a restart.

## Turning Features Off

Agent Plus's [Token Mode](features.md#token-mode) controls what OpenCode Plus adds to the model's context. You can change the plan bar, conversation links, permission rules and chimes in any mode.

| What | How |
|---|---|
| Everything OpenCode Plus adds to the model's context | Choose Interface features as the token mode. |
| Work plan | Choose Custom and turn off `opencodePlus.workPlan`. |
| Conversation brief | Choose Custom and turn off `opencodePlus.conversationBrief`. |
| Time-zone note | Choose Custom and turn off `opencodePlus.tellOpenCodeYourTimeZone`. |
| Note telling the model that the chat page shows images | Choose Interface features. This note has no separate switch. |
| Plan bar | Turn off `opencodePlus.planBar`. |
| Links to other conversations | Turn off `opencodePlus.conversationLinks`. |
| OpenCode Plus's permission rules | Turn off `opencodePlus.opencode.askPermissions` to use your own OpenCode rules. |
| Chimes | Click the note button beside Send. |

## Commands

In the Command Palette, search for `OpenCode Plus:` to find these commands.

| Command | What it does |
|---|---|
| `OpenCode Plus: New Conversation` | Opens a new conversation in an editor tab. |
| `OpenCode Plus: Fork Conversation` | Copies the conversation into a new tab. Available when a chat tab is active. |
| `OpenCode Plus: Find Conversation…` | Finds a conversation by title, session ID or folder. |
| `OpenCode Plus: Clear Recently Closed` | Clears the Recently closed group in the Conversations view. |
| `OpenCode Plus: Choose Model for New Conversations` | Lets you pick the model for new conversations. |
| `OpenCode Plus: Test OpenCode Connection` | Checks whether OpenCode is installed and reports [model counts or Bedrock credential errors](setup.md#checking-the-connection) when available. |
| `OpenCode Plus: Set Amazon Bedrock API Key` | Saves your Bedrock API key in VS Code's secret storage. |
| `OpenCode Plus: Clear Amazon Bedrock API Key` | Removes the stored Bedrock API key. |
| `OpenCode Plus: Download Python for Work Plans` | Downloads Python for the work plan on Windows. |
| `OpenCode Plus: Look for Python Again for Work Plans` | Checks again for a Python installation the work plan can use. |
| `OpenCode Plus: Show MCP Servers` | Runs `opencode mcp list` and shows the result in a VS Code output channel. |

An MCP server provides tools to OpenCode through the Model Context Protocol. To add one, run `opencode mcp add` or edit OpenCode's configuration file.

Rename Conversation and Delete Conversation are menu actions outside the Command Palette. Both are available in [The Conversations List](features.md#the-conversations-list). You can also [rename a conversation from its tab or editor title menu](features.md#chat-tabs-and-windows).
