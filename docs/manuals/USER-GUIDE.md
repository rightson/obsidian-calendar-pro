# Calendar Pro user guide

## Get started

Open the calendar from the ribbon icon or the command palette. Create a local event from **New event** or an empty calendar slot. The event is saved as a Markdown Event Note and linked under `## Events` in the Daily Note for its start date. Click a date to open its Daily Note; the sidebar's week number opens that Weekly Note. Settings → **Clicking** customizes what a click does; see [Click behavior](#click-behavior). Right-click the calendar to open a menu: **New event** creates one at that time, and an **Edit** entry appears for each event at that time (or on that day in Month view), so overlapping events can each be reached.

## Event details

Click an event to open its details: title, start, end and all day, and a preview of its Event Note, which opens on the left, on the right, or in a new tab. Clicking the title also opens the Event Note in a new tab, where you edit the title. To use a different note for an event, open its details from the right-click menu or from **⋯** and click **Edit** under the title: pick any Markdown note or type a new path. The dialog grows wider with the window. The previous Event Note stays in the Vault as an ordinary note with its text intact.

![Event details dialog with start and end times and an Event Note preview](../images/event-details.png)

## Event Note problems

If Event Notes conflict or cannot be read (for example, a duplicated note with the same `event_id`), run **Review Event Note problems** or click the toolbar's problem button: each problem lists the notes side by side, highlights what differs, recommends which to keep, and fixes it in place.

![Review Event Note problems showing two notes with the same event_id side by side](../images/event-note-problems.png)

## Click behavior

Settings → **Clicking** chooses what a left-click does in each calendar:

| Setting | Where | Options |
| --- | --- | --- |
| **Clicking a date in the mini calendar** | The calendar on the left of the Calendar Pro tab | **Go to the date in the main calendar** (default) · **Go to the date and open its Daily Note beside the calendar** · **Go to the date and open its Daily Note in a new tab** |
| **Clicking an empty slot in the main calendar** | A time slot or date cell with no event in the main calendar on the right | **New event in Week and Day; Daily Note in Month and Year** (default) · **Always create a new event** · **Open the Daily Note beside the calendar** · **Open the Daily Note in a new tab** · **Do nothing** |
| **Clicking an event** | An event in the main calendar | **Show event details** (default) · **Open Event Note beside the calendar** · **Open Event Note in a new tab** |

- "Beside the calendar" reuses one note pane next to the calendar while it stays open; "a new tab" opens on the calendar's far side so the calendar stays in view.
- With the main calendar hidden, **Go to the date** opens the Daily Note beside the calendar, since there is no main calendar to move.
- **Always create a new event** makes an all-day event in Month and Year views and in the all-day row.
- These settings change only a plain left-click on an empty spot or a mini-calendar date. Date headers, day numbers, and week numbers always open their Daily or Weekly Note. Right-click always shows **New event** and **Edit** entries. An event's **⋯** button always shows its details.

## Month calendar in the sidebar

A compact month calendar, like a calendar widget, sits beside your notes. It is a separate view from the mini calendar inside the Calendar Pro tab, so it stays visible while you work in notes. It starts at the current month and adds the following months as long as whole months fit the panel's height.

- **Where it appears:** it is added to the right sidebar when Obsidian starts, unless it is already open somewhere. Drag its tab anywhere; it stays where you put it on later starts. To stack it under the file explorer in the left sidebar, one above the other, drag it there or run **Move month calendar below the file explorer** (also a button in settings). Run **Open month calendar in sidebar** to bring it back after closing it.
- **How many months:** a taller panel shows more months, and a wide panel lays them out side by side. In a short panel the month cards get smaller, in up to three steps, until the number of months set in **Show at least** fits. Cards only shrink when that shows an extra month.
- **Opening notes:** click a date to open its Daily Note, or a week number to open its Weekly Note, in the main area. Ctrl/Cmd-click opens it in a new tab.
- **What it marks:** dots under a date show its events (up to three), bold dates already have a Daily Note, and the Daily Note you are viewing is highlighted. Today is outlined, and holidays from holiday calendars are shaded as in the mini calendar (see [Holiday calendars](#holiday-calendars)).
- **Moving through months:** use **‹** and **›**, or scroll over the months; **Today** returns to the current month.
- Subscribed events are marked only for the dates the main calendar has loaded; local events are always marked.

Settings under **Month calendar**:

| Setting | Default | What it does |
| --- | --- | --- |
| Add to the right sidebar at startup | On | Adds the month calendar at startup when it is not open anywhere. Turn it off to keep it closed. |
| Show at least | 3 months | In a short panel, month cards shrink until this many months fit (1–12). |
| Place below the file explorer | — | Moves the month calendar under the file explorer in the left sidebar. |

## Events sidebar

For a phone-style view beside your notes, run **Open events sidebar** or click the clock ribbon icon. It opens in Obsidian's right sidebar with a week strip over the selected day's timeline (all-day events on top, a red line at the current time), or switches to a **List** of the next two weeks. Hover an event to preview its Event Note, click it to open its details (or its note, following the **Clicking an event** setting), drag it to move it or its bottom edge to change its length, and right-click for more. Double-click an empty time, or use **+**, to add an event; the day title and list headings open Daily Notes and the week number opens the Weekly Note. Holiday calendars set to hide their events stay out of the sidebar too.

Today's timeline keeps the current time in the middle of the sidebar and follows it minute by minute. Scroll it yourself and it stays where you put it; click **Today** (or today in the week strip) to follow the current time again. Around midnight the neighbouring day appears dimmed with its events: late in the evening the first hours of tomorrow below midnight, and just after midnight the last hours of yesterday above it. Click them to switch to that day. Changing to another date keeps the hours you were looking at in the same place, showing the neighbouring day dimmed when those hours reach past midnight; turn off **Keep the time of day when changing dates** under Settings → **Events sidebar** to open each date at its first event (or 08:00) instead.

## Subscriptions

Subscriptions are optional. Add an HTTPS or `webcal://` feed in settings to display read-only calendar events. Local events work without a subscription. Imported calendar data is cached for use in the calendar, and event changes can be reviewed in History. Removing the plugin or a feed does not delete Vault notes.

## Holiday calendars

Set a subscription's **Calendar type** to **Holidays** (for example a public-holiday feed such as Google's Taiwan holidays) to mark the days its events cover, not just list them. Each holiday calendar has its own options:

- **Holiday background:** **Gray** (the default, following the light or dark theme), **Custom color** (pick it under **Holiday background color**), or **None**. The background fills the whole day in Week, Day, and Custom days views (both the all-day row and the time grid) and the day cell in Month and Year views. The mini calendar in the Calendar Pro tab and the sidebar month calendar mark the same dates; hover a date to see the holiday's name.
- **Show holiday names:** turn off to hide the holiday events themselves while keeping their dates shaded. Hidden holidays also leave List view, the right-click **Edit** menu, and the month calendar's event dots.

When several holiday calendars share a date, the first one in settings sets its background. The mini calendar marks holidays from every month already loaded for that calendar, so months you have never viewed may appear unmarked until you visit them. Subscriptions without a type stay ordinary event calendars.

## Where Event Notes go

The **Event Note pattern** setting decides where new Event Notes are created. It accepts Moment date tokens and `{title}`, `{calendar}`, and `{uid}`; the default is `[Calendar Notes]/{title}`.

To keep Event Notes beside their Daily Notes, start the pattern with `{daily}`. It stands for the folder of the event's Daily Note. For example, with Daily Notes in `Journal` using the format `YYYY/MM/YYYY-MM-DD`:

| Pattern | Event on 2026-10-23 |
|---|---|
| `{daily}/{title}` | `Journal/2026/10/<title>.md` |
| `{daily}/[Events]/{title}` | `Journal/2026/10/Events/<title>.md` |

`{daily}` must be the first part of the pattern and be followed by `/`.

When an event moves to another date, its Event Note moves with it to the folder the pattern gives for the new date. This applies whether you drag the event, edit it in the calendar, change `start` in the note, or a subscription changes it. Obsidian updates links to the note as for any rename (when **Automatically update internal links** is on), and the Daily Note entry moves to the new Daily Note. A note you renamed keeps its name; if the target name is taken, a number is added, as in `Standup (2).md`. Notes you moved out of the pattern's folder yourself, or chose with **Change…**, stay where they are. A pattern without date folders, such as the default, never moves notes. Changing the pattern or Daily Notes settings affects new notes only.

To keep Event Notes where they were created, turn off **Move Event Notes when dates change** in settings (it is on by default). The Daily Note entry still moves to the new date and links to the note where it is. Turning the setting off also cancels any move that has not happened yet.

## Projects and Gantt

Any note can be opened as a Gantt: click the chart button in the note's title bar, run **Open current note as Gantt**, or right-click the file and choose **Open as Gantt**. The note's outline is the project's work breakdown: every heading and list item is a row, indentation and heading levels make the tree, and the order of lines is the order of tasks. WBS numbers such as 1.2.1 come from each row's position and are never written to the note.

A task's dates, progress, and people go in brackets at the end of its line:

```
- 網站改版
  - 設計 (11/20)
    - 線框圖 (100%, 11/2-11/4)
    - 視覺稿 (30%, 11/4-11/10, @小王)
      - 補充說明：配色待定
  - 開發
    - API (11/9-11/22, @[[AAA]])
    - 前端 （跟 AAA 確認）
- 行銷
  - 發新聞稿 (◆ 11/30)
  - 社群貼文 下週一前
```

| You write | It means |
|---|---|
| `30%` or `30％` | Progress. A ticked checkbox `- [x]` is 100%. |
| `11/6` or `2026-11-06` | A deadline (month first). |
| `11/1-11/6` (also `–` or `~`) | Start and end, both days included. |
| `◆ 11/30` | A milestone on that day. |
| `@小王`, `@[[小王]]`, or `[[@小王]]` | Who does it. The linked forms point to the person's note: `[[@小王]]` when the note is named `@小王` (as the At People and Mention Things plugins insert), `@[[小王]]` otherwise. Rows below inherit it until one names someone else. The earlier `by [[小王]]` is still read. A plain link such as `[[規格]]` is not a person. |

Brackets may be half-width `( )` or full-width `（ ）`, and the parts may be separated by `,`, `，`, or `、`. Dates without a year are this year; a range whose end comes before its start ends in the next year. The brackets count only when every part is one of the above, so `（跟 AAA 確認）` stays your own remark, and text outside the last brackets on the line is never read. A ⚠ in the table marks brackets that mix both, such as `(30%, 待確認)`.

A row with tasks below it is a summary: its dates run from the earliest start to the latest end below it, and its progress is weighted by days (a task with a start and end counts its days; a deadline-only or unscheduled task counts as one day). A date written on the summary itself is that branch's target; when the tasks below end later, the target turns red and says why. A plain line without brackets is a row without dates, and a plain line under a task is a remark about it.

**Table** lists the tree with WBS, Task, %, Start, End, and Assignee. Edit any cell and press Enter; the change is written into that line's brackets, keeping how you wrote them, and adds the brackets when the line has none, as in `(30%, 11/1-11/6)`. A cell it cannot read stays unchanged and says what it expects. **+10**, **+20**, and **Done** raise a task's progress (a button that would pass 100% is disabled), and every change shows a notice with **Undo**. The ⋯ menu opens the line in the note and can **Promote to Task Note**, replacing the title with a link to a new note beside the project while dates, progress, and subtasks stay in the project; **Demote to text** turns it back and offers to trash the Task Note if it is still empty. A linked assignee without a note gets a **＋** button that creates it in the **People folder** (Settings → Gantt, `People/` by default), named as the link is written (`@[[小王]]` creates `小王.md`, `[[@小王]]` creates `@小王.md`). **[[ ]]** next to `@name` links it: to `[[@name]]` when a note named `@name` exists, otherwise to `@[[name]]`. Words such as 今天, 明天, 後天, 本週五, 下週一, 週三前, 月底, 月初, and 20號前 show a **Due …?** chip, and 找小王 shows **Assign to 小王?**; nothing is written until you click one.

**Chart** shows the same tree beside a timeline with a red line for today. Bars fill with progress; drag a bar to move it or drag either end to change it. Summaries show a thin bar and their target, deadlines a marker with a dashed line from today, and milestones a diamond with a vertical line. Rows without dates wait under **Unscheduled**; drag one onto the timeline to give it that day. Colour bars by assignee or show one person's tasks with the controls above the chart. **Note** returns to the Markdown note.

The first change to a note shows it as a diff before writing (tick **Don’t ask again** to skip this from then on, or turn off **Preview the first change to each note** in settings). A note becomes a Project when its properties include `gantt`; the first change adds `gantt: true` for you. Nothing about tasks is stored outside the note itself.

Dated tasks of every Project also appear in the main calendar's all-day row in their own dark colours. They cannot be dragged there. Click one to **Schedule on <day>…**, which opens the usual new-event dialog for a time that day and creates an Event Note whose `task` property links back to the task (the task line gains a `^id` block reference), or to **Open Project Note** at that line.

## Privacy and compatibility

No account or telemetry is required. Calendar Pro makes read-only HTTPS requests only to fetch calendar feeds whose URLs you configure. Feed URLs, raw ICS responses, settings, history, link tracking, and recovery data are stored in Obsidian's private plugin data; Event, Daily, and Weekly Notes are written to your Vault. The plugin does not access files outside the Vault and its plugin data folder.

Event Note Properties behavior depends on Obsidian's native editor DOM and is feature-detected; if the property panel is unavailable or hidden, Calendar Pro leaves it alone. Daily and Weekly Note provider settings are detected through internal Obsidian/plugin state because there is no public provider API, so provider updates may require compatibility changes.
