# Judging whether the chat page looks like Claude Code's panel

Read [LOOK.md](LOOK.md) first. In each picture, judge how much OpenCode Agent Plus's chat page on the right looks like Claude Code's panel on the left.

## What the pictures hold

`test/vscode/look-alike.js` starts VS Code with OpenCode Agent Plus and a fake backend that plays scripted turns. It saves one picture per state and theme in the output folder's `shots/`. The grey strips label the halves. The left label gives the archived versions from `test/vscode/look-alike/official.json`: Claude Code 2.1.332 with Claude Code Plus 1.5.0, in VS Code 1.147.0. Each `look.json` entry adds `official`, the archived filename and versions.

Both halves show the editor without tabs in a 1440 by 900 CSS pixel window, in Default Dark Modern or Default Light Modern. Slash (commands) and at (files) show only the lower 440 pixels. Other states show a permission request, finished replies, a conversation with thinking, text and tool rows (one open), a question with choices, a subagent call and result, a failed tool, or a running turn.

The archive shows Claude Code Plus's demo conversation; the run shows scripted content. Ignore differences in text, times, filenames, numbers, costs and model names.

## What to compare

- Layout: Look for a thin title header, conversation below, small buttons down the right edge and a centred message box about 680 pixels wide at the bottom. Requests and questions sit just above the box or replace it. Command and file lists sit just above it and match its width.
- Conversation: Your messages fill the width, with a coloured left bar and small time before the text. Reply rows have dots on a thin vertical line: grey by default, green for success, red for failure, blue for running tools. Each starts with a small grey monospaced time, on its own line above tool names. In the last row of each reply, the time is followed by the turn's duration, context share, cost and model.
- Tool rows: Look for a bold name and grey arguments on one line. An open tool has a framed monospaced box with faded IN and OUT labels on separate rows.
- Message box: A rounded box holds text above a thin divider and small buttons below. Pills have rounded ends and faint backgrounds, grey effort beside the model, and a green dot for background work. The square send button on the right becomes stop during a turn.
- Popups and requests: Check frames and shadows. Requests highlight the first numbered choice; lists highlight what Enter selects.
- Colours and type: Compare theme colours, text sizes, row spacing, corner rounding and line and border thickness.

## Intended differences

- Claude Code uses Anthropic's logo, mascot and orange or red accents for focus, send and Auto mode. The right uses theme focus and button colours and VS Code icons.
- Claude Code has header buttons for bookmarks, history and new conversations, a mode menu and a "Generating" mark. The right has info, chime and subagent filter buttons under the message box and OpenCode modes such as Build and Plan.
- Right-hand tools fold to one line. Compare an opened tool with Claude Code's open IN/OUT boxes.
- Right-hand requests start with a time and keep the box below for typing and queuing messages. Claude Code replaces the box.
- Compare the right's pill-shaped VS Code model, effort and mode drop-downs only when closed.
- Compare only shape and placement for Claude Code Plus's detached-command count, focus view, mute and filter buttons.
- The right's question box takes an own answer in a text box and has no collapse or close button: OpenCode asks for an own answer in a field of its own, and Cancel or Esc ends the question.
- The right's slash list holds only OpenCode's commands, without Claude Code's groups and setting rows; the model, effort and mode are in the pills under the message box.
- Only the last row of a reply on the right names the model; the other rows show their time and how long after the message they came.

## Verdict

For pass 1, use `expect` for both halves. Choose "alike" if someone familiar with Claude Code would take the right for it apart from intended differences; "mostly alike" for matching layout with one or two differing aspects; "not alike" for different layout or several differing aspects.

For each difference outside the intended list, name the aspect, specify which half and where in the picture, and describe what differs. For example, the open tool box in the right half has no border. Run pass 2 only on the right. Intended differences aren't findings, but report defects such as unreadable accent text.

## REVIEW-ALIKE.md

Write beside `look.json`. For parts, use the range as in `REVIEW-ALIKE-13-24.md`. List findings most visible first, one per line; write "None." if empty.

```markdown
# How alike: <this folder's name>

## Pictures

| picture | verdict | aspects that differ | intended differences seen |
|---|---|---|---|
| | | | |

## Findings

- **<aspect>** - <picture>, <half>, <where>: <what differs>.

## Summary

<count> alike, <count> mostly alike, <count> not alike. <Differences that matter most.>
```