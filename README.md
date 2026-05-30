# pi-session-bookmarks

Local Pi package that adds global session bookmarks.

Commands:

- `/bookmark [note]` - bookmark the current Pi session.
- `/bookmark-list` - open the global bookmarks picker.
- `/unbookmark` - remove the bookmark for the current session.

Bookmarks are stored globally at `~/.pi/agent/session-bookmarks/bookmarks.json`, so the picker shows sessions from every project/CWD.
