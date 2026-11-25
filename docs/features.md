# Features

Back to the [README](../README.md).

## Messages, Tools and Permissions

Each conversation opens in a VS Code editor tab that shows the conversation's title and updates when the title changes. As the model replies, you see its text and reasoning stream in. Each tool call appears in its own tool card.

### Permission Prompts

By default, OpenCode asks you before it edits files, runs commands, fetches web pages, or reads or writes files outside the project. OpenCode Agent Plus keeps a separate folder outside the project for each conversation. Under the default rules, OpenCode can write to [the conversation's own folder](#links-and-images-in-replies) without asking.

When OpenCode asks for permission, a permission card offers Allow once, Allow in this project and Deny. If you choose Allow in this project, OpenCode saves the pattern the request names, such as a command or file path. It then allows matching requests without asking in any conversation in this project, even after OpenCode restarts. If the request names no pattern, your choice allows only that request.

If a subagent made the request, the card identifies the subagent. For a file edit, choose View diff to review the proposed changes in VS Code's diff view. While the request is open, you can use the same three permission buttons in the diff's title bar.

The `opencodeAgentPlus.opencode.askPermissions` setting applies these defaults in place of the `edit`, `bash` (`shell` on OpenCode 2), `webfetch` and `external_directory` rules in your OpenCode configuration. Turn it off to keep your own rules. Let any running turn finish before changing the setting because the change [restarts OpenCode](settings.md#settings-that-restart-opencode).

### Questions from the Model

On [OpenCode 2.4.1 or later](setup.md#what-needs-opencode-2), questions from the model appear in a form. For a single-choice question, you can pick an option or type your own answer in the box. Other questions let you choose multiple options or ask for a yes/no answer, a number, or text. The conversation shows that it is waiting for your answer. Cancel ends the turn; you cannot skip a single question.

## Writing a Message

Type `/` at the start of the input box to list OpenCode's commands, such as `/compact`, which summarizes older turns. Use the arrow keys to highlight a command, then press Enter or Tab to complete its name.

You can search for a workspace file by typing `@` at the start of your message or after a space. The list shows up to 50 matches and skips `node_modules`, `.git` and files hidden by `files.exclude` or `search.exclude`. Choosing a file inserts `@<relative path>`, its path within the workspace, into your message. Leave it in the text to send the file reference. Use `@` for files in the VS Code Explorer; dragging them from the Explorer does not attach them.

Select text in the editor, then add it to your message by clicking the button beside the input box, such as `+ extension.js:12-20`.

You can paste images into the input box or drop image files onto it. You can include up to 8 images per message, with a 5 MB limit per image. Before you send, you see a thumbnail for each image. In the sent message, each image appears as an "Image" label.

If you send a message while a turn is running, it waits in a "Queued" row until the turn ends, then sends. Click Stop to end the turn. You can also press Esc while the chat page has focus. If a list or box is open, Esc closes it first.

## Models, Modes and the Line Under Each Reply

At the top of the chat page, you can choose from every model OpenCode offers. The model dropdown groups them by provider. The Mode (build or plan) and Effort (how much the model reasons) dropdowns appear when OpenCode offers them for the model you choose. OpenCode remembers your mode and effort for each conversation. Changes to the model, mode or effort take effect with your next message, even if you make them during a turn.

Each reply ends with a line such as `2m10s · ctx 33% · $0.42 · grok-4.7 low`. The duration, model and effort are for that reply. The percentage shows how much of the context window is in use, and the cost is the total OpenCode reports for the conversation so far. Hover over the line to see the same values with labels.

## Context, Compaction and Retries

The context ring at the top of the chat page shows how much of the model's context window your conversation uses. An outline appears around the ring when 15% or less of the window remains.

A divider in the conversation reads "Compacting the conversation…" while OpenCode summarizes older turns to make room. It changes to "Conversation compacted" once the summary is ready. Expand "Summary" to see how OpenCode summarized the earlier turns. You can start compaction by typing `/compact`.

If OpenCode 2 is waiting to retry a request after a provider error, the status line shows the attempt number and the time until the retry, for example "Retrying, attempt 2 in 2s", followed by the error.

## Getting Around a Long Conversation

### Outline

Click Outline to open the "Your messages" column beside the conversation. It lists your messages by number and first line and marks where OpenCode compacted the conversation. When you hover over a message row, you see its time and full text. Click any row to scroll to that point. The column is open by default when the page is at least 760 pixels wide.

### Subagents Filter

You can hide cards and tool calls from subagents with the Subagents button. This also hides the [Subagent box](#subagents-and-background-work) under the call that started each subagent. Requests from subagents stay visible while they wait for you. The button then reads "Subagents hidden (n)", where n counts the subagent cards it hides or collapses.

### Session Information

Click the "i" button beside the context ring to see the session ID and folder. The box also shows the OpenCode version, the process ID of `opencode acp`, the location of OpenCode's session database and Agent Plus's [token mode](#token-mode). Click a row to copy it, or choose Copy all.

### Chimes

Chimes play on the computer showing the chat page. You hear two rising notes when a turn ends, three notes when OpenCode asks for permission and two falling notes when the model asks a question. The musical note button beside Send mutes chimes on all chat pages.

## Links and Images in Replies

When a reply mentions one of your other conversations, its session ID or its title in corner brackets (「title」) becomes a link. A title without corner brackets becomes a link if it is at least 10 characters wide, counting each Chinese, Japanese or Korean character as two. With Agent Plus, replies can also link to your Claude Code and Codex conversations. OpenCode Agent Plus skips code blocks and existing links. To turn off conversation links, disable `opencodeAgentPlus.conversationLinks`.

Hover over a conversation link to see which agent it belongs to, part of its session ID and when it was last active. Click to open the conversation in this window. If another window already has it open, Agent Plus brings that window forward. Links to Claude Code or Codex conversations open in the corresponding extension.

Replies can display PNG, JPEG, GIF, WebP and SVG images up to 8 MB in any token mode. An image appears in the reply when the model gives its absolute path, a `file://` address or a `data:` address. Relative paths and web addresses stay as links, and OpenCode Agent Plus does not fetch images from the web.

On OpenCode 2, OpenCode Agent Plus tells the model that replies can display images unless you choose Interface features for [Token Mode](#token-mode). When it sends that note, it also asks the model to save each image in the conversation's own folder and include its absolute path in the reply. The folder is `~/.opencode-agent-plus/scratch/<session id>/` on the machine where OpenCode runs. Deleting the conversation also removes this folder; see [The Conversations List](#the-conversations-list).

## Rewinding and Forking

### Rewinding

On OpenCode 2, you can rewind an idle conversation to just before one of your messages. **In a Git repository, OpenCode restores files before you confirm.** Outside one, rewinding changes only the conversation.

1. Hover over one of your messages and choose Rewind to here.
2. Review the dialog. It lists the files OpenCode removed, changed back or restored, with counts of lines added and removed. If the window closes while the dialog is open, see [Rewinding](known-limits.md#rewinding) in Known Limits.
3. Choose Rewind to put the selected message's text back in the input box and remove that message and all later ones from the conversation. If you cancel, the conversation stays intact and OpenCode restores the files to their state before the rewind.

### Forking

Forking in OpenCode 1 and 2 creates a copy of the whole conversation and opens it in a new tab; you cannot fork from a specific message.

Choose Fork Conversation from the context menu in the Conversations view, on the chat tab or on the chat page. You can also use the editor title's `...` menu or run `OpenCode Agent Plus: Fork Conversation` from the Command Palette with the chat tab active.

## Subagents and Background Work

A row above the input box counts running subagents and any shell commands still running in the background. For example, you might see "Background: 1 subagent, 1 command running". Expand the row to see each item's kind, command or title, process ID and start time. Click an item to scroll to its card. OpenCode Agent Plus checks whether a background command is still running only when a turn starts or ends or when you open the row.

In OpenCode 2, look below the tool card that started a subagent. The Subagent box there shows its title, status and latest output. Expand "Its steps (n)", where n counts all of the subagent's steps, to see the last 60 entries, including tool calls and text. Subagent conversations stay out of the Conversations view, `OpenCode Agent Plus: Find Conversation…` and Agent Plus. On OpenCode 1, OpenCode Agent Plus does not distinguish subagent conversations from other conversations.

A subagent or background command finishing can trigger a new turn. The page shows a separate turn with the line "OpenCode started this turn on its own, for a background subagent or command." During the turn, the conversation appears as working. If you aren't viewing it when the reply arrives, the reply counts as unread. The turn's cost is still unknown when it ends; the next time OpenCode reports usage, that cost is added to the conversation cost you see in the line under each reply.

## The Conversations List

Click the OpenCode Agent Plus icon in the activity bar to open the Conversations view. It lists OpenCode conversations in any of the workspace folders open in this window. With no folder open, you see conversations from all folders.

The view groups conversations under Recently closed, Open in this window, and Other conversations. Recently closed lists up to 10 conversations whose tabs you closed in this workspace. You see a flat list when Recently closed is empty and the conversations all fall into the same remaining group.

Each row shows the conversation's state and how long ago it was active. Hover over a row for the same details plus the folder, session ID and exact time of the last activity, such as "5m ago (11/24/2026, 8:08:35 AM UTC)". The timestamp includes the time zone name and uses the zone of the machine running OpenCode, which can differ from yours over Remote-SSH.

The view's title bar has `OpenCode Agent Plus: New Conversation` and `OpenCode Agent Plus: Find Conversation…`. Every editor's title bar also has the OpenCode mark, which starts a new conversation. Use Find Conversation to search all OpenCode conversations across folders, most recent first. You can enter part of a title, session ID or folder.

Right-click a row for `OpenCode Agent Plus: Rename Conversation` (OpenCode 2), `OpenCode Agent Plus: Fork Conversation` (see [Forking](#forking)) or `OpenCode Agent Plus: Delete Conversation`. Delete Conversation closes the conversation's tabs, removes it from OpenCode, and deletes its work plan and its own folder. If another window has the conversation open, OpenCode Agent Plus refuses to delete it.

## Chat Tabs and Windows

Each chat tab shows the OpenCode Agent Plus icon from the activity bar. The icon has a green dot while the conversation is working, a red dot while it waits for your permission or an answer, and no dot when it is idle. Background work has no dot of its own. If a background tab has an unread reply, an envelope appears after its title and disappears when you view the tab.

On OpenCode 2, you can choose `OpenCode Agent Plus: Rename Conversation` from the tab's context menu or the `...` menu in the editor title bar. For `OpenCode Agent Plus: Fork Conversation`, see [Forking](#forking).

When you close a conversation's last tab, any running turn stops. Tabs you leave open return when you reload the window.

A conversation can be open in only one VS Code window at a time. If you open it in a second window, choose "Take over here" in the notification. The first window stops any running turn and closes the conversation. If it hasn't released the conversation within 10 seconds, you can choose "Take over anyway". Reloading the first window takes the conversation back without asking.

## Work Plan and Plan Bar

If OpenCode Agent Plus finds [Python](setup.md#python-for-the-work-plan), it installs a work plan plugin for the OpenCode 2 process it starts. The plugin lets the model track what still needs to be done in your conversation. In Agent Plus, you can read the plan in the Work plan view and see which of your OpenCode Agent Plus conversations are working, waiting or idle in the Conversations view.

The plan bar above the input box (`opencodeAgentPlus.planBar`) shows the plan's open rows, the current row and a red count of questions waiting for your answer. Click the bar to open the Work plan view, or click the red count to go to those questions in Agent Plus's Answer view.

When the [Token Mode](#token-mode) enables work plans, each message includes the open rows, and the model gets tools to update the plan (`add_row`, `set_row`, `set_status`, `set_summary`). Reminders to update the plan arrive with the next message. During compaction, the work plan plugin asks the model to include the plan's location and open rows in the summary. If any rows remain open after compaction, the next message instructs the model to read the plan before continuing.

OpenCode Agent Plus stores plans in `~/.opencode-agent-plus/plans/` on the machine where OpenCode runs. Deleting a conversation also removes its plan (see [The Conversations List](#the-conversations-list)).

On OpenCode 1, Agent Plus shows "Work plans need OpenCode 2" above the plan. Click the message to open the OpenCode path setting.

## Conversation Brief

On OpenCode 2, the model keeps a brief in each conversation's work plan with a short summary and the current status. This happens when you set [Token Mode](#token-mode) to All features (the default), or choose Custom and turn on `opencodeAgentPlus.conversationBrief`. The brief appears when you click the conversation in Agent Plus's Conversations view.

## Token Mode

Agent Plus's token mode (`agentPlus.tokenMode`) controls which additions OpenCode sends to the model. To change the mode, click the Agent Plus entry in the status bar. **The change takes effect with your next message without restarting OpenCode.**

Choose Interface features to leave the model's context unchanged. In all modes, the chat page, plan bar, links and chimes work in VS Code without sending anything to the model.

| Addition | Interface features | Essential features | All features (default) | Custom |
|---|---|---|---|---|
| Work plan | off | on | on | `opencodeAgentPlus.workPlan` |
| Time-zone note | off | on | on | `opencodeAgentPlus.tellOpenCodeYourTimeZone` |
| Note that the page shows images | off | on | on | on |
| Conversation brief | off | off | on | `opencodeAgentPlus.conversationBrief` |

When you switch away from Custom, the new mode uses its own on/off values and your Custom settings stay saved for when you switch back.
