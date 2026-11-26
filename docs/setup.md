# Setup

Back to the [README](../README.md).

## Installing OpenCode

**Use OpenCode 2.4.1 or later.** If you don't have npm, install [Node.js](https://nodejs.org/), which includes it. To install OpenCode 2, run:

```sh
npm install -g @opencode/cli
```

At the time of writing, `@opencode/cli` provides OpenCode 2.4.1. The installer `curl -fsSL https://opencode.ai/install | bash` installs OpenCode 1, whose npm package is `opencode-ai` (1.19.6). Both packages provide the `opencode` command.

OpenCode Agent Plus was tested only with OpenCode 1.19.6 and 2.4.1.

If the extension can't find OpenCode, it offers to download version 2.4.1 from OpenCode's GitHub releases into `~/.opencode-agent-plus/opencode/2.4.1/` (110 to 126 MB, depending on your platform). Select Download OpenCode in the notification, or run `OpenCode Agent Plus: Download OpenCode 2.4.1`. The download is available only for macOS, Linux and Windows on x64 or arm64.

### What Needs OpenCode 2

You can chat with OpenCode 1, but these features require OpenCode 2:

| Feature | Needs |
| --- | --- |
| Work plan, plan bar, [conversation brief](features.md#conversation-brief) and time-zone note to the model | OpenCode 2 |
| Renaming conversations | OpenCode 2 |
| Rewind | OpenCode 2 |
| Showing subagent progress and keeping subagents' own conversations out of conversation lists | OpenCode 2 |
| Notices while OpenCode retries a request after a provider error | OpenCode 2 |
| Questions from the model as forms | OpenCode 2.4.1 or later. In earlier versions, the tool the model uses to ask a question as a form is off. |

The chat page shows controls for slash commands, image paste, mode and effort only when the running version of OpenCode offers them.

## How OpenCode Agent Plus Finds OpenCode

If you set `opencodeAgentPlus.opencode.path` in your User or Remote settings, OpenCode Agent Plus uses that path. It must point to an executable file. Let any running turn finish before you change the setting, because changing it [restarts OpenCode](settings.md#settings-that-restart-opencode).

With the setting empty, OpenCode Agent Plus searches for `opencode` in the following locations, in order. On Windows, it also looks for `opencode.exe` and `opencode.cmd`.

1. Each folder on `PATH`.
2. Installer folders on all platforms: `~/.opencode/bin`, `~/.local/bin`, `~/.bun/bin`, `~/.npm-global/bin`, `~/.volta/bin`, `~/.local/share/pnpm`.
3. Additional folders for your platform:
   - macOS and Linux: `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`.
   - Windows: `%APPDATA%\npm`, `%LOCALAPPDATA%\opencode\bin`.
4. The OpenCode it downloaded, in `~/.opencode-agent-plus/opencode/2.4.1/`.

A path in the setting that doesn't point to an executable file causes the extension to report an error without falling back to the downloaded copy.

When OpenCode Agent Plus shows installation instructions because it can't find OpenCode, follow them and reload the VS Code window as prompted. After a download from the notification or the command, you don't need to reload.

## When OpenCode Starts, Stops and Updates

When a conversation or Agent Plus's Conversations list first needs OpenCode, the VS Code window starts one process and shares it across its conversations. The window runs `opencode acp`, OpenCode's editor mode, which uses the Agent Client Protocol to communicate with the extension. The process stops after the window has had no conversations open for 10 minutes.

OpenCode Agent Plus turns off automatic updates for the OpenCode process it starts. Otherwise, OpenCode 1 could update itself in the background to OpenCode 2, which uses a different configuration format. To update OpenCode 2, run `npm install -g @opencode/cli@latest`; for OpenCode 1, run `npm install -g opencode-ai@latest`. Then reload the VS Code window. The downloaded copy stays at 2.4.1, so you'll need to install OpenCode yourself to use a later version.

## Installing OpenCode Agent Plus

You need VS Code 1.96 or later. Search for OpenCode Agent Plus in the Extensions view and select Install, or run `code --install-extension xnervwang.opencode-agent-plus`. VS Code also installs Agent Plus, the companion extension that shows your work plan.

### Python for the Work Plan

At startup, OpenCode Agent Plus looks for Python 3.7 or later, which the work plan requires. If it can't find a suitable version, you'll see a message in Agent Plus's Work plan view. In Restricted Mode, OpenCode Agent Plus waits until you trust the workspace before it runs or sets up the work plan. In the Conversations view, select Manage Workspace Trust to open VS Code's workspace trust editor.

On Windows, OpenCode Agent Plus offers to download python.org's embeddable Python 3.12.7 (about 11 MB). You can start the download yourself with `OpenCode Agent Plus: Download Python for Work Plans`. On macOS and Linux, install Python 3.7 or later with your system's package manager or from python.org. OpenCode Agent Plus looks for `python3` and then `python` on `PATH` on those platforms. If you install Python yourself, run `OpenCode Agent Plus: Look for Python Again for Work Plans`.

### Your First Conversation

Open Agent Plus's Conversations list from its Conversations icon in the activity bar. In the New bar at the top of the list, click the agent logo on the left, choose OpenCode Agent Plus from the menu, then click New in tab. You can also use the OpenCode Agent Plus icon in any editor's title bar, or `OpenCode Agent Plus: New Conversation` in the Command Palette. Your conversation opens in an editor tab and starts in the window's first workspace folder. If no folder is open, it starts in your home folder.

Send your first message. If you haven't set a model for new conversations, OpenCode Agent Plus asks you to pick one and saves your choice for later conversations. To change the default, run `OpenCode Agent Plus: Choose Model for New Conversations`.

## Amazon Bedrock

OpenCode connects to Bedrock through the AWS credential chain. Bedrock models appear under the `amazon-bedrock` provider, with IDs such as `amazon-bedrock/us.xai.grok-4.7`.

### Through OpenCode Agent Plus Settings

In the VS Code Settings editor, set your AWS profile and Region under User (Remote in a Remote-SSH window), or use the Command Palette to store a Bedrock API key. OpenCode Agent Plus passes only the values you set, so OpenCode uses its own configuration or environment for any setting you leave empty.

| OpenCode Agent Plus setting or command | Environment variable OpenCode receives |
| --- | --- |
| `opencodeAgentPlus.bedrock.profile` | `AWS_PROFILE` |
| `opencodeAgentPlus.bedrock.region` | `AWS_REGION` |
| `OpenCode Agent Plus: Set Amazon Bedrock API Key` | `AWS_BEARER_TOKEN_BEDROCK` |

OpenCode Agent Plus keeps the API key in VS Code's secret storage on the computer where you see the VS Code window. In a Remote-SSH window, OpenCode Agent Plus runs on the remote machine, reads the key from VS Code, and passes it to OpenCode as `AWS_BEARER_TOKEN_BEDROCK`.

To remove it, run `OpenCode Agent Plus: Clear Amazon Bedrock API Key`. Changing the profile, Region or stored key [restarts OpenCode](settings.md#settings-that-restart-opencode), so let a running turn finish first.

### Through OpenCode's Own Configuration

To use an AWS profile, set its name and Region in `~/.config/opencode/opencode.json`. In the example for your OpenCode version, enter your AWS profile name in place of `<profile>` and your Region if it differs from `us-east-1`.

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

With OpenCode 1 or 2, run `opencode auth login` on the machine where OpenCode runs to sign in to your provider and save its credentials. Follow [OpenCode's provider documentation](https://opencode.ai/docs/providers/) for provider-specific setup. The extension starts OpenCode with your configuration and shows its model list, which includes your provider's models. The extension's profile, Region and API key settings apply only to Amazon Bedrock.

## Checking the Connection

Run `OpenCode Agent Plus: Test OpenCode Connection` from the Command Palette. The test checks only whether OpenCode is installed until you open a conversation in the current window, at which point it can report counts from OpenCode's model list. For example: "OpenCode 2.4.1 is connected: 120 models, 40 of them on Amazon Bedrock." To see model names, open the model list under the input box in any conversation ([Models, Modes and Reply Figures](features.md#models-modes-and-reply-figures)).

OpenCode 1 lists only providers it can sign in to, but OpenCode 2's model list includes Bedrock models even if your credentials do not work. If Bedrock refuses them, you see the error when you send your first message to a Bedrock model. Run the test again to see Bedrock's error. The test result's "How to fix" button lists both ways to set up [Amazon Bedrock](#amazon-bedrock) credentials.

## Remote-SSH

OpenCode Agent Plus is a workspace extension: in a Remote-SSH window, VS Code installs and runs it on the remote machine. OpenCode runs there too, so **install OpenCode and Python there.**

Keep your OpenCode configuration and your AWS profile or provider credentials on the remote machine. If you store a Bedrock API key with `OpenCode Agent Plus: Set Amazon Bedrock API Key`, it stays in VS Code's secret storage on your own computer ([Through OpenCode Agent Plus Settings](#through-opencode-agent-plus-settings)). The files you see in the `@` list and the image files shown in replies come from the remote machine.

The chat page runs on your own computer and reports its time zone. When it differs from the remote machine's time zone, OpenCode Agent Plus can tell the model to use yours for times in its replies.

OpenCode Agent Plus sends the model a note with your time zone once, then repeats it after a compaction, when the date changes on either machine, or when your UTC offset changes. The note requires [OpenCode 2](#what-needs-opencode-2). Whether OpenCode Agent Plus sends the note depends on Agent Plus's [Token Mode](features.md#token-mode), with `opencodeAgentPlus.tellOpenCodeYourTimeZone` deciding this in Custom mode.

If you lose the connection, the old window's extension host (the process that runs extensions for that window) can keep running on the remote machine and hold its conversations open. VS Code stops that process five minutes after a new window connects to the same server. To continue a conversation the old window still holds, see [Chat Tabs and Windows](features.md#chat-tabs-and-windows).
