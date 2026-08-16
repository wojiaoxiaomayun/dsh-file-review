import assert from "node:assert/strict";
import * as toolFs from "./tool-fs.mjs";

let passed = 0;
function ok(name, fn) {
	fn();
	passed += 1;
	console.log(`  ok ${name}`);
}

console.log("== dsh-tool-fs revert helpers ==");

// 1. revertFromMeta narrowing
ok("revertFromMeta(undefined) -> undefined", () => {
	assert.equal(toolFs.revertFromMeta(undefined), undefined);
});
ok("revertFromMeta without revert field -> undefined", () => {
	assert.equal(toolFs.revertFromMeta({ diffs: [] }), undefined);
});
ok("revertFromMeta valid -> {path,before}", () => {
	assert.deepEqual(toolFs.revertFromMeta({ diffs: [], revert: { path: "a.txt", before: "old\ncontent" } }), { path: "a.txt", before: "old\ncontent" });
});
ok("revertFromMeta path non-string -> undefined", () => {
	assert.equal(toolFs.revertFromMeta({ revert: { path: 5, before: "x" } }), undefined);
});
ok("revertFromMeta before missing -> undefined", () => {
	assert.equal(toolFs.revertFromMeta({ revert: { path: "a.txt" } }), undefined);
});
ok("revertFromMeta revert array -> undefined", () => {
	assert.equal(toolFs.revertFromMeta({ revert: ["a.txt", "x"] }), undefined);
});

// 2. findRevertBasis over a synthetic session log
const session = {
	events: [
		{ type: "user/message", seq: 0, data: {} },
		{ type: "tool/result", seq: 1, data: {
			turn: 0, step: 0,
			message: { source: { kind: "tool", callId: "call_edit_1" } },
			meta: { diffs: [{ path: "a.txt", oldText: "old", newText: "new" }], revert: { path: "a.txt", before: "old\ncontent" } }
		} },
		{ type: "tool/result", seq: 2, data: {
			turn: 0, step: 0,
			message: { source: { kind: "tool", callId: "call_edit_bad" } },
			meta: { revert: null }
		} },
		{ type: "tool/result", seq: 3, data: {
			turn: 0, step: 0,
			message: { source: { kind: "tool", callId: "call_write_create" } },
			meta: { diffs: [] }
		} },
		{ type: "assistant/message", seq: 4, data: {} }
	]
};
ok("findRevertBasis finds recorded basis by callId", () => {
	assert.deepEqual(toolFs.findRevertBasis(session, "call_edit_1"), { path: "a.txt", before: "old\ncontent" });
});
ok("findRevertBasis skips malformed revert meta", () => {
	assert.equal(toolFs.findRevertBasis(session, "call_edit_bad"), undefined);
});
ok("findRevertBasis returns undefined for create (no revert meta)", () => {
	assert.equal(toolFs.findRevertBasis(session, "call_write_create"), undefined);
});
ok("findRevertBasis returns undefined for unknown callId", () => {
	assert.equal(toolFs.findRevertBasis(session, "call_nope"), undefined);
});
ok("findRevertBasis tolerates a missing session", () => {
	assert.equal(toolFs.findRevertBasis(undefined, "call_edit_1"), undefined);
});
ok("findRevertBasis does not confuse a same-id tool/call event", () => {
	const tricky = { events: [{ type: "tool/call", data: { callId: "call_x" } }, { type: "tool/result", data: { message: { source: { callId: "call_x" } }, meta: { revert: { path: "b.txt", before: "z" } } } }] };
	assert.deepEqual(toolFs.findRevertBasis(tricky, "call_x"), { path: "b.txt", before: "z" });
});

// 3. parseRevertCallId
ok("parseRevertCallId trims", () => {
	assert.equal(toolFs.parseRevertCallId("  call_abc  "), "call_abc");
});
ok("parseRevertCallId empty -> empty", () => {
	assert.equal(toolFs.parseRevertCallId("   "), "");
	assert.equal(toolFs.parseRevertCallId(undefined), "");
});

// 4. line-ending helpers
ok("detectLineEndings CRLF", () => {
	assert.equal(toolFs.detectLineEndings("a\r\nb\r\nc"), "CRLF");
});
ok("detectLineEndings LF", () => {
	assert.equal(toolFs.detectLineEndings("a\nb\nc"), "LF");
});
ok("detectLineEndings mixed majority LF", () => {
	assert.equal(toolFs.detectLineEndings("a\r\nb\nc\n"), "LF");
});
ok("restoreLineEndings LF passthrough", () => {
	assert.equal(toolFs.restoreLineEndings("a\nb", "LF"), "a\nb");
});
ok("restoreLineEndings CRLF conversion", () => {
	assert.equal(toolFs.restoreLineEndings("a\nb", "CRLF"), "a\r\nb");
});

// 5. module surface: the new exports exist, original ones intact
ok("exports include revert helpers and originals", () => {
	assert.equal(typeof toolFs.findRevertBasis, "function");
	assert.equal(typeof toolFs.revertFromMeta, "function");
	assert.equal(typeof toolFs.parseRevertCallId, "function");
	assert.equal(typeof toolFs.detectLineEndings, "function");
	assert.equal(typeof toolFs.restoreLineEndings, "function");
	assert.equal(typeof toolFs.apply, "function");
	assert.equal(typeof toolFs.Config, "function");
	assert.deepEqual(Array.from(toolFs.inject).sort(), ["commands", "fs", "systemPrompt", "tools"]);
});

// 6. Config carries the new revertMaxBytes default
ok("Config defaults revertMaxBytes to 1 MiB", () => {
	const parsed = toolFs.Config({});
	assert.equal(parsed.revertMaxBytes, 1024 * 1024);
	assert.equal(parsed.readLimit, 2e3);
});

console.log(`\n${passed} assertions passed`);
