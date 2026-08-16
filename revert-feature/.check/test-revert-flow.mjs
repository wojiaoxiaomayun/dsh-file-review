import assert from "node:assert/strict";
import { FsError } from "@deepseek-ai/dsh-fs";
import * as toolFs from "./tool-fs.mjs";

let passed = 0;
async function ok(name, fn) {
	await fn();
	passed += 1;
	console.log(`  ok ${name}`);
}

// ---- fake observation policy over the fs/waterfall/emit contract ----
function makeFakeCtx() {
	const observed = new Map(); // targetKey -> version
	const disk = new Map(); // targetKey -> { content, version, style }
	let versionCounter = 100;
	const ctx = {
		commands: { registered: [], register(def) { ctx.commands.registered.push(def); return () => {}; } },
		tools: { registered: [], register(tool) { ctx.tools.registered.push(tool); return () => {}; } },
		systemPrompt: { section() {} },
		inject(_deps, _cb) { /* attachments never mounts */ },
		events: [],
		fs: {
			sandboxMode: undefined,
			async resolve(path) {
				return { displayPath: path, targetKey: `key:${path}` };
			},
			async stat(target) {
				const rec = disk.get(target.targetKey);
				return rec === void 0 ? void 0 : { version: rec.version, type: "file", size: rec.content.length };
			},
			async readText(target) {
				const rec = disk.get(target.targetKey);
				if (rec === void 0) throw new Error("no file");
				return rec.content; // raw text, line endings intact (mirrors readWholeText)
			},
			async writeText(target, content, intent) {
				const rec = disk.get(target.targetKey);
				if (intent?.kind === "replaceIfVersion") {
					if (rec === void 0) throw new FsError("FS_STALE_VERSION: file gone", "FS_STALE_VERSION");
					if (rec.version !== intent.version) throw new FsError(`FS_STALE_VERSION: file changed since it was read (expected ${intent.version}, got ${rec.version})`, "FS_STALE_VERSION");
				} else if (intent?.kind === "createIfAbsent" && rec !== void 0) {
					throw new FsError("FS_NOT_OBSERVED: cannot overwrite existing without reading it first", "FS_NOT_OBSERVED");
				}
				versionCounter += 1;
				const style = content.includes("\r\n") ? "CRLF" : "LF";
				const next = { content, version: `v${versionCounter}`, style };
				disk.set(target.targetKey, next);
				return { operation: rec === void 0 ? "create" : "update", version: next.version, before: rec?.content ?? null, after: content };
			},
			async editText(target, edit, _intent) {
				const rec = disk.get(target.targetKey);
				if (rec === void 0) throw new Error("FS_STALE_VERSION: file changed since it was read");
				const oldNorm = edit.oldString.replace(/\r\n/g, "\n");
				const newNorm = edit.newString.replace(/\r\n/g, "\n");
				const norm = rec.style === "CRLF" ? rec.content.replace(/\r\n/g, "\n") : rec.content;
				if (!norm.includes(oldNorm)) throw new Error("FS_EDIT_NOT_FOUND");
				const edited = norm.replace(oldNorm, newNorm);
				versionCounter += 1;
				const style = rec.style;
				const next = { content: style === "CRLF" ? edited.replace(/\n/g, "\r\n") : edited, version: `v${versionCounter}`, style };
				disk.set(target.targetKey, next);
				return { version: next.version, before: norm, after: edited };
			}
		},
		waterfall(name, target, _actor, next) {
			if (name !== "fs/write-intent") return Promise.resolve(next ? next() : void 0);
			const prior = observed.get(target.targetKey);
			return Promise.resolve(prior !== void 0 ? { kind: "replaceIfVersion", version: prior } : { kind: "createIfAbsent" });
		},
		emit(name, target, observation) {
			if (name === "fs/observed" && observation.kind === "present") observed.set(target.targetKey, observation.version);
		}
	};
	return { ctx, disk, observed };
}

const { ctx, disk, observed } = makeFakeCtx();

// seed the file on disk (CRLF style) and a prior observation (the edit just happened)
disk.set("key:app.js", { content: "line1\r\nline2\r\nCHANGED\r\nline4", version: "v101", style: "CRLF" });
observed.set("key:app.js", "v101");

// the session log carries the edit's tool/result with the revert basis
const session = {
	header: { cwd: "/ws" },
	events: [{
		type: "tool/result",
		data: {
			message: { source: { kind: "tool", callId: "call_edit_1" } },
			meta: {
				diffs: [{ path: "app.js", oldText: "line1\nline2\nline4", newText: "line1\nline2\nCHANGED\nline4" }],
				revert: { path: "app.js", before: "line1\nline2\nline4" }
			}
		}
	}]
};

// run the plugin apply: captures tool + command registrations
toolFs.apply(ctx, toolFs.Config({}));
assert.equal(ctx.tools.registered.length >= 3, true, "read/write/edit registered");
const revertCommand = ctx.commands.registered.find((c) => c.name === "fs_revert");
ok("apply registers /fs_revert command", () => {
	assert.ok(revertCommand !== void 0, "fs_revert registered");
});

const agent = { session };
const handler = revertCommand.handler;

await ok("handler rejects empty input", async () => {
	const out = await handler({ agent, rawInput: "   ", signal: { aborted: false } });
	assert.equal(out.kind, "error");
});

await ok("handler rejects unknown callId", async () => {
	const out = await handler({ agent, rawInput: "call_nope", signal: { aborted: false } });
	assert.equal(out.kind, "error");
	assert.match(out.text, /no revertible/);
});

await ok("handler restores content, preserves CRLF, re-observes", async () => {
	const out = await handler({ agent, rawInput: "call_edit_1", signal: { aborted: false } });
	assert.equal(out.kind, "success", JSON.stringify(out));
	assert.match(out.text, /Reverted app\.js/);
	const rec = disk.get("key:app.js");
	assert.equal(rec.content, "line1\r\nline2\r\nline4", "CRLF style preserved on revert");
	assert.equal(observed.get("key:app.js"), rec.version, "revert re-observes the new version");
});

await ok("handler fails cleanly when the file changed since (stale version)", async () => {
	// simulate an external change after the revert: disk version moves past observed
	disk.set("key:app.js", { content: "line1\r\nOTHER\r\nline4", version: "v999", style: "CRLF" });
	const out = await handler({ agent, rawInput: "call_edit_1", signal: { aborted: false } });
	assert.equal(out.kind, "error");
	assert.match(out.text, /re-read the file/); // remediated FS_STALE_VERSION
});

await ok("handler recovers from an unobserved file by observing then writing", async () => {
	// fresh target never seen by this session (e.g. a subagent's edit)
	disk.set("key:new.js", { content: "a\nb", version: "v500", style: "LF" });
	session.events.push({
		type: "tool/result",
		data: {
			message: { source: { kind: "tool", callId: "call_edit_2" } },
			meta: { revert: { path: "new.js", before: "a\nb\nc" } }
		}
	});
	const out = await handler({ agent, rawInput: "call_edit_2", signal: { aborted: false } });
	assert.equal(out.kind, "success", JSON.stringify(out));
	assert.equal(disk.get("key:new.js").content, "a\nb\nc");
	assert.equal(observed.get("key:new.js"), disk.get("key:new.js").version);
});

console.log(`\n${passed} assertions passed`);
