# pi-session-bookmarks

Local Pi package that adds global session bookmarks.

Commands:

- `/bookmark-session [note]` - bookmark the current Pi session.
- `/bookmarks` - open the global bookmarks picker.
- `/unbookmark-session [id|path]` - remove a bookmark, defaulting to the current session.

Bookmarks are stored globally at `~/.pi/agent/session-bookmarks/bookmarks.json`, so the picker shows sessions from every project/CWD.
