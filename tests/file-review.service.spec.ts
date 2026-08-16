import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FileReviewChange, FileReviewRequest } from '../src/change-types.ts'
import { FileReviewService, transformFile } from '../src/file-review-service.ts'
import { TYPERT } from '../src/typert.host.ts'
import { TYPERT_REMOTE } from '../src/remote.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-file-review-'))
  roots.push(root)
  return root
}

function fakeAgent(cwd: string): Agent {
  return {
    session: { header: { cwd } },
    runMaintenance: async task => task(new AbortController().signal),
  } as Agent
}

function change(path: string, oldText: string | null, newText: string): FileReviewChange {
  return { path, diffs: [{ path, oldText, newText }] }
}

async function status(
  agent: Agent,
  request: FileReviewRequest,
) {
  return FileReviewService.prototype.status.call({} as FileReviewService, agent, request)
}

async function applyChange(
  agent: Agent,
  request: FileReviewRequest,
) {
  return FileReviewService.prototype.apply.call({} as FileReviewService, agent, request)
}

describe('Host file-review change engine', () => {
  it('applies multi-hunk files forward and backward in the required order', () => {
    const file: FileReviewChange = {
      path: 'notes.txt',
      diffs: [
        { path: 'notes.txt', oldText: 'b', newText: 'B', oldStart: 2, newStart: 2 },
        { path: 'notes.txt', oldText: 'c', newText: 'C', oldStart: 3, newStart: 3 },
      ],
    }
    expect(transformFile('a\nb\nc\n', file, 'redo')).toBe('a\nB\nC\n')
    expect(transformFile('a\nB\nC\n', file, 'undo')).toBe('a\nb\nc\n')
  })

  it('uses a unique exact occurrence without positions and rejects ambiguity', () => {
    const file = change('notes.txt', 'before', 'after')
    expect(transformFile('x before y', file, 'redo')).toBe('x after y')
    expect(transformFile('before before', file, 'redo')).toBeNull()
  })

  it('locates inline fragments inside the recorded line and falls back to a unique match', () => {
    const inline = {
      path: 'app.ts',
      diffs: [{ path: 'app.ts', oldText: 'foo', newText: 'bar', oldStart: 2, newStart: 2 }],
    }
    // The source is mid-line, so the recorded line does not start with it;
    // the inline-fragment match must find it inside the line.
    expect(transformFile('a\nhello foo world\nc\n', inline, 'redo'))
      .toBe('a\nhello bar world\nc\n')
    expect(transformFile('a\nhello bar world\nc\n', inline, 'undo'))
      .toBe('a\nhello foo world\nc\n')
    // A wrong recorded line still resolves through the unique full-text match.
    const offByOne = {
      path: 'app.ts',
      diffs: [{ path: 'app.ts', oldText: 'uniqueToken', newText: 'changed', oldStart: 9, newStart: 9 }],
    }
    expect(transformFile('x\nuniqueToken\ny\n', offByOne, 'redo'))
      .toBe('x\nchanged\ny\n')
    // Ambiguity is still refused: two occurrences cannot be disambiguated.
    const ambiguous = {
      path: 'app.ts',
      diffs: [{ path: 'app.ts', oldText: 'token', newText: 'changed', oldStart: 9, newStart: 9 }],
    }
    expect(transformFile('token token\n', ambiguous, 'redo')).toBeNull()
  })

  it('reports inline-fragment edits as applied and undoes them', async () => {
    const root = await workspace()
    const filename = join(root, 'app.ts')
    await writeFile(filename, 'a\nhello bar world\nc\n')
    const edit: FileReviewChange = {
      path: 'app.ts',
      diffs: [{ path: 'app.ts', oldText: 'foo', newText: 'bar', oldStart: 2, newStart: 2 }],
    }
    const agent = fakeAgent(root)
    expect((await status(agent, { action: 'undo', files: [edit] })).files[0].state)
      .toBe('applied')
    expect((await applyChange(agent, { action: 'undo', files: [edit] })).files[0].state)
      .toBe('undone')
    expect(await readFile(filename, 'utf8')).toBe('a\nhello foo world\nc\n')
    expect((await applyChange(agent, { action: 'redo', files: [edit] })).files[0].state)
      .toBe('applied')
    expect(await readFile(filename, 'utf8')).toBe('a\nhello bar world\nc\n')
  })

  it('undoes str_replace_editor insert hunks (old text is an empty anchor)', async () => {
    // str_replace_editor's `insert` produces oldText "" anchored at the line
    // after insert_line; undo deletes the inserted text, redo re-inserts it.
    const insert = {
      path: 'notes.txt',
      diffs: [{ path: 'notes.txt', oldText: '', newText: 'X\n', oldStart: 2, newStart: 2 }],
    }
    expect(transformFile('a\nb\nc\n', insert, 'redo')).toBe('a\nX\nb\nc\n')
    expect(transformFile('a\nX\nb\nc\n', insert, 'undo')).toBe('a\nb\nc\n')

    const root = await workspace()
    const filename = join(root, 'notes.txt')
    await writeFile(filename, 'a\nX\nb\nc\n')
    const agent = fakeAgent(root)
    expect((await status(agent, { action: 'undo', files: [insert] })).files[0].state)
      .toBe('applied')
    expect((await applyChange(agent, { action: 'undo', files: [insert] })).files[0].state)
      .toBe('undone')
    expect(await readFile(filename, 'utf8')).toBe('a\nb\nc\n')
    // Already-undone files read as undone instead of a false conflict.
    expect((await status(agent, { action: 'undo', files: [insert] })).files[0].state)
      .toBe('undone')
  })

  it('resolves LF-recorded hunks against CRLF files', async () => {
    // `edit`-style diffs carry LF text with no line numbers; a CRLF file on
    // disk must still match through the CRLF spelling of the hunk.
    const edit = {
      path: 'app.ts',
      diffs: [{ path: 'app.ts', oldText: 'a\nb', newText: 'a\nc' }],
    }
    expect(transformFile('a\r\nc\r\nx\r\n', edit, 'undo')).toBe('a\r\nb\r\nx\r\n')
    expect(transformFile('a\r\nb\r\nx\r\n', edit, 'redo')).toBe('a\r\nc\r\nx\r\n')

    const root = await workspace()
    const filename = join(root, 'app.ts')
    await writeFile(filename, 'a\r\nc\r\nx\r\n')
    const agent = fakeAgent(root)
    expect((await status(agent, { action: 'undo', files: [edit] })).files[0].state)
      .toBe('applied')
    expect((await applyChange(agent, { action: 'undo', files: [edit] })).files[0].state)
      .toBe('undone')
    expect(await readFile(filename, 'utf8')).toBe('a\r\nb\r\nx\r\n')
  })

  it('changes safe files independently while skipping conflicts and unsupported diffs', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'A')
    await writeFile(join(root, 'b.txt'), 'someone else changed this')
    await writeFile(join(root, 'created.txt'), 'new')
    const agent = fakeAgent(root)
    const request: FileReviewRequest = {
      action: 'undo',
      files: [
        change('a.txt', 'a', 'A'),
        change('b.txt', 'b', 'B'),
        change('created.txt', null, 'new'),
      ],
    }

    const result = await applyChange(agent, request)
    expect(result.files).toEqual([
      { path: 'a.txt', state: 'undone', changed: true },
      expect.objectContaining({ path: 'b.txt', state: 'conflict', changed: false }),
      // A created file whose content matches is deleted by undo.
      { path: 'created.txt', state: 'undone', changed: true },
    ])
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('a')
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('someone else changed this')
    await expect(readFile(join(root, 'created.txt'), 'utf8')).rejects.toThrow()

    const redone = await applyChange(agent, { ...request, action: 'redo' })
    expect(redone.files[0]).toEqual({ path: 'a.txt', state: 'applied', changed: true })
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('A')
    // A deleted created file cannot be recreated.
    expect(redone.files[2]).toEqual(expect.objectContaining({
      path: 'created.txt', state: 'unsupported', changed: false,
    }))
  })

  it('derives applied, undone, conflict, and unsupported status from disk', async () => {
    const root = await workspace()
    await writeFile(join(root, 'applied.txt'), 'new')
    await writeFile(join(root, 'undone.txt'), 'old')
    await writeFile(join(root, 'conflict.txt'), 'other')
    await writeFile(join(root, 'unknown.txt'), 'new')
    await writeFile(join(root, 'noop.txt'), 'x')
    const result = await status(fakeAgent(root), {
      action: 'undo',
      files: [
        change('applied.txt', 'old', 'new'),
        change('undone.txt', 'old', 'new'),
        change('conflict.txt', 'old', 'new'),
        change('unknown.txt', null, 'new'),
        change('noop.txt', 'x', 'x'),
      ],
    })
    expect(result.files.map(file => file.state))
      .toEqual(['applied', 'undone', 'conflict', 'applied', 'unsupported'])
  })

  it('rejects paths outside the workspace and symbolic links', async () => {
    const root = await workspace()
    await writeFile(join(root, 'target.txt'), 'new')
    await symlink(join(root, 'target.txt'), join(root, 'link.txt'))
    const result = await status(fakeAgent(root), {
      action: 'undo',
      files: [change('/etc/hosts', 'old', 'new'), change('link.txt', 'old', 'new')],
    })
    expect(result.files).toEqual([
      expect.objectContaining({ state: 'error', reason: 'path is outside the session workspace' }),
      expect.objectContaining({ state: 'error', reason: 'symbolic links are not supported' }),
    ])
  })

  it('deletes a created file on undo and reports it undone when missing', async () => {
    const root = await workspace()
    const filename = join(root, 'created.txt')
    await writeFile(filename, 'hello')
    const agent = fakeAgent(root)
    const created = change('created.txt', null, 'hello')

    // Present and matching → applied; undo deletes it.
    expect((await status(agent, { action: 'undo', files: [created] })).files[0])
      .toEqual({ path: 'created.txt', state: 'applied', changed: false })
    expect((await applyChange(agent, { action: 'undo', files: [created] })).files[0])
      .toEqual({ path: 'created.txt', state: 'undone', changed: true })
    await expect(readFile(filename, 'utf8')).rejects.toThrow()
    // Missing → undone; a repeated undo is an idempotent no-op.
    expect((await status(agent, { action: 'undo', files: [created] })).files[0])
      .toEqual({ path: 'created.txt', state: 'undone', changed: false })
    expect((await applyChange(agent, { action: 'undo', files: [created] })).files[0])
      .toEqual({ path: 'created.txt', state: 'undone', changed: false })
    // Redo cannot recreate a deleted file.
    expect((await applyChange(agent, { action: 'redo', files: [created] })).files[0])
      .toEqual(expect.objectContaining({ path: 'created.txt', state: 'unsupported', changed: false }))
  })

  it('refuses to delete a created file whose content changed after the turn', async () => {
    const root = await workspace()
    const filename = join(root, 'created.txt')
    await writeFile(filename, 'modified by hand')
    const result = await applyChange(fakeAgent(root), {
      action: 'undo', files: [change('created.txt', null, 'original')],
    })
    expect(result.files[0]).toEqual(expect.objectContaining({
      path: 'created.txt', state: 'conflict', changed: false,
    }))
    expect(await readFile(filename, 'utf8')).toBe('modified by hand')
  })

  it('deletes a created file only when the full recorded change matches', async () => {
    // Created and then edited in one turn: the safe-delete check replays the
    // creation and later edits to derive the exact expected content.
    const root = await workspace()
    const filename = join(root, 'notes.txt')
    await writeFile(filename, 'a\nB\nc\n')
    const file: FileReviewChange = {
      path: 'notes.txt',
      diffs: [
        { path: 'notes.txt', oldText: null, newText: 'a\nb\nc\n' },
        { path: 'notes.txt', oldText: 'b', newText: 'B', oldStart: 2, newStart: 2 },
      ],
    }
    expect((await status(fakeAgent(root), { action: 'undo', files: [file] })).files[0])
      .toEqual({ path: 'notes.txt', state: 'applied', changed: false })
    expect((await applyChange(fakeAgent(root), { action: 'undo', files: [file] })).files[0])
      .toEqual({ path: 'notes.txt', state: 'undone', changed: true })
    await expect(readFile(filename, 'utf8')).rejects.toThrow()
  })

  it('preserves file permissions across atomic replacement', async () => {
    const root = await workspace()
    const filename = join(root, 'script.sh')
    await writeFile(filename, 'NEW')
    await chmod(filename, 0o640)
    await applyChange(fakeAgent(root), {
      action: 'undo', files: [change('script.sh', 'OLD', 'NEW')],
    })
    expect(await readFile(filename, 'utf8')).toBe('OLD')
    // Windows has no POSIX permission bits (`chmod` is a no-op there), so the
    // mode-preservation assertion is meaningful on POSIX systems only.
    if (process.platform !== 'win32') {
      expect((await lstat(filename)).mode & 0o777).toBe(0o640)
    }
  })

  it('reports non-UTF-8 files and rejects sessions without a workspace', async () => {
    const root = await workspace()
    await writeFile(join(root, 'binary.txt'), new Uint8Array([0xff, 0xfe]))
    const result = await status(fakeAgent(root), {
      action: 'undo', files: [change('binary.txt', 'old', 'new')],
    })
    expect(result.files[0]).toEqual(expect.objectContaining({
      state: 'error', reason: 'file is not valid UTF-8 text',
    }))
    await expect(status(fakeAgent(''), {
      action: 'undo', files: [change('a.txt', 'old', 'new')],
    })).rejects.toThrow('session has no workspace directory')
  })

  it('does not enter file mutation while the Agent is busy', async () => {
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'new')
    const agent = {
      session: { header: { cwd: root } },
      runMaintenance: () => { throw new Error('agent is busy') },
    } as unknown as Agent
    await expect(applyChange(agent, {
      action: 'undo', files: [change('a.txt', 'old', 'new')],
    })).rejects.toThrow('agent is busy')
    expect(await readFile(join(root, 'a.txt'), 'utf8')).toBe('new')
  })

  it('publishes matching strict Host and client Remote descriptors', () => {
    expect(TYPERT.invocations.map(item => item.method)).toEqual(['status', 'apply'])
    expect(TYPERT_REMOTE.descriptors).toEqual(TYPERT.invocations)
    expect(TYPERT.invocations.every(item => item.scope?.context === 'agent')).toBe(true)
  })
})
