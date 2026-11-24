# Features

Back to the [README](../README.md).

## Messages, Tools and Permissions

Each conversation opens in a VS Code editor tab whose title follows the conversation's title. As the model replies, you see its text and reasoning stream in. Each tool call appears in its own tool card.

By default, OpenCode asks you before it edits files, runs commands, fetches web pages, or reads or writes files outside the project. OpenCode Plus keeps a separate folder outside the project for each conversation. Under the default rules, OpenCode can write to [the conversation's own folder](#links-and-images-in-replies) without asking.

When OpenCode asks for permission, a permission card offers Allow once, Allow in this project and Deny. If a subagent made the request, the card identifies the subagent. For a file edit, choose View diff to review the proposed changes in VS Code's diff view. While the request is open, you can use the same three permission buttons in the diff's title bar.

The `opencodePlus.opencode.askPermissions` setting applies these defaults in place of the `edit`, `bash`, `webfetch` and `external_directory` rules in your OpenCode configuration. Turn it off to keep your own rules. Let any running turn finish before changing the setting because the change restarts OpenCode ([When Settings Start OpenCode Again](settings.md#when-settings-start-opencode-again)).

On [OpenCode 2.4.1 or later](setup.md#what-needs-opencode-2), questions from the model appear in a form. A question can offer a single choice with a box for your own answer, allow multiple choices, or ask for yes or no, a number, or text. The conversation shows that it is waiting for your answer. Submit sends your answer. Cancel ends the turn; you cannot skip a single question.

## Writing a Message

Type `/` at the start of the input box to list OpenCode's commands, such as `/compact`. Use the arrow keys to highlight a command, then press Enter or Tab to complete its name. Send the message as usual.

Type `@` at the start of the message or after a space to find a workspace file. The list shows up to 50 matches and skips `node_modules`, `.git` and files hidden by `files.exclude` or `search.exclude`. Choosing a file inserts `@<relative path>` into your message. Leave it in the text to send the file reference. Use `@` for files in the VS Code Explorer; dragging them from the Explorer does not attach them.

To include selected text, select it in the editor and click the button beside the input box, such as `+ extension.js:12-20`. Your message includes the text of the selection.

You can paste images into the input box or drop image files onto it. Each message can include up to 8 images of up to 5 MB each. Before you send, you see a thumbnail for each image. The sent message shows an "Image" label in its place.

If you send a message while a turn is running, it waits in a "Queued" row until the turn ends, then sends. Click Stop to end the turn. You can also press Esc while the chat page has focus. If a list or box is open, Esc closes it first.

## Models, Modes and Reply Figures

At the top of the chat page, you can choose from every model OpenCode offers. The model dropdown groups them by provider. The Mode (build or plan) and Effort dropdowns appear when OpenCode offers them for the model you choose. OpenCode remembers your mode and effort for each conversation. Changes to the model, mode or effort take effect with your next message, even if you make them during a turn.

Each reply ends with a line such as `2m10s · ctx 33% · $0.42 · grok-4.7 low`. It shows how long the turn took, the percentage of the context window in use, the cost OpenCode reports for the conversation so far, and the model and effort used for that reply. Hover over the line to see the same values with labels.

## Context, Compaction and Retries

The context ring at the top of the chat page shows how much of the model's context window your conversation uses. An outline appears around the ring when 15% or less of the window remains.

When OpenCode summarizes older turns to make room, a divider in the conversation reads "Compacting the conversation…". When it finishes, the divider reads "Conversation compacted". Expand "Summary" to read the summary. You can start compaction by typing `/compact`.

If OpenCode 2 is waiting to retry a request after a provider error, the status line shows the attempt number and the time until the retry, for example "Retrying, attempt 2 in 2s", followed by the error.

## Getting Around a Long Conversation

### Outline

Click Outline to open the "Your messages" column beside the conversation. It lists your messages by number and first line and marks where OpenCode compacted the conversation. Hover over a message row to see its time and full text. Click any row to scroll to that point. The column is open by default when the page is at least 760 pixels wide.

### Subagents Filter

Click Subagents to hide the subagents' cards and tool calls. This also hides the progress box under the call that started each subagent. Requests from subagents stay visible while they wait for you. The button then reads "Subagents hidden (n)".

### Session Information

Click the "i" button beside the context ring to see the session ID and folder. The box also shows the OpenCode version, the process ID of `opencode acp`, the location of OpenCode's session database and Agent Plus's [token mode](#token-mode). Click a row to copy it, or choose Copy all to copy every row.

### Chimes

Chimes play on the computer showing the chat page. You hear two rising notes when a turn ends, three notes when OpenCode asks for permission and two falling notes when the model asks a question. Click the musical note button beside Send to mute chimes on all chat pages.

## Links and Images in Replies

When a reply mentions one of your other conversations, its session ID or its title in corner brackets (「title」) becomes a link. A title without brackets also becomes a link if it's long enough. With Agent Plus, replies can also link to your Claude Code and Codex conversations. OpenCode Plus skips code blocks and existing links. To turn off conversation links, disable `opencodePlus.conversationLinks`.

Hover over a conversation link to see which agent it belongs to, part of its session ID and when it was last active. Click to open the conversation in this window. If another window already has it open, Agent Plus brings that window forward. A conversation from another agent opens in that agent.

Replies can display PNG, JPEG, GIF, WebP and SVG images up to 8 MB in any mode. An image appears in the reply when the model gives its absolute path, a `file://` address or a `data:` address. Relative paths and web addresses stay as links. OpenCode Plus does not fetch images from web addresses.

On OpenCode 2, unless your [Token Mode](#token-mode) is Interface features, OpenCode Plus tells the model that replies can display images and asks it to save each image in the conversation's own folder and give its absolute path. The folder is `~/.opencode-plus/scratch/<session id>/` on the machine where OpenCode runs. Deleting the conversation also removes this folder; see [The Conversations List](#the-conversations-list).

## Rewinding and Forking

### Rewinding

On OpenCode 2, you can rewind an idle conversation to just before one of your messages. **In a Git repository, OpenCode restores files before you confirm.** Outside a Git repository, rewinding changes only the conversation. OpenCode Plus marks Rewind to here as experimental because OpenCode marks the interface it uses as experimental.

1. Hover over one of your messages and choose Rewind to here. In a Git repository, OpenCode immediately undoes the file changes made after that message.
2. Review the dialog. It lists the files OpenCode removed, changed back or restored, with counts of lines added and removed. If the window closes while the dialog is open, see [Rewinding](known-limits.md#rewinding) in Known Limits.
3. Choose Rewind to delete the selected message and all later messages and put the selected message's text back in the input box. Choose Cancel to leave the conversation intact and put the files back as they were before you started the rewind.

### Forking

On OpenCode 1 and 2, you can copy the whole conversation into a new conversation that opens in a new tab. You cannot fork from a specific message.

Choose Fork Conversation from the context menu in the Conversations view, on the chat tab or on the chat page. You can also use the editor title's `...` menu or run `OpenCode Plus: Fork Conversation` from the Command Palette with the chat tab active.

## Subagents and Background Work

While a subagent or a shell command the model moved to the background is running, a row above the input box shows a count such as "Background: 1 subagent, 1 command running". Expand the row to see each item's kind, command or title, process ID and start time. Click an item to scroll to its card. OpenCode Plus checks whether a background command is still running only when a turn starts or ends or when you open the row.

On OpenCode 2, a Subagent box below the tool card that started the subagent shows its title, status and latest output. Expand "Its steps (n)" to see the last 60 entries, including tool calls and text. Subagent conversations stay out of the Conversations view, `OpenCode Plus: Find Conversation…` and Agent Plus. On OpenCode 1, OpenCode Plus does not distinguish subagent conversations from other conversations.

When a subagent or background command finishes, OpenCode may start a turn on its own. The page shows a separate turn with the line "OpenCode went on without a message from you, for a background task (a subagent or a command)." The conversation shows as working during the turn, and the reply counts as unread if you are not viewing the conversation. The turn's cost appears with OpenCode's next usage report.

## The Conversations List

Click the OpenCode Plus icon in the activity bar to open the Conversations view. It lists OpenCode conversations whose folders are within this window's workspace folders. If you have no folder open, it lists all OpenCode conversations.

The view groups conversations under Recently closed, Open in this window, and Other conversations. Recently closed shows up to 10 conversations whose tabs you closed in this workspace and has a button to clear the group. If Recently closed is empty and all conversations belong to just one of the other groups, the view shows a flat list.

Each row shows the conversation's state and how long ago it was active. Hover over a row to see its state, folder, session ID and last active time, such as "5m ago (11/24/2026, 8:08:35 AM UTC)". The timestamp includes the time zone name and uses the zone of the machine running OpenCode, which can differ from yours over Remote-SSH.

The view's title bar has `OpenCode Plus: New Conversation` and `OpenCode Plus: Find Conversation…`. Use Find Conversation to search all OpenCode conversations across folders, most recent first. You can enter part of a title, session ID or folder.

Right-click a row for `OpenCode Plus: Rename Conversation` (OpenCode 2), `OpenCode Plus: Fork Conversation` (see [Forking](#forking)) or `OpenCode Plus: Delete Conversation`. Deleting a conversation closes its tabs, deletes it in OpenCode and removes its work plan and its own folder. If another window has the conversation open, OpenCode Plus refuses to delete it.

## Chat Tabs and Windows

Each chat tab shows the OpenCode Plus icon from the activity bar. A green dot means the conversation is working. A red dot means it needs your permission or an answer, and no dot means it is idle. The icon has no separate state for background work running on its own. If a background tab has an unread reply, an envelope appears after its title and disappears when you view the tab.

On OpenCode 2, you can choose `OpenCode Plus: Rename Conversation` from the tab's context menu or the `...` menu in the editor title bar. For `OpenCode Plus: Fork Conversation`, see [Forking](#forking). Closing a conversation's last tab stops its running turn. Open tabs return when you reload the window.

A conversation can be open in only one VS Code window at a time. If you open it in a second window, choose "Take over here" in the notification. The first window stops any running turn and closes the conversation. If it hasn't released the conversation within 10 seconds, you can choose "Take over anyway". If you reload the first window, it takes the conversation back without asking.

## Work Plan and Plan Bar

On OpenCode 2, when OpenCode Plus finds Python, it installs a work plan plugin for the OpenCode process it starts. The plugin lets the model keep a plan of the open work in your conversation. Agent Plus shows the plan in its Work plan view. Its Conversations view lists your OpenCode Plus conversations and shows whether each is working, waiting or idle. For Python setup, see [Installing OpenCode Plus](setup.md#installing-opencode-plus).

The plan bar above the input box (`opencodePlus.planBar`) shows the plan's open rows, the current row and a red count of questions waiting for your answer. Click the bar to open the Work plan view. Click the red count to open Agent Plus's Answer view for those questions.

When the [Token Mode](#token-mode) enables work plans, each message includes the open rows, and the model gets tools to update the plan (`add_row`, `set_row`, `set_status`, `set_summary`). Reminders to update the plan arrive with the next message. During compaction, the work plan plugin asks the model to include the plan's location and open rows in the summary. The next message asks the model to read the plan first.

OpenCode Plus stores plans in `~/.opencode-plus/plans/` on the machine where OpenCode runs. Deleting a conversation also removes its plan (see [The Conversations List](#the-conversations-list)).

On OpenCode 1, Agent Plus shows "Work plans need OpenCode 2" above the plan. Click the message to open the OpenCode path setting.

## Conversation Brief

On OpenCode 2, the model keeps a conversation brief in each conversation's work plan: a short summary and the current status. The model keeps the brief when you set [Token Mode](#token-mode) to All features, or to Custom with `opencodePlus.conversationBrief` on. To see the brief, click the conversation in Agent Plus's Conversations view.

## Token Mode

Agent Plus's token mode (`agentPlus.tokenMode`) controls which additions OpenCode sends to the model. You can change the mode from Agent Plus's status bar entry. **The change takes effect with your next message without restarting OpenCode.**

Choose Interface features to add nothing to the model's context. The chat page, plan bar, links and chimes in VS Code send nothing to the model in any mode.

| Addition | Interface features | Essential features | All features (default) | Custom |
|---|---|---|---|---|
| Work plan | off | on | on | `opencodePlus.workPlan` |
| Time-zone note | off | on | on | `opencodePlus.tellOpenCodeYourTimeZone` |
| Note that the page shows images | off | on | on | on |
| Conversation brief | off | off | on | `opencodePlus.conversationBrief` |

The settings in the Custom column apply only in Custom mode. If you switch to another mode, it uses its own on/off values and keeps your settings for the next time you choose Custom.
