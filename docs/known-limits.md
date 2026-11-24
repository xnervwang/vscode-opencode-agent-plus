# Known Limits

Back to the [README](../README.md).

## Features That Need OpenCode 2

You can chat with OpenCode 1, but you need OpenCode 2 for the features in the table under [What Needs OpenCode 2](setup.md#what-needs-opencode-2).

## What a Reopened Conversation Does Not Show

When you reopen a conversation from OpenCode's history, you see your messages, replies, tool cards and message times again, but some details differ from what you saw during a live turn.

- The figures under older replies omit the effort.
- On OpenCode 2, permission cards you already answered do not reappear.
- For a subagent, you see only the tool's result, without the progress box.
- If OpenCode started a turn on its own, it appears as part of the previous turn. That turn's duration includes the wait for the background task.
- Message times come from OpenCode's export of the conversation. If the export fails or takes longer than 5 seconds, each message shows the time you reopened the conversation.

## Rewinding

Your files change before you confirm the rewind, as described in [Rewinding and Forking](features.md#rewinding-and-forking).

- If the window closes while the confirmation dialog is open, the rewind stays staged in OpenCode. What OpenCode does with the staged rewind later has not been tested.
- Rewind uses an interface that OpenCode marks as experimental, so it may stop working after an OpenCode update.

## Windows and Connections

If a [Remote-SSH](setup.md#remote-ssh) window loses its connection, it can keep your conversation open until you [take it over in another window](features.md#chat-tabs-and-windows) or VS Code stops the old window.

Changing the [OpenCode or Bedrock settings](settings.md#when-settings-start-opencode-again) during a turn ends that turn with an error.
