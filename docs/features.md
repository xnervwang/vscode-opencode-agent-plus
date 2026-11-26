# Features

Back to the [README](../README.md).

## Messages, Tools and Permissions

Each conversation opens in a VS Code editor tab whose label follows its current title. As the model replies, you see its text and reasoning stream in. Each tool call the model makes has its own row in the conversation, with the tool's name in bold followed by the arguments it received. Click the row to open a box with the tool's input (IN) and output (OUT). If the call fails, the box opens automatically.

Code blocks in replies use the colours of your current VS Code theme, light or dark, when the opening fence names a language, as in `` ```js `` or `` ```python ``. A block without a language stays plain text because language guessing can misidentify logs and command output. The model's thinking appears as one grey row labelled "Thinking". Click it to read the reasoning, then click it again to fold it.

### Edits in the Conversation

Edit and patch rows show how many lines were added and removed, such as "+3 -1"; a write row shows the total number of lines written. Expanding the row shows the change in place of the tool's input: removed lines have a red background and a "-" mark, while added lines have a green background and a "+" mark.

When OpenCode asks permission for an edit, the row compares the whole file before and after the edit, with line numbers and a few unchanged lines around each change; longer unchanged stretches fold into one line each, showing how many lines they contain. A long change shows its first 160 rows and the number of lines left out; you can still click "View diff" on a permission request to open the change in VS Code's diff view.

### Todo List

OpenCode 1 has no todo list tool; in OpenCode 2, the model can keep a todo list with `todowrite`, an experimental tool that stays off unless the `OPENCODE_FLAGS` environment variable includes `todo`. OpenCode Agent Plus adds `todo` to `OPENCODE_FLAGS` for the OpenCode it starts and keeps any other flags you set there.

The `todowrite` row starts open with one item per line: a filled blue circle marks the bold item in progress, and strikethrough marks both done and cancelled items, with a tick for done items and faded text for cancelled ones. To turn off the tool, turn off `opencodeAgentPlus.todoList`, which restarts OpenCode.

### Permission Prompts

By default, OpenCode asks you before it edits files, runs commands, fetches web pages, or reads or writes files outside the project. OpenCode Agent Plus keeps a separate folder outside the project for each conversation. Under the default rules, OpenCode can write to [the conversation's own folder](#links-and-images-in-replies) without asking.

When OpenCode asks for permission, a framed box just above the input box shows three rows: 1 Allow once, 2 Allow in this project and 3 Deny. When the input box does not have focus, you can press 1, 2 or 3 to answer. The request then appears as a single row in the conversation showing your choice.

If you choose Allow in this project, OpenCode saves the pattern the request names, such as a command or file path. It then allows matching requests without asking in any conversation in this project, even after OpenCode restarts. If the request names no pattern, your choice allows only that request.

A permission request from a [subagent](#subagents-and-background-work) includes the subagent's name. For a file edit, choose View diff to review the proposed changes in VS Code's diff view. While the request is open, you can use the same three permission buttons in the diff's title bar.

The `opencodeAgentPlus.opencode.askPermissions` setting applies these defaults in place of the `edit`, `bash` (`shell` on OpenCode 2), `webfetch` and `external_directory` rules in your OpenCode configuration. Turn it off to keep your own rules. Let any running turn finish before changing the setting because the change [restarts OpenCode](settings.md#settings-that-restart-opencode).

### Questions from the Model

On [OpenCode 2.4.1 or later](setup.md#what-needs-opencode-2), questions from the model appear in a form. For a single-choice question, you can pick an option or type your own answer in the box. Other questions let you choose multiple options or ask for a yes/no answer, a number, or text. The conversation shows that it is waiting for your answer. Cancel ends the turn; you cannot skip a single question.

## Writing a Message

Type `/` at the start of the input box to list OpenCode's commands, such as `/compact`, which summarizes older turns. Use the arrow keys to highlight a command, then press Enter or Tab to complete its name.

You can search for a workspace file by typing `@` at the start of your message or after a space. The list shows up to 50 matches and skips `node_modules`, `.git` and files hidden by `files.exclude` or `search.exclude`. Choosing a file inserts `@<relative path>`, its path within the workspace, into your message. Leave it in the text to send the file reference. Use `@` for files in the VS Code Explorer; dragging them from the Explorer does not attach them.

### Files and Selections from the Editor

By default, your message includes the lines you select in the editor (`opencodeAgentPlus.attachSelection`) or, if you select nothing, the file in the editor you used last (`opencodeAgentPlus.attachOpenFile`). A pill (a small rounded button) in the row below the input box shows the file name or the file and line range, such as `extension.js:12-20`. It is highlighted while that file or selection goes with your message; click its × to leave it out of this message only. To keep the current selection with the message even after you select other lines, click the pill.

In an editor, press Alt+K to insert a reference into the input box of the frontmost chat tab (the one you used last); it points to the current file or, if you selected lines, to that range (for example, `@<path>#L12-20`). Add to Conversation inserts the same kind of reference from the editor's context menu or from the Explorer's context menu for one or more files.

From the editor, press Cmd+Esc on macOS, the Windows key with Esc on Windows, or Super+Esc on Linux to focus the frontmost chat tab's input box. If no chat tab is open, the shortcut opens a new conversation. In a chat tab, the same shortcut takes you back to the editor.

When the editor reports an error or warning, you can choose Fix with OpenCode Agent Plus (`opencodeAgentPlus.showFixActions`) from its quick fixes. It appends the file, line and problem to any text in the frontmost chat tab's input box so you can review the draft before sending it.

### Images, Sending and Queuing

Paste images into the input box, drop image files onto it, or use its + button to choose files. A message can contain up to 8 images of up to 5 MB each, even if you leave the text empty. Before you send, you see a thumbnail for each image. In the sent message, each image appears as an "Image" label.

With `opencodeAgentPlus.useCtrlEnterToSend` on, Enter starts a new line and Ctrl+Enter (Cmd+Enter on macOS) sends.

If you send a message while a turn is running, it waits in a "Queued" row until the turn ends, then sends. Click Stop to end the turn. You can also press Esc while the chat page has focus. If a list or box is open, Esc closes it first.

## Models, Modes and Reply Figures

In the row of buttons under the input box, one pill shows the model followed by the effort in grey. Click the model to open a drop-down list of the models OpenCode offers, grouped by provider. The Effort drop-down lets you choose how much the model reasons. Effort appears only when OpenCode offers it for the model you choose.

Before you connect a provider, OpenCode offers only its own free models, listed as "OpenCode's free models", and shows Connect a provider… at the top of the model list. Once you connect a provider, Connect a provider… appears among the last entries in the model list; whenever you select it, it runs OpenCode's sign-in command, `opencode auth login`, in a VS Code terminal. Over Remote-SSH, the terminal runs on the remote machine and saves your credentials there; when you close the terminal, OpenCode restarts and the chat tabs refresh their model lists.

By default (`opencodeAgentPlus.openCodeModels` set to `auto`), the list shows OpenCode's free models (which run on opencode.ai) until you connect another provider; `show` always lists them, and `hide` leaves them out even before you connect another provider, but with either `auto` or `hide`, a free model your conversation already uses stays in that conversation's model list.

### Modes and Model Changes

Use the mode pill near the right end of the row below the input box to choose Ask before edits, Edit automatically or Plan; in Plan mode, OpenCode explores your project and plans changes without editing project files. With Edit automatically, OpenCode can edit files inside the project folder the conversation works in (shown under [Session Information](#session-information)) without asking, but it still asks before running commands, making web requests or accessing paths outside that folder. Each conversation keeps the mode and effort you chose in it, even after you close and reopen its tab.

If you switch to a model that does not support your chosen effort, it uses its default effort. When you switch back to a model that supports your choice, OpenCode Agent Plus restores it. Changes to the model, mode or effort take effect with your next message, even if you make them during a turn.

### Reply Figures

The last row of text in each reply starts with the time it arrived, followed by figures such as `2m10s · ctx 33% · $0.42 · grok-4.7 (US) low`. If the turn ends with something other than text, the figures appear on their own line. The duration, model and effort are for that reply. A Bedrock model's name ends with the geography of its ID, such as (US) or (India), as in the model list. The percentage shows how much of the context window is in use, and the cost is the total OpenCode reports for the conversation so far. Hover over the figures to see the same values with labels.

## Context, Compaction and Retries

The context ring under the input box shows how much of the model's context window your conversation uses. An outline appears around the ring when 15% or less of the window remains.

A divider in the conversation reads "Compacting the conversation…" while OpenCode summarizes older turns to make room. It changes to "Conversation compacted" once the summary is ready. Expand "Summary" to see how OpenCode summarized the earlier turns. You can start compaction by typing `/compact`.

If OpenCode 2 is waiting to retry a request after a provider error, the status line shows the attempt number and the time until the retry, for example "Retrying, attempt 2 in 2s", followed by the error.

## Getting Around a Long Conversation

### Outline

Five small buttons sit on the right edge of the conversation. From top to bottom, the buttons let you jump to the first or previous message, open the list of your messages, jump to the next message or scroll to the end of the conversation.

The list opens over the conversation; type in the box at the top marked "Filter your messages" to show only your messages that contain the words you enter. Each row shows the time and first line of one of your messages. The list also marks where OpenCode compacted the conversation. Hover over a row to read the full message, or click it to scroll there. The list starts closed, but if you leave it open, the page reopens it next time.

### Subagents Filter

Use the Subagents button under the input box to hide subagent activity, including tool calls. This also hides the [Subagent box](#subagents-and-background-work) under the call that started each subagent. Requests from subagents stay visible while they wait for you. The button then reads "Subagents hidden (n)", where n is the number of subagent rows it hides or folds.

### Focus View

Focus view shows only your messages and the last reply of each turn, plus permission requests and questions that need your answer. It hides tool calls, thinking, subagent boxes and earlier replies in each turn. You can still see which tool is running in the status line above the input box. To turn Focus view on or off, click the eye button under the input box, press Ctrl+Alt+F while a chat tab is in front, or run "OpenCode Agent Plus: Toggle Focus View". The `opencodeAgentPlus.focusView` setting keeps your choice for all chat tabs and is off by default.

### Pinned Message

When you scroll down through a reply, the message you sent to start it stays pinned at the top of the conversation until your next message reaches the top. Click the pinned message to scroll back to it. Pinning is on by default. If you want your messages to scroll away, turn off `opencodeAgentPlus.pinPrompt`.

### Session Information

Click the "i" button under the input box to see the conversation's session ID and the folder it works in. The box also shows the OpenCode version, the process ID of `opencode acp`, the location of OpenCode's session database and Agent Plus's [token mode](#token-mode). Click a row to copy it, or choose Copy all.

### Chimes

Chimes play on the computer showing the chat page. You hear two rising notes when a turn ends, three notes when OpenCode asks for permission and two falling notes when the model asks a question. The musical note button beside Send mutes chimes on all chat pages.

## Links and Images in Replies

When a reply mentions one of your other conversations, its session ID or its title in corner brackets (「title」) becomes a link. A title without corner brackets becomes a link if it is at least 10 characters wide, counting each Chinese, Japanese or Korean character as two. With Agent Plus, replies can also link to your Claude Code and Codex conversations. OpenCode Agent Plus skips code blocks and existing links. To turn off conversation links, disable `opencodeAgentPlus.conversationLinks`.

Hover over a conversation link to see which agent it belongs to, part of its session ID and when it was last active. Click to open the conversation in this window. If another window already has it open, Agent Plus brings that window forward. Links to Claude Code or Codex conversations open in the corresponding extension.

Replies can display PNG, JPEG, GIF, WebP and SVG images up to 8 MB in any token mode. An image appears in the reply when the model gives its absolute path, a `file://` address or a `data:` address. Relative paths and web addresses stay as links, and OpenCode Agent Plus does not fetch images from the web.

On OpenCode 2, OpenCode Agent Plus tells the model that replies can display images unless you choose Interface features for [Token Mode](#token-mode). When it sends that note, it also asks the model to save each image in the conversation's own folder and include its absolute path in the reply. The folder is `~/.opencode-agent-plus/scratch/<session id>/` on the machine where OpenCode runs. Deleting the conversation also removes this folder; see [The Conversations List](#the-conversations-list).

### File Links

A path in a reply becomes a link if the file exists and the path is absolute or relative to a workspace folder or the conversation's folder. The path can include a line number or a line and column, as in `src/app.js:12`, `src/app.js:12:5` or `src/app.js#L12`.

In inline code, the path must be the only content to become a link. Paths inside code blocks and existing links stay unchanged. The file name in a read, edit or write tool row is also a link; click a file link to open the file in an editor beside the chat at the specified line, if given.

## Rewinding and Forking

### Rewinding

On OpenCode 2, you can rewind an idle conversation to just before one of your messages. **In a Git repository, OpenCode restores files before you confirm.** Outside one, rewinding changes only the conversation.

1. Hover over one of your messages and choose Rewind to here.
2. Review the dialog. It lists the files OpenCode removed, changed back or restored, with counts of lines added and removed. If the window closes while the dialog is open, see [Rewinding](known-limits.md#rewinding) in Known Limits.
3. Choose Rewind to put the selected message's text back in the input box and remove that message and all later ones from the conversation. If you cancel, the conversation stays intact and OpenCode restores the files to their state before the rewind.

### Forking

Forking in OpenCode 1 and 2 creates a copy of the whole conversation and opens it in a new tab. On OpenCode 2, hover over one of your messages and choose Fork from here to copy only the conversation before that message into a new tab, with the message's text in its input box.

Choose Fork Conversation from the context menu in the Conversations view, on the chat tab or on the chat page. You can also use the editor title's `...` menu or run `OpenCode Agent Plus: Fork Conversation` from the Command Palette with the chat tab active.

## Subagents and Background Work

A pill with a green dot in the row of buttons under the input box counts running subagents and any shell commands still running in the background. For example, you might see "1 subagent, 1 command running". Click the pill to open a list above the input box. Each item shows its kind, command or title, process ID and start time. Selecting an item scrolls the conversation to its row. OpenCode Agent Plus checks whether a background command is still running only when a turn starts or ends or when you open the list.

In OpenCode 2, look below the tool row that started a subagent. The Subagent box there shows its title, status and latest output. Expand "Its steps (n)", where n counts all of the subagent's steps, to see the last 60 entries, including tool calls and text. Subagent conversations stay out of the Conversations view, `OpenCode Agent Plus: Find Conversation…` and Agent Plus. On OpenCode 1, OpenCode Agent Plus does not distinguish subagent conversations from other conversations.

A subagent or background command finishing can trigger a new turn. The page shows a separate turn with the line "OpenCode started this turn on its own, for a background subagent or command." During the turn, the conversation appears as working. If you aren't viewing it when the reply arrives, the reply counts as unread. The turn's cost is still unknown when it ends; the next time OpenCode reports usage, that cost is added to the conversation cost you see in the figures on each reply.

### Detached Commands

On Linux, the background pill also counts detached commands, which the conversation started and which keep running after they leave OpenCode, such as a command started with `nohup … &`. The pill counts detached commands separately: "1 command running · 1 detached" means one command is running in OpenCode and another is still running after leaving OpenCode. For each detached command, you can see when it started, its process ID and its command line in the list.

## The Conversations List

Click the OpenCode Agent Plus icon in the activity bar to open the Conversations view. It lists OpenCode conversations in any of the workspace folders open in this window. With no folder open, you see conversations from all folders.

The view groups conversations under Recently closed, Open in this window, and Other conversations. Recently closed lists up to 10 conversations whose tabs you closed in this workspace. You see a flat list when Recently closed is empty and the conversations all fall into the same remaining group.

Each row shows the conversation's state and how long ago it was active. Hover over a row for the same details plus the folder, session ID and exact time of the last activity, such as "5m ago (11/24/2026, 8:08:35 AM UTC)". The timestamp includes the time zone name and uses the zone of the machine running OpenCode, which can differ from yours over Remote-SSH.

The view's title bar has `OpenCode Agent Plus: New Conversation` and `OpenCode Agent Plus: Find Conversation…`. Use Find Conversation to search all OpenCode conversations across folders, most recent first. You can enter part of a title, session ID or folder. You can also start a new conversation by clicking the OpenCode Agent Plus icon in any editor's title bar.

Right-click a row for `OpenCode Agent Plus: Rename Conversation` (OpenCode 2), `OpenCode Agent Plus: Fork Conversation` (see [Forking](#forking)) or `OpenCode Agent Plus: Delete Conversation`. Delete Conversation closes the conversation's tabs, removes it from OpenCode, and deletes its work plan and its own folder. If another window has the conversation open, OpenCode Agent Plus refuses to delete it.

## Chat Tabs and Windows

Each chat tab shows the OpenCode Agent Plus icon from the activity bar. The icon has a green dot while the conversation is working, a red dot while it waits for your permission or an answer, and no dot when it is idle. Background work has no dot of its own. If a background tab has an unread reply, an envelope appears after its title and disappears when you view the tab.

On OpenCode 2, you can choose `OpenCode Agent Plus: Rename Conversation` from the tab's context menu or the `...` menu in the editor title bar. For `OpenCode Agent Plus: Fork Conversation`, see [Forking](#forking).

When you close a conversation's last tab, any running turn stops. Tabs you leave open return when you reload the window.

A conversation can be open in only one VS Code window at a time. If you open it in a second window, choose "Take over here" in the notification. The first window stops any running turn and closes the conversation. If it hasn't released the conversation within 10 seconds, you can choose "Take over anyway". Reloading the first window takes the conversation back without asking.

## Work Plan and Plan Bar

If OpenCode Agent Plus finds [Python](setup.md#python-for-the-work-plan), it installs a work plan plugin for the OpenCode 2 process it starts. The plugin lets the model track what still needs to be done in your conversation. In Agent Plus, you can read the plan in the Work plan view and see which of your OpenCode Agent Plus conversations are working, waiting or idle in the Conversations view.

The plan bar above the input box (`opencodeAgentPlus.planBar`) shows the plan's open rows, the row in progress when there is one, and a yellow count of the plan's rows waiting for your answer. Click the bar to open the Work plan view, or click the yellow count to go to their questions in Agent Plus's Answer view.

When the [Token Mode](#token-mode) enables work plans, each message includes the open rows, and the model gets tools to update the plan (`add_row`, `set_row`, `set_status`, `set_summary`). Reminders to update the plan arrive with the next message. During compaction, the work plan plugin asks the model to include the plan's location and open rows in the summary. If any rows remain open after compaction, the next message instructs the model to read the plan before continuing.

OpenCode Agent Plus stores plans in `~/.opencode-agent-plus/plans/` on the machine where OpenCode runs. Deleting a conversation also removes its plan (see [The Conversations List](#the-conversations-list)).

On OpenCode 1, Agent Plus shows "Work plans need OpenCode 2" above the plan. Click the message to open the OpenCode path setting.

### Writing About a Row

Click the pen at the end of any row in the Work plan view to bring the plan's conversation to the front. OpenCode Agent Plus appends `About row N (title): `, with the row's number and title filled in, to any text in the message box. Finish the message and send it when you're ready. The pen needs Agent Plus 1.8.0 or later.

### Claude Code Plus Stewards

To assign a steward, bring a Claude Code conversation to the front in Claude Code Plus. In the Steward panel at the bottom of the VS Code window, beside Problems, Output and Terminal, tick the conversations you want that conversation to look after. You can tick an OpenCode Agent Plus conversation there. The conversation in front becomes their steward.

While an OpenCode Agent Plus conversation has a steward and [Token Mode](#token-mode) has work plans turned on, its model can use `steward_handoff` to pass the steward a request that belongs in another conversation. Under those same conditions, each message the conversation sends to the model includes a note that a steward is watching. The note and the tool need Agent Plus 1.6.0 or later and a Claude Code Plus release later than 1.5.0.

A conversation can have more than one steward. The note then names each of them, and a handoff goes to the steward whose message started the turn, or else to the steward you last talked to. The model can also name one of the stewards to hand it to. To assign multiple stewards to one conversation, use a version of Agent Plus later than 1.6.0.

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
