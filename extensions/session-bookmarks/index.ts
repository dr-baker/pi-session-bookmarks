import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

const BOOKMARKS_DIR = join(homedir(), ".pi", "agent", "session-bookmarks");
const BOOKMARKS_PATH = join(BOOKMARKS_DIR, "bookmarks.json");
const BOOKMARKS_VERSION = 1;
const STARTUP_BOOKMARK_LIMIT = 5;
const MENU_MIN_WIDTH = 88;

type JsonObject = Record<string, unknown>;

type SessionBookmark = {
	id: string;
	sessionFile: string;
	sessionId?: string;
	cwd?: string;
	name?: string;
	firstMessage?: string;
	createdAt?: string;
	lastInteractedAt?: string;
	bookmarkedAt: string;
	note?: string;
};

type BookmarkIndex = {
	version: number;
	bookmarks: Record<string, SessionBookmark>;
};

type SessionSummary = {
	sessionFile: string;
	sessionId?: string;
	cwd?: string;
	name?: string;
	firstMessage?: string;
	createdAt?: string;
	lastInteractedAt?: string;
	messageCount: number;
	missing: boolean;
};

type BookmarkMenuState = {
	selectedId?: string;
	message?: string;
	paneMode: "overview" | "help" | "message";
};

function ensureDir(dirPath: string): void {
	mkdirSync(dirPath, { recursive: true });
}

function readJsonFile<T>(filePath: string, fallback: T): T {
	if (!existsSync(filePath)) return fallback;
	try {
		return (JSON.parse(readFileSync(filePath, "utf8")) as T) ?? fallback;
	} catch {
		return fallback;
	}
}

function writeJsonFile(filePath: string, value: unknown): void {
	ensureDir(dirname(filePath));
	writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readBookmarkIndex(): BookmarkIndex {
	const index = readJsonFile<BookmarkIndex>(BOOKMARKS_PATH, { version: BOOKMARKS_VERSION, bookmarks: {} });
	return {
		version: BOOKMARKS_VERSION,
		bookmarks: index.bookmarks && typeof index.bookmarks === "object" ? index.bookmarks : {},
	};
}

function writeBookmarkIndex(index: BookmarkIndex): void {
	writeJsonFile(BOOKMARKS_PATH, { ...index, version: BOOKMARKS_VERSION });
}

function realpathSafe(filePath: string): string {
	try {
		return realpathSync(filePath);
	} catch {
		return isAbsolute(filePath) ? resolve(filePath) : resolve(process.cwd(), filePath);
	}
}

function displayPath(filePath: string | undefined, baseDir?: string): string {
	if (!filePath) return "unknown";
	const absoluteBase = baseDir ? resolve(baseDir) : undefined;
	const absolutePath = isAbsolute(filePath) ? resolve(filePath) : resolve(absoluteBase || process.cwd(), filePath);
	if (absoluteBase) {
		const rel = relative(absoluteBase, absolutePath);
		if (!rel) return ".";
		if (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)) return rel;
	}
	const homeRel = relative(homedir(), absolutePath);
	if (homeRel && homeRel !== ".." && !homeRel.startsWith("../") && !isAbsolute(homeRel)) return `~/${homeRel}`;
	return filePath;
}

function coerceIsoDate(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const time = Date.parse(value);
	return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}

function messageText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const item = part as JsonObject;
			if (item.type === "text" && typeof item.text === "string") return item.text;
			if (item.type === "toolCall" && typeof item.name === "string") return `[tool ${item.name}]`;
			return "";
		})
		.filter(Boolean)
		.join(" ");
}

function summarizeText(text: string | undefined, maxLength = 180): string | undefined {
	const normalized = (text || "").replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function inspectSessionFile(sessionFile: string): SessionSummary {
	const resolved = realpathSafe(sessionFile);
	if (!existsSync(resolved)) {
		return { sessionFile: resolved, messageCount: 0, missing: true };
	}

	let createdAt: string | undefined;
	let lastInteractedAt: string | undefined;
	let sessionId: string | undefined;
	let cwd: string | undefined;
	let name: string | undefined;
	let firstMessage: string | undefined;
	let messageCount = 0;

	try {
		const lines = readFileSync(resolved, "utf8").split(/\r?\n/).filter(Boolean);
		for (const line of lines) {
			let entry: JsonObject;
			try {
				entry = JSON.parse(line) as JsonObject;
			} catch {
				continue;
			}

			if (entry.type === "session") {
				sessionId = typeof entry.id === "string" ? entry.id : sessionId;
				cwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
				createdAt = coerceIsoDate(entry.timestamp) || createdAt;
				continue;
			}

			lastInteractedAt = coerceIsoDate(entry.timestamp) || lastInteractedAt;

			if (entry.type === "session_info") {
				name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : name;
				continue;
			}

			if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") continue;
			messageCount++;
			const message = entry.message as JsonObject;
			if (message.role === "user" && !firstMessage) {
				firstMessage = summarizeText(messageText(message.content));
			}
			const messageTimestamp = typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : undefined;
			lastInteractedAt = messageTimestamp || lastInteractedAt;
		}
	} catch {
		// Keep the stat fallback below.
	}

	try {
		const stat = statSync(resolved);
		createdAt = createdAt || stat.birthtime.toISOString();
		lastInteractedAt = lastInteractedAt || stat.mtime.toISOString();
	} catch {
		// ignore
	}

	return {
		sessionFile: resolved,
		sessionId,
		cwd,
		name,
		firstMessage,
		createdAt,
		lastInteractedAt,
		messageCount,
		missing: false,
	};
}

function sessionBookmarkId(summary: SessionSummary): string {
	return summary.sessionId || realpathSafe(summary.sessionFile);
}

function findBookmarkForSessionFile(sessionFile: string | undefined): SessionBookmark | undefined {
	if (!sessionFile) return undefined;
	const summary = inspectSessionFile(sessionFile);
	const id = sessionBookmarkId(summary);
	const resolved = realpathSafe(sessionFile);
	return Object.values(readBookmarkIndex().bookmarks).find((bookmark) => bookmark.id === id || bookmark.sessionFile === resolved || bookmark.sessionFile === sessionFile);
}

function upsertBookmark(sessionFile: string, note?: string): SessionBookmark {
	const summary = inspectSessionFile(sessionFile);
	const id = sessionBookmarkId(summary);
	const index = readBookmarkIndex();
	const existing = index.bookmarks[id];
	const bookmark: SessionBookmark = {
		...existing,
		id,
		sessionFile: summary.sessionFile,
		sessionId: summary.sessionId,
		cwd: summary.cwd,
		name: summary.name,
		firstMessage: summary.firstMessage,
		createdAt: summary.createdAt,
		lastInteractedAt: summary.lastInteractedAt,
		bookmarkedAt: existing?.bookmarkedAt || new Date().toISOString(),
		note: note?.trim() || existing?.note,
	};
	index.bookmarks[id] = bookmark;
	writeBookmarkIndex(index);
	return bookmark;
}

function removeBookmark(idOrPath: string): SessionBookmark | undefined {
	const index = readBookmarkIndex();
	const resolved = realpathSafe(idOrPath);
	const entry = Object.values(index.bookmarks).find((bookmark) => bookmark.id === idOrPath || bookmark.sessionFile === resolved || bookmark.sessionFile === idOrPath);
	if (!entry) return undefined;
	delete index.bookmarks[entry.id];
	writeBookmarkIndex(index);
	return entry;
}

function currentSessionFile(ctx: { sessionManager?: { getSessionFile?: () => string | undefined } }): string | undefined {
	try {
		return ctx.sessionManager?.getSessionFile?.();
	} catch {
		return undefined;
	}
}

function currentCwd(ctx: { cwd?: string; sessionManager?: { getCwd?: () => string } }): string | undefined {
	try {
		return ctx.sessionManager?.getCwd?.() || ctx.cwd;
	} catch {
		return ctx.cwd;
	}
}

function hydrateBookmark(bookmark: SessionBookmark): SessionBookmark & { summary: SessionSummary } {
	const summary = inspectSessionFile(bookmark.sessionFile);
	return {
		...bookmark,
		sessionFile: summary.sessionFile,
		sessionId: summary.sessionId || bookmark.sessionId,
		cwd: summary.cwd || bookmark.cwd,
		name: summary.name || bookmark.name,
		firstMessage: summary.firstMessage || bookmark.firstMessage,
		createdAt: summary.createdAt || bookmark.createdAt,
		lastInteractedAt: summary.lastInteractedAt || bookmark.lastInteractedAt,
		summary,
	};
}

function listBookmarks(): Array<SessionBookmark & { summary: SessionSummary }> {
	return Object.values(readBookmarkIndex().bookmarks)
		.map(hydrateBookmark)
		.sort((a, b) => {
			const aTime = Date.parse(a.lastInteractedAt || a.bookmarkedAt || "") || 0;
			const bTime = Date.parse(b.lastInteractedAt || b.bookmarkedAt || "") || 0;
			return bTime - aTime;
		});
}

function titleForBookmark(bookmark: SessionBookmark): string {
	return bookmark.name || bookmark.firstMessage || basename(bookmark.cwd || bookmark.sessionFile) || "Untitled session";
}

function stripBookmarkStar(name: string | undefined): string {
	return (name || "").replace(/^★\s*/, "").trim();
}

function starredSessionName(currentName: string | undefined, bookmark: SessionBookmark): string | undefined {
	const base = stripBookmarkStar(currentName) || stripBookmarkStar(titleForBookmark(bookmark));
	return base ? `★ ${base}` : undefined;
}

function applyBookmarkSessionName(pi: ExtensionAPI, bookmark: SessionBookmark): void {
	const nextName = starredSessionName(pi.getSessionName(), bookmark);
	if (nextName && pi.getSessionName() !== nextName) pi.setSessionName(nextName);
}

function removeBookmarkSessionName(pi: ExtensionAPI): void {
	const current = pi.getSessionName();
	const next = stripBookmarkStar(current);
	if (current && current !== next) pi.setSessionName(next);
}

function formatAge(iso: string | undefined): string {
	if (!iso) return "unknown";
	const time = Date.parse(iso);
	if (!Number.isFinite(time)) return "unknown";
	const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	if (days < 60) return `${days}d ago`;
	return new Date(time).toLocaleDateString();
}

function formatTimeWithAge(iso: string | undefined): string {
	if (!iso) return "unknown";
	const time = Date.parse(iso);
	if (!Number.isFinite(time)) return "unknown";
	return `${new Date(time).toLocaleString()} (${formatAge(iso)})`;
}

function padPlain(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	const padding = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(padding);
}

function renderBox(theme: any, lines: string[], width: number, title = "Pi Session Bookmarks"): string[] {
	const innerWidth = Math.max(1, width - 2);
	const titleText = truncateToWidth(` ${title} `, innerWidth);
	const titleWidth = visibleWidth(titleText);
	const remaining = Math.max(0, innerWidth - titleWidth);
	const leftRule = "─".repeat(Math.floor(remaining / 2));
	const rightRule = "─".repeat(remaining - leftRule.length);
	const border = (text: string) => theme.fg("border", text);
	return [
		`${border(`╭${leftRule}`)}${theme.fg("accent", theme.bold(titleText))}${border(`${rightRule}╮`)}`,
		...lines.map((line) => `${border("│")}${padPlain(line, innerWidth)}${border("│")}`),
		border(`╰${"─".repeat(innerWidth)}╯`),
	];
}

function detailLines(theme: any, bookmark: SessionBookmark & { summary: SessionSummary }, width: number, cwd: string | undefined): string[] {
	if (bookmark.summary.missing) {
		return [
			theme.fg("accent", theme.bold(titleForBookmark(bookmark))),
			"",
			theme.fg("error", "Session file is missing."),
			`${theme.fg("dim", "Path:")} ${truncateToWidth(displayPath(bookmark.sessionFile), width - 6)}`,
			"",
			theme.fg("dim", "Press d to remove this bookmark."),
		];
	}

	const targetCwd = bookmark.cwd;
	const cwdDiffers = targetCwd && cwd && resolve(targetCwd) !== resolve(cwd);
	const lines = [
		theme.fg("accent", theme.bold(titleForBookmark(bookmark))),
		bookmark.note ? theme.fg("text", bookmark.note) : undefined,
		"",
		`${theme.fg("dim", "Started:")} ${formatTimeWithAge(bookmark.createdAt)}`,
		`${theme.fg("dim", "Last interaction:")} ${formatTimeWithAge(bookmark.lastInteractedAt)}`,
		`${theme.fg("dim", "Bookmarked:")} ${formatTimeWithAge(bookmark.bookmarkedAt)}`,
		`${theme.fg("dim", "Messages:")} ${bookmark.summary.messageCount}`,
		"",
		`${theme.fg("dim", "Session cwd:")} ${truncateToWidth(displayPath(targetCwd), width - 13)}`,
		cwdDiffers ? theme.fg("warning", "Opening this bookmark will switch Pi's runtime cwd to the session cwd.") : undefined,
		targetCwd && !existsSync(targetCwd) ? theme.fg("error", "Stored session cwd no longer exists; Pi will ask how to continue.") : undefined,
		`${theme.fg("dim", "Session file:")} ${truncateToWidth(displayPath(bookmark.sessionFile), width - 14)}`,
	].filter(Boolean) as string[];
	if (bookmark.firstMessage) {
		lines.push("", theme.fg("dim", "First prompt:"), ...wrapTextWithAnsi(theme.fg("text", bookmark.firstMessage), width));
	}
	return lines;
}

function helpLines(theme: any): string[] {
	return [
		theme.fg("accent", theme.bold("Help")),
		"",
		"↑/↓ or j/k  Select a bookmarked session",
		"enter/o     Open the selected session in this Pi instance",
		"d           Delete the selected bookmark (does not delete the session file)",
		"r           Refresh metadata from session files",
		"?           Show this help",
		"esc         Return to overview, or close from overview",
		"",
		theme.fg("dim", "Bookmarks are global and stored outside project directories."),
		theme.fg("dim", "When opening a bookmark from another project, Pi rebinds tools and UI to that session's stored cwd."),
	];
}

function messageLines(theme: any, state: BookmarkMenuState): string[] {
	return [
		theme.fg("accent", theme.bold("Message")),
		"",
		...(state.message || "Done.").split(/\r?\n/).map((line) => theme.fg("text", line)),
		"",
		theme.fg("dim", "Esc: return to overview"),
	];
}

function buildMenuLines(theme: any, bookmarks: Array<SessionBookmark & { summary: SessionSummary }>, state: BookmarkMenuState, renderWidth: number, cwd: string | undefined): string[] {
	if (bookmarks.length === 0) {
		return renderBox(theme, [
			theme.fg("dim", "No Pi sessions are bookmarked yet."),
			theme.fg("dim", "Use /bookmark [note] to bookmark the current session."),
		], renderWidth);
	}

	if (!state.selectedId || !bookmarks.some((bookmark) => bookmark.id === state.selectedId)) {
		state.selectedId = bookmarks[0]?.id;
	}

	const selectedIndex = Math.max(0, bookmarks.findIndex((bookmark) => bookmark.id === state.selectedId));
	const selected = bookmarks[selectedIndex] || bookmarks[0]!;
	const contentWidth = Math.max(1, renderWidth - 2);
	const listWidth = Math.max(30, Math.floor(contentWidth * 0.38));
	const detailWidth = Math.max(40, contentWidth - listWidth - 3);
	const maxListItems = 14;
	const start = Math.max(0, Math.min(selectedIndex - Math.floor(maxListItems / 2), Math.max(0, bookmarks.length - maxListItems)));
	const visible = bookmarks.slice(start, start + maxListItems);

	const listLines = [
		theme.fg("accent", theme.bold(`Bookmarks (${bookmarks.length})`)),
		...visible.map((bookmark) => {
			const marker = bookmark.id === selected.id ? "›" : " ";
			const missing = bookmark.summary.missing;
			const title = titleForBookmark(bookmark);
			const when = formatAge(bookmark.lastInteractedAt || bookmark.bookmarkedAt);
			const line = `${marker} ${title} · ${when}`;
			const color = bookmark.id === selected.id ? "accent" : missing ? "error" : "text";
			return theme.fg(color, truncateToWidth(line, listWidth));
		}),
	];

	const rightLines = state.paneMode === "help"
		? helpLines(theme)
		: state.paneMode === "message"
			? messageLines(theme, state)
			: detailLines(theme, selected, detailWidth, cwd);

	const lines = [
		theme.fg("dim", "↑↓/j/k select · enter open · d delete bookmark · r refresh · ? help · esc close"),
		"",
	];
	const rows = Math.max(listLines.length, rightLines.length);
	for (let i = 0; i < rows; i++) {
		const left = listLines[i] || "";
		const right = rightLines[i] || "";
		lines.push(`${padPlain(left, listWidth)} ${theme.fg("dim", "│")} ${truncateToWidth(right, detailWidth)}`);
	}
	return renderBox(theme, lines, renderWidth);
}

async function switchToBookmark(ctx: any, bookmark: SessionBookmark & { summary: SessionSummary }): Promise<void> {
	if (bookmark.summary.missing) {
		ctx.ui.notify("That bookmark points to a missing session file.", "error");
		return;
	}
	const activeFile = currentSessionFile(ctx);
	if (activeFile && realpathSafe(activeFile) === realpathSafe(bookmark.sessionFile)) {
		ctx.ui.notify("Already in that bookmarked session.", "info");
		return;
	}
	const fromCwd = currentCwd(ctx);
	const toCwd = bookmark.cwd;
	if (toCwd && fromCwd && resolve(toCwd) !== resolve(fromCwd)) {
		ctx.ui.notify(`Switching Pi cwd: ${displayPath(fromCwd)} → ${displayPath(toCwd)}`, "info");
	}
	await ctx.switchSession(bookmark.sessionFile, {
		withSession: async (nextCtx: any) => {
			const cwd = currentCwd(nextCtx) || toCwd;
			nextCtx.ui.notify(`Opened bookmarked session${cwd ? ` in ${displayPath(cwd)}` : ""}.`, "info");
		},
	});
}

async function openBookmarksMenu(ctx: any): Promise<void> {
	if (!ctx.hasUI || typeof ctx.ui?.custom !== "function") {
		throw new Error("/bookmark-list requires interactive UI mode.");
	}
	const terminalWidth = process.stdout.columns || 0;
	if (terminalWidth > 0 && terminalWidth < MENU_MIN_WIDTH) {
		throw new Error(`/bookmark-list requires a terminal at least ${MENU_MIN_WIDTH} columns wide. Current width: ${terminalWidth}.`);
	}

	await ctx.ui.custom((tui: any, theme: any, _kb: any, done: (value?: void) => void) => {
		const state: BookmarkMenuState = { paneMode: "overview" };
		let bookmarks = listBookmarks();
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			done(undefined);
		};
		const selectedBookmark = () => bookmarks.find((bookmark) => bookmark.id === state.selectedId) || bookmarks[0];
		const selectDelta = (delta: number) => {
			if (bookmarks.length === 0) return;
			const current = Math.max(0, bookmarks.findIndex((bookmark) => bookmark.id === state.selectedId));
			state.selectedId = bookmarks[Math.max(0, Math.min(bookmarks.length - 1, current + delta))]?.id;
			state.paneMode = "overview";
			tui.requestRender();
		};
		const deleteSelected = () => {
			const bookmark = selectedBookmark();
			if (!bookmark) return;
			removeBookmark(bookmark.id);
			bookmarks = bookmarks.filter((entry) => entry.id !== bookmark.id);
			state.selectedId = bookmarks[0]?.id;
			state.paneMode = "message";
			state.message = `Removed bookmark for ${titleForBookmark(bookmark)}.\nThe session file was not deleted.`;
			tui.requestRender();
		};
		const openSelected = () => {
			const bookmark = selectedBookmark();
			if (!bookmark) return;
			close();
			void switchToBookmark(ctx, bookmark);
		};
		return {
			render(renderWidth: number) {
				if (renderWidth < MENU_MIN_WIDTH) {
					throw new Error(`/bookmark-list requires a terminal at least ${MENU_MIN_WIDTH} columns wide. Current render width: ${renderWidth}.`);
				}
				return buildMenuLines(theme, bookmarks, state, renderWidth, currentCwd(ctx));
			},
			invalidate() {},
			handleInput(data: string) {
				if ((state.paneMode === "help" || state.paneMode === "message") && matchesKey(data, "escape")) {
					state.paneMode = "overview";
					state.message = undefined;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
					close();
				} else if (matchesKey(data, "up") || data === "k" || data === "K") {
					selectDelta(-1);
				} else if (matchesKey(data, "down") || data === "j" || data === "J") {
					selectDelta(1);
				} else if (matchesKey(data, "return") || data === "o" || data === "O") {
					openSelected();
				} else if (data === "d" || data === "D") {
					deleteSelected();
				} else if (data === "r" || data === "R") {
					bookmarks = listBookmarks();
					if (!bookmarks.some((bookmark) => bookmark.id === state.selectedId)) state.selectedId = bookmarks[0]?.id;
					state.paneMode = "overview";
					tui.requestRender();
				} else if (data === "?" || data === "h" || data === "H") {
					state.paneMode = "help";
					tui.requestRender();
				}
			},
		};
	}, {
		overlay: true,
		overlayOptions: {
			anchor: "center",
			width: "94%",
			minWidth: MENU_MIN_WIDTH,
			maxHeight: "90%",
			margin: 1,
		},
	});
}

function startupBookmarkSummary(): string | undefined {
	const bookmarks = listBookmarks();
	if (bookmarks.length === 0) return undefined;
	const lines = bookmarks.slice(0, STARTUP_BOOKMARK_LIMIT).map((bookmark, index) => {
		const title = summarizeText(titleForBookmark(bookmark), 70) || "Untitled session";
		const cwd = displayPath(bookmark.cwd);
		return `${index + 1}. ${title} — ${cwd} — last ${formatAge(bookmark.lastInteractedAt || bookmark.bookmarkedAt)}`;
	});
	const extra = bookmarks.length > STARTUP_BOOKMARK_LIMIT ? `\n… and ${bookmarks.length - STARTUP_BOOKMARK_LIMIT} more` : "";
	return `Bookmarked Pi sessions (${bookmarks.length}):\n${lines.join("\n")}${extra}\nOpen with /bookmark-list.`;
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (event, ctx) => {
		const sessionFile = currentSessionFile(ctx);
		const existingBookmark = findBookmarkForSessionFile(sessionFile);

		pi.registerCommand("bookmark", {
			description: "Bookmark the current Pi session globally: /bookmark [note]",
			handler: async (args, ctx) => {
				await ctx.waitForIdle();
				const trimmed = args.trim();
				if (existingBookmark) {
					ctx.ui.notify("This session is already bookmarked. Use /unbookmark to remove it, or /bookmark-list to browse bookmarks.", "info");
					return;
				}
				const sessionFile = currentSessionFile(ctx);
				if (!sessionFile) {
					ctx.ui.notify("This session is not persisted, so it cannot be bookmarked.", "warning");
					return;
				}
				const bookmark = upsertBookmark(sessionFile, trimmed || undefined);
				applyBookmarkSessionName(pi, bookmark);
				ctx.ui.notify(`Bookmarked: ${titleForBookmark(bookmark)}\nUse /bookmark-list to open it later.`, "info");
				await ctx.reload();
				return;
			},
		});

		pi.registerCommand("bookmark-list", {
			description: "Open the global Pi session bookmarks picker.",
			handler: async (_args, ctx) => {
				await ctx.waitForIdle();
				await openBookmarksMenu(ctx);
			},
		});

		if (existingBookmark) {
			applyBookmarkSessionName(pi, existingBookmark);
		} else {
			removeBookmarkSessionName(pi);
		}

		if (existingBookmark) {
			pi.registerCommand("unbookmark", {
				description: "Remove the bookmark for the current Pi session.",
				handler: async (_args, ctx) => {
					await ctx.waitForIdle();
					const target = currentSessionFile(ctx);
					if (!target) {
						ctx.ui.notify("This session is not persisted, so it cannot be unbookmarked.", "warning");
						return;
					}
					const removed = removeBookmark(target);
					if (!removed) {
						ctx.ui.notify("No matching session bookmark found.", "warning");
						return;
					}
					removeBookmarkSessionName(pi);
					ctx.ui.notify(`Removed bookmark: ${titleForBookmark(removed)}`, "info");
					await ctx.reload();
					return;
				},
			});
		}

		if (event.reason !== "reload" && ctx.hasUI) {
			const summary = startupBookmarkSummary();
			if (summary) ctx.ui.notify(summary, "info");
		}
		if (ctx.hasUI) {
			const count = listBookmarks().length;
			ctx.ui.setStatus("session-bookmarks", count > 0 ? ctx.ui.theme.fg("accent", `🔖 ${count}`) : undefined);
		}
	});
}
