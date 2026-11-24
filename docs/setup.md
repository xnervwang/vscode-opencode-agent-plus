# Setup

Back to the [README](../README.md).

## Installing OpenCode

**Use OpenCode 2.4.1 or later.** You can install OpenCode 2 with npm, which comes with Node.js. If you don't have npm, install Node.js from [nodejs.org](https://nodejs.org/) first. Then run:

```sh
npm install -g @opencode/cli
```

At the time of writing, `@opencode/cli` provides OpenCode 2.4.1. The installer `curl -fsSL https://opencode.ai/install | bash` installs OpenCode 1, whose npm package is `opencode-ai` (1.19.6). Both packages provide the `opencode` command.

OpenCode Plus was tested with OpenCode 1.19.6 and 2.4.1. Earlier releases of OpenCode 2 were not tested.

### What Needs OpenCode 2

You can chat with OpenCode 1. You need OpenCode 2 for these features:

| Feature | Needs |
| --- | --- |
| Work plan, plan bar, [conversation brief](features.md#conversation-brief) and time-zone note | OpenCode 2 |
| Rename | OpenCode 2 |
| Rewind | OpenCode 2 |
| Showing subagent progress and keeping subagent conversations out of conversation lists | OpenCode 2 |
| Retry notices | OpenCode 2 |
| Questions from the model as forms | OpenCode 2.4.1 or later. In earlier versions, the model's question tool is off. |

The chat page shows controls for slash commands, image paste, mode and effort only when the running version of OpenCode offers them.

## How OpenCode Plus Finds OpenCode

If you set `opencodePlus.opencode.path`, OpenCode Plus uses that path. It must point to an executable file. Let any running turn finish before you change the setting, because changing it restarts OpenCode ([When Settings Start OpenCode Again](settings.md#when-settings-start-opencode-again)).

If you leave the setting empty, OpenCode Plus looks for `opencode` in this order. On Windows, it also looks for `opencode.exe` and `opencode.cmd`.

1. Each folder on `PATH`.
2. Installer folders on all platforms: `~/.opencode/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.local/share/pnpm`.
3. Additional folders for your platform:
   - macOS and Linux: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.
   - Windows: `%APPDATA%\npm`, `%LOCALAPPDATA%\opencode\bin`.

If OpenCode Plus cannot find OpenCode, it shows you how to install it and asks you to reload the VS Code window.

## When OpenCode Starts, Stops and Updates

Each VS Code window starts its own OpenCode process when a conversation or the Conversations view first needs it. Conversations open in that window share the process. The window runs `opencode acp`, OpenCode's editor mode, which uses the Agent Client Protocol to communicate with the extension. The process stops after the window has had no conversations open for 10 minutes.

OpenCode Plus turns off automatic updates for the OpenCode process it starts. Otherwise, OpenCode 1 could update itself in the background to OpenCode 2, which reads a different configuration. When you want to update OpenCode, use npm, then reload the VS Code window.

## Installing OpenCode Plus

You need VS Code 1.96 or later. Search for OpenCode Plus in the Extensions view and select Install, or run `code --install-extension xnervwang.opencode-plus`. VS Code also installs Agent Plus, the companion extension that shows your work plan.

### Python for the Work Plan

The work plan needs Python 3.7 or later. OpenCode Plus looks for Python when it starts. If it can't find a suitable version, you'll see a message in Agent Plus's Work plan view. If VS Code is in Restricted Mode because you haven't trusted the workspace, OpenCode Plus waits until you trust it before setting up the work plan.

On Windows, OpenCode Plus offers to download python.org's embeddable Python 3.12.7 (about 11 MB). You can start the download yourself with `OpenCode Plus: Download Python for Work Plans`. If you install Python yourself, run `OpenCode Plus: Look for Python Again for Work Plans` to repeat the search.

### Your First Conversation

Click the OpenCode Plus icon in the activity bar to open the Conversations view. Select the New Conversation button (`+`), or use the New Conversation link when the list is empty. The conversation opens in an editor tab and starts in the window's first workspace folder. If no folder is open, it starts in your home folder.

Send your first message. If you haven't set a model for new conversations, OpenCode Plus asks you to pick one and saves your choice for later conversations. To change the default, run `OpenCode Plus: Choose Model for New Conversations`.

## Amazon Bedrock

You can give OpenCode Bedrock credentials through OpenCode Plus or configure OpenCode directly. OpenCode connects to Bedrock through the AWS credential chain, the sources AWS checks for credentials in order. Bedrock models appear under the `amazon-bedrock` provider, with IDs such as `amazon-bedrock/us.xai.grok-4.7`.

### Through OpenCode Plus Settings

Set your AWS profile and Region in the VS Code Settings editor, or store a Bedrock API key with the Command Palette. OpenCode Plus passes only the values you set. If you leave a setting empty, OpenCode keeps using the value from its own configuration or environment.

| OpenCode Plus setting or command | Environment variable OpenCode receives |
| --- | --- |
| `opencodePlus.bedrock.profile` | `AWS_PROFILE` |
| `opencodePlus.bedrock.region` | `AWS_REGION` |
| `OpenCode Plus: Set Amazon Bedrock API Key` | `AWS_BEARER_TOKEN_BEDROCK` |

OpenCode Plus keeps the API key in VS Code's secret storage. To remove it, run `OpenCode Plus: Clear Amazon Bedrock API Key`. Changing the profile, Region or stored key restarts OpenCode, so let a running turn finish first ([When Settings Start OpenCode Again](settings.md#when-settings-start-opencode-again)).

### Through OpenCode's Own Configuration

To use an AWS profile, set its name and Region in `~/.config/opencode/opencode.json`. Use the example for your OpenCode version, replace `<profile>` with your AWS profile name, and change `us-east-1` if you use another Region.

OpenCode 2:

```json
{
  "providers": {
    "amazon-bedrock": {
      "settings": {
        "profile": "<profile>",
        "region": "us-east-1"
      }
    }
  }
}
```

OpenCode 1:

```json
{
  "provider": {
    "amazon-bedrock": {
      "options": {
        "profile": "<profile>",
        "region": "us-east-1"
      }
    }
  }
}
```

You can also use the environment VS Code starts with. Set the variables for your credentials, then reload the window:

- AWS profile and Region: `AWS_PROFILE` and `AWS_REGION`
- Bedrock API key: `AWS_BEARER_TOKEN_BEDROCK`
- AWS access keys: `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`

## Other Model Providers

Set up your provider in OpenCode by following [OpenCode's provider documentation](https://opencode.ai/docs/providers/). OpenCode Plus starts OpenCode with your configuration and shows the models OpenCode lists, including your provider's models. The extension's profile, Region and API key settings apply only to Amazon Bedrock.

## Checking the Connection

Run `OpenCode Plus: Test OpenCode Connection` from the Command Palette. Before you open a conversation in the current window, the test can only tell you whether OpenCode is installed. Once you open a conversation, OpenCode lists its models and the test can report their counts. For example: "OpenCode 2.4.1 is connected: 120 models, 40 of them on Amazon Bedrock." To see model names, open the model dropdown in any conversation ([Models, Modes and Reply Figures](features.md#models-modes-and-reply-figures)).

OpenCode 1 lists only providers it can sign in to. OpenCode 2 lists Bedrock models even if your credentials do not work, so **a model count alone does not confirm that Bedrock accepts your credentials.** If Bedrock refuses them, you see the error when you send your first message to a Bedrock model. Run the test again to see the refusal. Its "How to fix" button lists both ways to set up [Amazon Bedrock](#amazon-bedrock) credentials.

## Remote-SSH

OpenCode Plus is a workspace extension: in a Remote-SSH window, VS Code installs and runs it on the remote machine. OpenCode runs there too, so **install OpenCode and Python on the remote machine.** Keep your OpenCode configuration and your AWS profile or provider credentials there. The files you see in the `@` list and the image files shown in replies come from the remote machine.

The chat page runs on your own computer and reports its time zone. If it differs from the remote machine's time zone, OpenCode Plus can tell the model yours so it gives times in your zone. It sends the note once and repeats it after a compaction, when the date changes on either machine, or when your UTC offset changes (for example, when daylight saving time starts or ends or when you connect from a computer in another time zone). The note requires OpenCode 2 ([What Needs OpenCode 2](#what-needs-opencode-2)). Agent Plus's [Token Mode](features.md#token-mode) controls whether the note is sent. In Custom mode, `opencodePlus.tellOpenCodeYourTimeZone` controls it.

If you lose the connection, the old window's extension host (the process that runs extensions for that window) can keep running on the remote machine and hold its conversations open. VS Code stops that process five minutes after a new window connects to the same server. To continue a conversation the old window still holds, see [Chat Tabs and Windows](features.md#chat-tabs-and-windows).
