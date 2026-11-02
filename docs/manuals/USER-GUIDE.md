# Calendar Pro user guide

## Get started

Open the calendar from the ribbon icon or the command palette. Create a local event from **New event** or an empty calendar slot. The event is saved as a Markdown Event Note and linked under `## Events` in the Daily Note for its start date. Click a date to open its Daily Note; the sidebar's week number opens that Weekly Note. Settings → **Clicking** customizes what a click does; see [Click behavior](#click-behavior). Right-click the calendar to open a menu: **New event** creates one at that time, and an **Edit** entry appears for each event at that time (or on that day in Month view), so overlapping events can each be reached.

## Event details

Click an event to open its details: title, start and end, all day, and a preview of its Event Note, which opens on the left, on the right, or in a new tab. To use a different note for an event, open its details from the right-click menu or from **⋯** and choose **Change…** beside Event Note: pick any Markdown note or type a new path. The previous Event Note stays in the Vault as an ordinary note with its text intact.

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

## Privacy and compatibility

No account or telemetry is required. Calendar Pro makes read-only HTTPS requests only to fetch calendar feeds whose URLs you configure. Feed URLs, raw ICS responses, settings, history, link tracking, and recovery data are stored in Obsidian's private plugin data; Event, Daily, and Weekly Notes are written to your Vault. The plugin does not access files outside the Vault and its plugin data folder.

Event Note Properties behavior depends on Obsidian's native editor DOM and is feature-detected; if the property panel is unavailable or hidden, Calendar Pro leaves it alone. Daily and Weekly Note provider settings are detected through internal Obsidian/plugin state because there is no public provider API, so provider updates may require compatibility changes.
