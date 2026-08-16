// @vitest-environment jsdom
/**
 * dsh-file-review browser half: the derivation contract of
 * `producedForClosing` over engine-published Turn data, the row's rendering
 * and opener wiring, plus the plugin's public service registrations.
 */
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ConversationEventInput, ConversationLocationDataStore, ConversationMatch,
  ConversationTurnDataMap, ToolResultNode, TurnLocation,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ChatFileMentions, TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { ProducedFiles } from '../src/client/ProducedFiles.tsx'
import { summarizeDiffs, unifiedDiffText } from '../src/client/UnifiedDiff.tsx'
import {
  basename, deliverablesDefinition, producedFileMentions, producedForClosing, reviewsForClosing,
  selectProducedFiles, type DeliverablesTurnData, type ProducedFileDiff, type ProducedFileReview,
} from '../src/client/turn-deliverables.ts'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

class TestTurnDataStore implements ConversationLocationDataStore<ConversationTurnDataMap> {
  private readonly values = new Map<string, unknown>()

  get<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
  ): Readonly<ConversationTurnDataMap[Key]> | undefined {
    return this.values.get(key) as Readonly<ConversationTurnDataMap[Key]> | undefined
  }

  set<Key extends Extract<keyof ConversationTurnDataMap, string>>(
    key: Key,
    value: ConversationTurnDataMap[Key],
  ): void {
    this.values.set(key, value)
  }
}

const turnLocation = (turn: number, deliverables?: DeliverablesTurnData): TurnLocation => {
  const data = new TestTurnDataStore()
  if (deliverables !== undefined) data.set('deliverables', deliverables)
  return { turn, start: undefined, end: undefined, status: 'closed', steps: [], data }
}

const produced = (
  ...values: ReadonlyArray<readonly [seq: number, path: string, diffs?: readonly ProducedFileDiff[]]>
): DeliverablesTurnData => ({
  produced: values.map(([seq, path, diffs = []]) => ({ seq, path, diffs })),
})

const fileReview = (
  path: string,
  diffs: readonly ProducedFileDiff[] = [],
  sources?: readonly string[],
): ProducedFileReview => ({
  path,
  diffs,
  ...(sources === undefined ? {} : { sources }),
})

const reviews = (paths: readonly string[]): readonly ProducedFileReview[] => paths.map((path, index) =>
  fileReview(path, index === 0
    ? [{ path, oldText: 'before', newText: 'after', oldStart: 7, newStart: 7 }]
    : []))

function tailOwner(
  data: DeliverablesTurnData | undefined,
  seq: number,
  openFile: (path: string) => void = () => {},
  turn = 1,
): TurnTailOwnerProps {
  return { seq, openFile, turn: turnLocation(turn, data) }
}

function at(
  seq: number,
  type: string,
  data: unknown,
  view?: ConversationEventInput['view'],
): ConversationEventInput {
  return {
    event: {
      seq, time: seq * 1_000, type, data,
      ...(type === 'tool/result' ? { surfaceOp: 'append' } : {}),
    } as ConversationEventInput['event'],
    view,
  }
}

function matched(input: ConversationEventInput, role: ConversationMatch['role']): ConversationMatch {
  return { ...input, role, location: { kind: 'unresolved' } }
}

function call(
  seq: number,
  callId: string,
  view: ToolResultNode['callView'],
  turn = 1,
): ConversationEventInput {
  return at(
    seq,
    'tool/call',
    { turn, step: 1, callId, name: 'fixture', argsRaw: '{}' },
    { for: 'call', view: view ?? { card: 'generic', title: 'fixture' } },
  )
}

function result(
  seq: number,
  callId: string,
  isError = false,
  turn = 1,
  view?: NonNullable<ToolResultNode['resultView']>,
): ConversationEventInput {
  return at(seq, 'tool/result', {
    turn,
    step: 1,
    message: {
      source: { type: 'tool-result', callId },
      content: [{ type: 'tool-result', content: [], isError }],
    },
  }, view === undefined ? undefined : { for: 'result', view })
}

function diff(...paths: string[]): ToolResultNode['callView'] {
  return {
    card: 'diff', title: `Write ${paths[0] ?? ''}`,
    diffs: paths.map(path => ({ path, oldText: null, newText: 'x' })),
    locations: paths.map(path => ({ path })),
  }
}

function edit(path: string): ToolResultNode['callView'] {
  return { card: 'generic', title: `insert ${path}`, kind: 'edit', locations: [{ path }] }
}

function appliedDiff(
  ...diffs: ReadonlyArray<readonly [
    path: string, oldText: string | null, newText: string, oldStart?: number, newStart?: number,
  ]>
): NonNullable<ToolResultNode['resultView']> {
  return {
    card: 'diff',
    diffs: diffs.map(([path, oldText, newText, oldStart, newStart]) => ({
      path,
      oldText,
      newText,
      ...(oldStart === undefined ? {} : { oldStart }),
      ...(newStart === undefined ? {} : { newStart }),
    })),
  }
}

/** Drive the package definition directly through the public definition callbacks. */
function fold(entries: readonly ConversationEventInput[]): Readonly<DeliverablesTurnData> | undefined {
  const [first, ...updates] = entries
  if (first === undefined) return undefined
  const start = matched(first, 'start')
  const base = {
    key: 'deliverables:1', kind: 'deliverables', id: '1', matches: [start],
    start, state: undefined, current: new Map(),
  } as Parameters<typeof deliverablesDefinition.start>[0]
  const reader: Parameters<typeof deliverablesDefinition.start>[2] = { previous: () => undefined }
  let state = deliverablesDefinition.start(base, start, reader)
  for (const input of updates) {
    const candidate = deliverablesDefinition.match(input.event)
    if (candidate === null || candidate.role !== 'update') continue
    const match = matched(input, candidate.role)
    state = deliverablesDefinition.update({ ...base, state }, match, reader)
  }
  const location = deliverablesDefinition.buildLocationData({ ...base, state }, 'turn')
  return location?.kind === 'turn' ? location.value as DeliverablesTurnData : undefined
}

function makeTranslate(...dicts: readonly Record<string, string>[]) {
  return (key: string, params?: Record<string, unknown>): string => {
    const template = dicts.find(dict => dict[key] !== undefined)?.[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in params ? String(params[name]) : match)
  }
}

describe('produced-file Turn data', () => {
  it('deduplicates paths in first-seen order and stops at the closing Assistant seq', () => {
    const data = produced(
      [3, 'out/index.html'],
      [4, 'out/app.css'],
      [4, 'out/index.html'],
      [8, 'after.txt'],
    )
    expect(producedForClosing(data, 6)).toEqual(['out/index.html', 'out/app.css'])
    expect(reviewsForClosing(data, 6)).toEqual([
      fileReview('out/index.html'), fileReview('out/app.css'),
    ])
    expect(selectProducedFiles(tailOwner(data, 6))).toEqual([
      fileReview('out/index.html'), fileReview('out/app.css'),
    ])
    expect(producedForClosing(undefined)).toEqual([])
    expect(selectProducedFiles(tailOwner(undefined, 9, () => {}, 2))).toBeNull()
  })

  it('folds successful diff and generic-edit calls while ignoring reads, failures, and missing locations', () => {
    const value = fold([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'write', diff('out/index.html', 'out/app.css')),
      result(3, 'write', false, 1, appliedDiff(
        ['out/index.html', 'old html', 'new html'],
        ['out/app.css', 'old css', 'new css'],
      )),
      call(4, 'edit', edit('notes.md')),
      result(5, 'edit'),
      call(6, 'read', { card: 'generic', title: 'Read', locations: [{ path: 'input.txt' }] }),
      result(7, 'read'),
      call(8, 'failed', diff('broken.txt')),
      result(9, 'failed', true),
      call(10, 'locationless', { card: 'diff', title: 'Write', diffs: [] }),
      result(11, 'locationless'),
    ])

    expect(producedForClosing(value)).toEqual([
      'out/index.html', 'out/app.css', 'notes.md',
    ])
    expect(reviewsForClosing(value)).toEqual([
      fileReview('out/index.html', [{ path: 'out/index.html', oldText: 'old html', newText: 'new html' }], ['fixture']),
      fileReview('out/app.css', [{ path: 'out/app.css', oldText: 'old css', newText: 'new css' }], ['fixture']),
      fileReview('notes.md', [], ['fixture']),
    ])
  })

  it('appends same-file hunks in settlement order and uses call intent only without a result view', () => {
    const value = fold([
      at(1, 'turn/start', { turn: 1 }),
      call(2, 'first', diff('same.txt')),
      result(3, 'first'),
      call(4, 'second', diff('same.txt')),
      result(5, 'second', false, 1, appliedDiff(['same.txt', 'middle', 'after', 12, 12])),
      call(6, 'malformed', diff('broken.txt')),
      result(7, 'malformed', false, 1, {
        card: 'diff', diffs: [{ path: 'broken.txt', oldText: 'a', newText: 'b', oldStart: 0 }],
      } as never),
    ])

    expect(reviewsForClosing(value)).toEqual([
      fileReview('same.txt', [
        { path: 'same.txt', oldText: null, newText: 'x' },
        { path: 'same.txt', oldText: 'middle', newText: 'after', oldStart: 12, newStart: 12 },
      ], ['fixture']),
      // The malformed result view falls back to the call view's hunks.
      fileReview('broken.txt', [{ path: 'broken.txt', oldText: null, newText: 'x' }], ['fixture']),
    ])
  })

  it('reconstructs insert diffs from str_replace_editor call arguments', () => {
    const insertCall = at(2, 'tool/call', {
      turn: 1, step: 1, callId: 'ins', name: 'str_replace_editor',
      argsRaw: JSON.stringify({
        command: 'insert', path: 'src/app.ts', insert_line: 3, new_str: 'const x = 1;\n',
      }),
    }, {
      for: 'call',
      view: {
        card: 'generic', title: 'insert src/app.ts', kind: 'edit',
        locations: [{ path: 'src/app.ts' }],
      },
    })
    const value = fold([
      at(1, 'turn/start', { turn: 1 }),
      insertCall,
      result(3, 'ins'),
    ])

    expect(producedForClosing(value)).toEqual(['src/app.ts'])
    expect(reviewsForClosing(value)).toEqual([
      fileReview('src/app.ts', [{
        path: 'src/app.ts', oldText: '', newText: 'const x = 1;\n', oldStart: 4, newStart: 4,
      }], ['insert']),
    ])
  })

  it('labels produced files with the tool commands that touched them', () => {
    const createCall = at(2, 'tool/call', {
      turn: 1, step: 1, callId: 'create', name: 'str_replace_editor',
      argsRaw: JSON.stringify({ command: 'create', path: 'src/app.ts', file_text: 'a\n' }),
    }, { for: 'call', view: diff('src/app.ts') })
    const insertCall = at(3, 'tool/call', {
      turn: 1, step: 1, callId: 'ins', name: 'str_replace_editor',
      argsRaw: JSON.stringify({ command: 'insert', path: 'src/app.ts', insert_line: 1, new_str: 'x\n' }),
    }, {
      for: 'call',
      view: { card: 'generic', title: 'insert src/app.ts', kind: 'edit', locations: [{ path: 'src/app.ts' }] },
    })
    const value = fold([
      at(1, 'turn/start', { turn: 1 }),
      createCall,
      result(4, 'create'),
      insertCall,
      result(5, 'ins'),
    ])
    const reviews = reviewsForClosing(value)
    expect(reviews).toHaveLength(1)
    expect(reviews[0]?.sources).toEqual(['create', 'insert'])
  })

  it('ignores non-insert str_replace_editor calls and malformed insert arguments', () => {
    const viewCall = at(2, 'tool/call', {
      turn: 1, step: 1, callId: 'view', name: 'str_replace_editor',
      argsRaw: JSON.stringify({ command: 'view', path: 'src/app.ts' }),
    }, {
      for: 'call',
      view: { card: 'generic', title: 'view src/app.ts', kind: 'read', locations: [{ path: 'src/app.ts' }] },
    })
    const malformed = at(3, 'tool/call', {
      turn: 1, step: 1, callId: 'bad', name: 'str_replace_editor',
      argsRaw: '{not json',
    }, {
      for: 'call',
      view: { card: 'generic', title: 'insert src/app.ts', kind: 'edit', locations: [{ path: 'src/app.ts' }] },
    })
    const value = fold([
      at(1, 'turn/start', { turn: 1 }),
      viewCall,
      result(4, 'view'),
      malformed,
      result(5, 'bad'),
    ])
    // A `view` reads nothing; a malformed `insert` still lists its path but
    // carries no reconstructable hunk.
    expect(producedForClosing(value)).toEqual(['src/app.ts'])
    expect(reviewsForClosing(value)).toEqual([fileReview('src/app.ts')])
  })

  it('ignores calls without mutation locations, orphan results, and replacement results', () => {
    const replacement = result(8, 'replacement')
    const value = fold([
      at(1, 'turn/start', { turn: 1 }),
      at(2, 'tool/call', { turn: 1, step: 1, callId: 'no-view', name: 'fixture', argsRaw: '{}' }),
      result(3, 'no-view'),
      call(4, 'locationless-edit', { card: 'generic', title: 'Edit', kind: 'edit' }),
      result(5, 'locationless-edit'),
      result(6, 'orphan'),
      call(7, 'replacement', diff('replaced.txt')),
      {
        ...replacement,
        event: {
          ...replacement.event,
          surfaceOp: { op: 'replace', start: 1, end: 1 },
        } as ConversationEventInput['event'],
      },
      call(9, 'malformed-locations', {
        card: 'diff', title: 'Write', diffs: [], locations: [null, { path: 4 }],
      } as never),
      result(10, 'malformed-locations'),
      at(11, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
    ])

    expect(producedForClosing(value)).toEqual([])
  })

  it('rejects an invalid start match and preserves state for an unrelated update', () => {
    const startMatch = matched(at(1, 'turn/start', { turn: 1 }), 'start')
    const emptyContext: Parameters<typeof deliverablesDefinition.start>[0] = {
      key: 'deliverables:1',
      kind: 'deliverables',
      id: '1',
      matches: [startMatch],
      start: startMatch,
      state: undefined,
      current: new Map(),
    }
    const reader: Parameters<typeof deliverablesDefinition.start>[2] = { previous: () => undefined }
    const state = deliverablesDefinition.start(emptyContext, startMatch, reader)
    const unrelated = matched(at(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }), 'update')
    const context: Parameters<typeof deliverablesDefinition.update>[0] = { ...emptyContext, state }

    expect(() => deliverablesDefinition.start(emptyContext, unrelated, reader))
      .toThrow('deliverables start requires turn/start')
    expect(deliverablesDefinition.update(context, unrelated)).toBe(state)
  })

})

describe('ProducedFiles review card', () => {
  const t = makeTranslate(en)
  const changedReviews: readonly ProducedFileReview[] = [
    fileReview('deep/a.html', [{
      path: 'deep/a.html', oldText: 'before\nkeep', newText: 'after\nkeep', oldStart: 7, newStart: 7,
    }]),
    fileReview('styles/b.css', [{
      path: 'styles/b.css', oldText: null, newText: 'one\ntwo', oldStart: 1, newStart: 1,
    }]),
  ]

  it('derives exact totals for replacements, additions, multiple hunks, and empty reviews', () => {
    expect(summarizeDiffs(changedReviews[0]?.diffs ?? [])).toEqual({ added: 1, removed: 1 })
    expect(summarizeDiffs(changedReviews[1]?.diffs ?? [])).toEqual({ added: 2, removed: 0 })
    expect(summarizeDiffs([])).toEqual({ added: 0, removed: 0 })
    expect(summarizeDiffs([
      { path: 'a.md', oldText: 'x', newText: 'y', oldStart: 1, newStart: 1 },
      { path: 'a.md', oldText: 'same', newText: 'same\nnew', oldStart: 8, newStart: 8 },
    ])).toEqual({ added: 2, removed: 1 })
    expect(unifiedDiffText(changedReviews.flatMap(review => review.diffs)))
      .toContain('styles/b.css\n+ one\n+ two')
  })

  it('shows the tool source badges on file rows and in the drawer header', () => {
    const withSource = fileReview(
      'src/app.ts',
      [{ path: 'src/app.ts', oldText: 'a', newText: 'b' }],
      ['insert'],
    )
    const view = render(<ProducedFiles matched={[withSource]} openFile={() => {}} t={t} />)
    const card = view.getByRole('region', { name: 'Edited files' })
    expect(within(card).getByText('insert')).toBeTruthy()
    expect(within(card).getByLabelText('Changed by: insert')).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: 'Review src/app.ts' }))
    const drawer = view.getByRole('dialog', { name: 'Review' })
    // One badge on the row, one on the drawer file header.
    expect(within(drawer).getAllByText('insert')).toHaveLength(1)
    expect(within(card).getAllByText('insert')).toHaveLength(1)
  })

  it('renders aggregate and per-file totals with a six-file preview', () => {
    const paths = ['deep/a.html', 'b.css', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']
    const view = render(<ProducedFiles matched={reviews(paths)} openFile={() => {}} t={t} />)
    const card = view.getByRole('region', { name: 'Edited files' })
    expect(within(card).getByText('Edited 7 files')).toBeTruthy()
    expect(within(card).getByRole('button', { name: '1 more file' })).toBeTruthy()
    // Header batch approve + batch undo, per shown row an open button plus
    // its approve and undo buttons, and the expandable "more files" row.
    expect(within(card).getAllByRole('button')).toHaveLength(21)
    expect(within(card).queryByRole('button', { name: 'Review g.ts' })).toBeNull()
    const first = within(card).getByRole('button', { name: 'Review deep/a.html' })
    expect(first.textContent).toContain('a.html')
    // The full path rides the row container's tooltip.
    expect(first.closest('div')?.getAttribute('title')).toBe('deep/a.html')
  })

  it('renders the active Web UI language after the locale changes', () => {
    let active = en
    const translate = (key: string, params?: Record<string, unknown>): string =>
      makeTranslate(active)(key, params)
    const view = render(
      <ProducedFiles matched={changedReviews} openFile={() => {}} t={translate} />,
    )

    expect(view.getByRole('region', { name: 'Edited files' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Approve all' })).toBeTruthy()
    expect(view.getByRole('button', { name: 'Undo all' })).toBeTruthy()

    active = zh
    view.rerender(<ProducedFiles matched={changedReviews} openFile={() => {}} t={translate} />)

    const card = view.getByRole('region', { name: '已编辑文件' })
    expect(within(card).getByText('已编辑 2 个文件')).toBeTruthy()
    expect(within(card).getByLabelText('新增 3 行，删除 1 行')).toBeTruthy()
    expect(within(card).getByRole('button', { name: '批量同意' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: '批量撤销' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: '同意 deep/a.html' })).toBeTruthy()
    expect(within(card).getByRole('button', { name: '撤销 deep/a.html' })).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: '审查 deep/a.html' }))

    const drawer = view.getByRole('dialog', { name: '审查' })
    expect(within(drawer).getByText('1 个文件')).toBeTruthy()
    expect(within(drawer).getByRole('button', { name: '复制差异' })).toBeTruthy()
    expect(within(drawer).getByRole('button', { name: '关闭' })).toBeTruthy()
    expect(within(drawer).getByRole('separator', { name: '调整审查面板大小' })).toBeTruthy()
    expect(within(drawer).getAllByRole('button', { name: '在编辑器中打开' })).toHaveLength(1)
  })

  it('disables the row undo once the file is undone and reports the restored state', async () => {
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.html', state: 'applied' as const, changed: false },
    ] }))
    const applyChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.html', state: 'undone' as const, changed: true },
    ] }))
    const view = render(
      <ProducedFiles
        matched={[changedReviews[0]!]}
        openFile={() => {}}
        inspectChanges={inspectChanges}
        applyChanges={applyChanges}
        t={t}
      />,
    )

    await vi.waitFor(() => {
      expect((view.getByRole('button', { name: 'Undo deep/a.html' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    const timeout = vi.spyOn(window, 'setTimeout')
    fireEvent.click(view.getByRole('button', { name: 'Undo deep/a.html' }))
    await vi.waitFor(() => {
      expect(view.getByRole('alert').textContent).toContain('File restored')
    })
    expect(timeout.mock.calls.some(([, delay]) => delay === 2000)).toBe(true)
    expect(applyChanges.mock.calls[0]?.[0].action).toBe('undo')
    expect(applyChanges.mock.calls[0]?.[0].files).toEqual([
      { path: 'deep/a.html', diffs: changedReviews[0]?.diffs },
    ])
    // No redo: an undone file's undo is disabled and explained.
    await vi.waitFor(() => {
      const button = view.getByRole('button', { name: 'Undo deep/a.html' }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('This file is already restored')
    })
  })

  it('reports a partial batch undo and disables Undo all when nothing is left', async () => {
    const twoReversible = [
      fileReview('deep/a.txt', [{ path: 'deep/a.txt', oldText: 'a', newText: 'A' }]),
      fileReview('nested/b.txt', [{ path: 'nested/b.txt', oldText: 'b', newText: 'B' }]),
    ]
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.txt', state: 'applied' as const, changed: false },
      { path: 'nested/b.txt', state: 'applied' as const, changed: false },
    ] }))
    const applyChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.txt', state: 'undone' as const, changed: true },
      { path: 'nested/b.txt', state: 'conflict' as const, changed: false },
    ] }))
    const openFile = vi.fn<(path: string) => void>()
    const view = render(
      <ProducedFiles
        matched={twoReversible}
        openFile={openFile}
        inspectChanges={inspectChanges}
        applyChanges={applyChanges}
        t={t}
      />,
    )
    await vi.waitFor(() => {
      expect((view.getByRole('button', { name: 'Undo all' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    const timeout = vi.spyOn(window, 'setTimeout')
    fireEvent.click(view.getByRole('button', { name: 'Undo all' }))
    await vi.waitFor(() => { expect(view.getByRole('alert')).toBeTruthy() })
    expect(applyChanges).toHaveBeenCalledOnce()
    expect(applyChanges.mock.calls[0]?.[0].action).toBe('undo')
    expect(applyChanges.mock.calls[0]?.[0].files).toHaveLength(2)
    const notice = view.getByRole('alert')
    expect(notice.textContent).toContain('Not all changes were restored')
    expect(notice.textContent).toContain('An error occurred while restoring some files')
    expect(notice.textContent).toContain('Skipped (1)')
    expect(notice.textContent).toContain('b.txt')
    expect(notice.textContent).not.toContain('nested/b.txt')
    expect(within(notice).queryByText('a.txt')).toBeNull()
    fireEvent.click(within(notice).getByRole('button', { name: 'Open b.txt' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('nested/b.txt')
    const autoClose = timeout.mock.calls.find(([, delay]) => delay === 5000)?.[0]
    expect(autoClose).toBeTypeOf('function')
    act(() => { if (typeof autoClose === 'function') autoClose() })
    expect(view.queryByRole('alert')).toBeNull()
    // a.txt is undone and b.txt is conflicted, so nothing is undoable left.
    await vi.waitFor(() => {
      const button = view.getByRole('button', { name: 'Undo all' }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('No safely reversible files are available in this change')
    })

    view.rerender(
      <ProducedFiles matched={[fileReview('notes.md')]} openFile={() => {}} t={t} />,
    )
    await vi.waitFor(() => {
      const button = view.getByRole('button', { name: 'Undo all' }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('No safely reversible files are available in this change')
    })
  })

  it('undoes a single file from its row, leaving other rows and the batch action alone', async () => {
    const twoReversible = [
      fileReview('deep/a.txt', [{ path: 'deep/a.txt', oldText: 'a', newText: 'A' }]),
      fileReview('nested/b.txt', [{ path: 'nested/b.txt', oldText: 'b', newText: 'B' }]),
    ]
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.txt', state: 'applied' as const, changed: false },
      { path: 'nested/b.txt', state: 'applied' as const, changed: false },
    ] }))
    const applyChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.txt', state: 'undone' as const, changed: true },
    ] }))
    const view = render(
      <ProducedFiles
        matched={twoReversible}
        openFile={() => {}}
        inspectChanges={inspectChanges}
        applyChanges={applyChanges}
        t={t}
      />,
    )

    await vi.waitFor(() => {
      expect((view.getByRole('button', { name: 'Undo deep/a.txt' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    fireEvent.click(view.getByRole('button', { name: 'Undo deep/a.txt' }))
    await vi.waitFor(() => {
      expect(view.getByRole('alert').textContent).toContain('File restored')
    })
    expect(applyChanges).toHaveBeenCalledOnce()
    expect(applyChanges.mock.calls[0]?.[0].action).toBe('undo')
    expect(applyChanges.mock.calls[0]?.[0].files).toEqual([
      { path: 'deep/a.txt', diffs: twoReversible[0]?.diffs },
    ])
    // The undone row locks; the untouched row and the batch action stay live.
    await vi.waitFor(() => {
      const done = view.getByRole('button', { name: 'Undo deep/a.txt' }) as HTMLButtonElement
      expect(done.disabled).toBe(true)
      expect(done.title).toBe('This file is already restored')
    })
    expect((view.getByRole('button', { name: 'Undo nested/b.txt' }) as HTMLButtonElement).disabled)
      .toBe(false)
    expect((view.getByRole('button', { name: 'Undo all' }) as HTMLButtonElement).disabled)
      .toBe(false)
  })

  it('approves a file, locks its undo, and approves every file from the header', async () => {
    const twoReversible = [
      fileReview('deep/a.txt', [{ path: 'deep/a.txt', oldText: 'a', newText: 'A' }]),
      fileReview('nested/b.txt', [{ path: 'nested/b.txt', oldText: 'b', newText: 'B' }]),
    ]
    const view = render(<ProducedFiles matched={twoReversible} openFile={() => {}} t={t} />)

    await vi.waitFor(() => {
      expect((view.getByRole('button', { name: 'Approve deep/a.txt' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    fireEvent.click(view.getByRole('button', { name: 'Approve deep/a.txt' }))
    await vi.waitFor(() => {
      const approved = view.getByRole('button', { name: 'Approve deep/a.txt' }) as HTMLButtonElement
      expect(approved.disabled).toBe(true)
      expect(approved.title).toBe('Approved')
    })
    // Approval locks the undo for that file only.
    await vi.waitFor(() => {
      const undo = view.getByRole('button', { name: 'Undo deep/a.txt' }) as HTMLButtonElement
      expect(undo.disabled).toBe(true)
      expect(undo.title).toBe('This file is approved and locked')
    })
    expect((view.getByRole('button', { name: 'Undo nested/b.txt' }) as HTMLButtonElement).disabled)
      .toBe(false)

    // Batch approval locks every file and disables both batch actions.
    fireEvent.click(view.getByRole('button', { name: 'Approve all' }))
    await vi.waitFor(() => {
      expect((view.getByRole('button', { name: 'Approve nested/b.txt' }) as HTMLButtonElement).disabled)
        .toBe(true)
    })
    expect((view.getByRole('button', { name: 'Undo nested/b.txt' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect((view.getByRole('button', { name: 'Approve all' }) as HTMLButtonElement).disabled)
      .toBe(true)
    expect((view.getByRole('button', { name: 'Undo all' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })

  it('expands and collapses the extra files at the bottom', () => {
    const paths = ['deep/a.html', 'b.css', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts']
    const view = render(<ProducedFiles matched={reviews(paths)} openFile={() => {}} t={t} />)
    const card = view.getByRole('region', { name: 'Edited files' })
    expect(within(card).queryByRole('button', { name: 'Review g.ts' })).toBeNull()

    const more = within(card).getByRole('button', { name: '1 more file' })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(more)
    expect(within(card).getByRole('button', { name: 'Review g.ts' })).toBeTruthy()
    const collapse = within(card).getByRole('button', { name: 'Collapse' })
    expect(collapse.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(collapse)
    expect(within(card).queryByRole('button', { name: 'Review g.ts' })).toBeNull()
    expect(within(card).getByRole('button', { name: '1 more file' })).toBeTruthy()
  })

  it('deletes a created file from its row', async () => {
    const createdReview = fileReview('out/new.txt', [
      { path: 'out/new.txt', oldText: null, newText: 'hello', oldStart: 1, newStart: 1 },
    ])
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'out/new.txt', state: 'applied' as const, changed: false },
    ] }))
    const applyChanges = vi.fn(async () => ({ files: [
      { path: 'out/new.txt', state: 'undone' as const, changed: true },
    ] }))
    const view = render(
      <ProducedFiles
        matched={[createdReview]}
        openFile={() => {}}
        inspectChanges={inspectChanges}
        applyChanges={applyChanges}
        t={t}
      />,
    )

    await vi.waitFor(() => {
      expect((view.getByRole('button', { name: 'Undo out/new.txt' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    fireEvent.click(view.getByRole('button', { name: 'Undo out/new.txt' }))
    await vi.waitFor(() => {
      expect(view.getByRole('alert').textContent).toContain('File deleted')
    })
    expect(applyChanges).toHaveBeenCalledOnce()
    expect(applyChanges.mock.calls[0]?.[0].action).toBe('undo')
    expect(applyChanges.mock.calls[0]?.[0].files).toEqual([
      { path: 'out/new.txt', diffs: createdReview.diffs },
    ])
    await vi.waitFor(() => {
      const button = view.getByRole('button', { name: 'Undo out/new.txt' }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('This file is already restored')
    })
  })

  it('includes created files in the batch undo', async () => {
    const mixed = [
      fileReview('a.txt', [{ path: 'a.txt', oldText: 'x', newText: 'X' }]),
      fileReview('new.txt', [{ path: 'new.txt', oldText: null, newText: 'hi' }]),
    ]
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'a.txt', state: 'applied' as const, changed: false },
      { path: 'new.txt', state: 'applied' as const, changed: false },
    ] }))
    const applyChanges = vi.fn(async () => ({ files: [
      { path: 'a.txt', state: 'undone' as const, changed: true },
      { path: 'new.txt', state: 'undone' as const, changed: true },
    ] }))
    const view = render(
      <ProducedFiles
        matched={mixed}
        openFile={() => {}}
        inspectChanges={inspectChanges}
        applyChanges={applyChanges}
        t={t}
      />,
    )
    await vi.waitFor(() => {
      expect((view.getByRole('button', { name: 'Undo all' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    fireEvent.click(view.getByRole('button', { name: 'Undo all' }))
    await vi.waitFor(() => { expect(view.getByRole('alert')).toBeTruthy() })
    expect(applyChanges).toHaveBeenCalledOnce()
    expect(applyChanges.mock.calls[0]?.[0].files).toHaveLength(2)
  })

  it('explains that a created-file hunk undoes only at file level', async () => {
    const createdReview = fileReview('out/new.txt', [
      { path: 'out/new.txt', oldText: null, newText: 'hello' },
    ])
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'out/new.txt', state: 'applied' as const, changed: false },
    ] }))
    const view = render(
      <ProducedFiles
        matched={[createdReview]}
        openFile={() => {}}
        inspectChanges={inspectChanges}
        t={t}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Review out/new.txt' }))
    const drawer = view.getByRole('dialog', { name: 'Review' })

    await vi.waitFor(() => {
      const hunk = within(drawer).getByRole('button', { name: 'Undo this change' }) as HTMLButtonElement
      expect(hunk.disabled).toBe(true)
      expect(hunk.title)
        .toBe('This change created the file; undo at the file level to delete it')
    })
    // The file-level undo stays available for the deletion.
    expect((within(drawer).getByRole('button', { name: 'Undo out/new.txt' }) as HTMLButtonElement).disabled)
      .toBe(false)
  })

  it('approves and undoes a single hunk from the drawer', async () => {
    const twoHunks = fileReview('deep/a.txt', [
      { path: 'deep/a.txt', oldText: 'a', newText: 'A' },
      { path: 'deep/a.txt', oldText: 'b', newText: 'B' },
    ])
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.txt', state: 'applied' as const, changed: false },
    ] }))
    const applyChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.txt', state: 'undone' as const, changed: true },
    ] }))
    const view = render(
      <ProducedFiles
        matched={[twoHunks]}
        openFile={() => {}}
        inspectChanges={inspectChanges}
        applyChanges={applyChanges}
        t={t}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Review deep/a.txt' }))
    const drawer = view.getByRole('dialog', { name: 'Review' })

    // Opening the drawer refreshes per-hunk states with one entry per hunk.
    await vi.waitFor(() => {
      expect(inspectChanges.mock.calls.some(call =>
        (call[0] as { files: readonly unknown[] }).files.length === 2)).toBe(true)
    })
    const undoHunks = within(drawer).getAllByRole('button', { name: 'Undo this change' })
    expect(undoHunks).toHaveLength(2)
    await vi.waitFor(() => {
      expect((undoHunks[0] as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(undoHunks[0]!)
    await vi.waitFor(() => {
      expect(view.getByRole('alert').textContent).toContain('File restored')
    })
    expect(applyChanges).toHaveBeenCalledOnce()
    expect(applyChanges.mock.calls[0]?.[0].action).toBe('undo')
    expect(applyChanges.mock.calls[0]?.[0].files).toEqual([
      { path: 'deep/a.txt', diffs: [twoHunks.diffs[0]] },
    ])
    // The undone hunk locks; the sibling hunk stays live.
    await vi.waitFor(() => {
      const first = within(drawer).getAllByRole('button', { name: 'Undo this change' })[0] as HTMLButtonElement
      expect(first.disabled).toBe(true)
      expect(first.title).toBe('This change is already restored')
    })
    expect(
      (within(drawer).getAllByRole('button', { name: 'Undo this change' })[1] as HTMLButtonElement).disabled,
    ).toBe(false)
    // A partially undone file can no longer be undone as a whole.
    await vi.waitFor(() => {
      expect((within(drawer).getByRole('button', { name: 'Undo deep/a.txt' }) as HTMLButtonElement).disabled)
        .toBe(true)
    })
  })

  it('approves a hunk from the drawer and locks only that change', async () => {
    const twoHunks = fileReview('deep/a.txt', [
      { path: 'deep/a.txt', oldText: 'a', newText: 'A' },
      { path: 'deep/a.txt', oldText: 'b', newText: 'B' },
    ])
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.txt', state: 'applied' as const, changed: false },
    ] }))
    const view = render(
      <ProducedFiles
        matched={[twoHunks]}
        openFile={() => {}}
        inspectChanges={inspectChanges}
        t={t}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Review deep/a.txt' }))
    const drawer = view.getByRole('dialog', { name: 'Review' })

    const approveHunks = within(drawer).getAllByRole('button', { name: 'Approve this change' })
    expect(approveHunks).toHaveLength(2)
    await vi.waitFor(() => {
      expect((approveHunks[0] as HTMLButtonElement).disabled).toBe(false)
    })
    fireEvent.click(approveHunks[0]!)
    await vi.waitFor(() => {
      const first = within(drawer).getAllByRole('button', { name: 'Approve this change' })[0] as HTMLButtonElement
      expect(first.disabled).toBe(true)
      expect(first.title).toBe('Approved')
    })
    // Only the approved hunk is locked; its sibling stays undoable.
    const undoHunks = within(drawer).getAllByRole('button', { name: 'Undo this change' })
    await vi.waitFor(() => {
      expect((undoHunks[0] as HTMLButtonElement).disabled).toBe(true)
      expect((undoHunks[1] as HTMLButtonElement).disabled).toBe(false)
    })
    // A whole-file undo would touch the locked hunk, so it is blocked too.
    await vi.waitFor(() => {
      expect((within(drawer).getByRole('button', { name: 'Undo deep/a.txt' }) as HTMLButtonElement).disabled)
        .toBe(true)
    })
  })

  it('approves a file from the drawer header and locks every hunk', async () => {
    const view = render(<ProducedFiles matched={[changedReviews[0]!]} openFile={() => {}} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Review deep/a.html' }))
    const drawer = view.getByRole('dialog', { name: 'Review' })

    await vi.waitFor(() => {
      expect((within(drawer).getByRole('button', { name: 'Approve deep/a.html' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Approve deep/a.html' }))
    await vi.waitFor(() => {
      expect((within(drawer).getByRole('button', { name: 'Approve deep/a.html' }) as HTMLButtonElement).disabled)
        .toBe(true)
    })
    // File approval locks the file undo and every hunk undo.
    expect((within(drawer).getByRole('button', { name: 'Undo deep/a.html' }) as HTMLButtonElement).disabled)
      .toBe(true)
    await vi.waitFor(() => {
      expect((within(drawer).getAllByRole('button', { name: 'Undo this change' })[0] as HTMLButtonElement).disabled)
        .toBe(true)
      expect(within(drawer).getAllByRole('button', { name: 'Approve this change' })[0]!.title)
        .toBe('Approved')
    })
  })

  it('undoes a file from the drawer header and marks every hunk restored', async () => {
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.html', state: 'applied' as const, changed: false },
    ] }))
    const applyChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.html', state: 'undone' as const, changed: true },
    ] }))
    const view = render(
      <ProducedFiles
        matched={[changedReviews[0]!]}
        openFile={() => {}}
        inspectChanges={inspectChanges}
        applyChanges={applyChanges}
        t={t}
      />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Review deep/a.html' }))
    const drawer = view.getByRole('dialog', { name: 'Review' })
    await vi.waitFor(() => {
      expect((within(drawer).getByRole('button', { name: 'Undo deep/a.html' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    fireEvent.click(within(drawer).getByRole('button', { name: 'Undo deep/a.html' }))
    await vi.waitFor(() => {
      expect(view.getByRole('alert').textContent).toContain('File restored')
    })
    expect(applyChanges).toHaveBeenCalledOnce()
    expect(applyChanges.mock.calls[0]?.[0].files).toEqual([
      { path: 'deep/a.html', diffs: changedReviews[0]?.diffs },
    ])
    // A whole-file undo restores every recorded hunk.
    await vi.waitFor(() => {
      expect((within(drawer).getAllByRole('button', { name: 'Undo this change' })[0] as HTMLButtonElement).disabled)
        .toBe(true)
    })
  })

  it('disables a row toggle for a conflicted file and explains why', async () => {
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.txt', state: 'conflict' as const, changed: false },
    ] }))
    const view = render(
      <ProducedFiles
        matched={[fileReview('deep/a.txt', [{ path: 'deep/a.txt', oldText: 'a', newText: 'A' }])]}
        openFile={() => {}}
        inspectChanges={inspectChanges}
        applyChanges={vi.fn()}
        t={t}
      />,
    )

    await vi.waitFor(() => {
      const button = view.getByRole('button', { name: 'Undo deep/a.txt' }) as HTMLButtonElement
      expect(button.disabled).toBe(true)
      expect(button.title).toBe('This file cannot be undone right now')
    })
  })

  it('blocks the row after a single-file toggle reports a conflict', async () => {
    const inspectChanges = vi.fn(async () => ({ files: [
      { path: 'deep/a.txt', state: 'applied' as const, changed: false },
    ] }))
    const applyChanges = vi.fn(async () => ({ files: [
      {
        path: 'deep/a.txt', state: 'conflict' as const, changed: false,
        reason: 'current content does not match the recorded change',
      },
    ] }))
    const view = render(
      <ProducedFiles
        matched={[fileReview('deep/a.txt', [{ path: 'deep/a.txt', oldText: 'a', newText: 'A' }])]}
        openFile={() => {}}
        inspectChanges={inspectChanges}
        applyChanges={applyChanges}
        t={t}
      />,
    )

    await vi.waitFor(() => {
      expect((view.getByRole('button', { name: 'Undo deep/a.txt' }) as HTMLButtonElement).disabled)
        .toBe(false)
    })
    fireEvent.click(view.getByRole('button', { name: 'Undo deep/a.txt' }))
    await vi.waitFor(() => {
      expect(view.getByRole('alert').textContent).toContain('Could not undo this file')
    })
    expect(view.getByRole('alert').textContent)
      .toContain('current content does not match the recorded change')
    expect((view.getByRole('button', { name: 'Undo deep/a.txt' }) as HTMLButtonElement).disabled)
      .toBe(true)
  })

  it('reviews one file from its row and copies its unified diff', async () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const view = render(<ProducedFiles matched={changedReviews} openFile={() => {}} t={t} />)

    fireEvent.click(view.getByRole('button', { name: 'Review deep/a.html' }))
    const drawer = view.getByRole('dialog', { name: 'Review' })
    expect(within(drawer).getByText('1 file')).toBeTruthy()
    expect(within(drawer).getByText('deep/a.html')).toBeTruthy()
    expect(within(drawer).queryByText('styles/b.css')).toBeNull()
    expect(drawer.querySelectorAll('[data-diff-layout="unified"]')).toHaveLength(1)

    fireEvent.click(within(drawer).getByRole('button', { name: 'Copy diff' }))
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledOnce() })
    expect(writeText.mock.calls[0]?.[0]).toContain('deep/a.html')
    expect(writeText.mock.calls[0]?.[0]).not.toContain('styles/b.css')
    expect(within(drawer).getByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('focuses one file from its row, opens it in the editor, and restores focus on close', () => {
    const openFile = vi.fn<(path: string) => void>()
    const view = render(<ProducedFiles matched={changedReviews} openFile={openFile} t={t} />)
    const trigger = view.getByRole('button', { name: 'Review deep/a.html' })

    fireEvent.click(trigger)
    const drawer = view.getByRole('dialog', { name: 'Review' })
    expect(within(drawer).getByText('1 file')).toBeTruthy()
    expect(within(drawer).queryByText('styles/b.css')).toBeNull()
    expect(document.activeElement).toBe(view.getByRole('button', { name: 'Close' }))
    fireEvent.click(within(drawer).getByRole('button', { name: 'Open in editor' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('deep/a.html')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(view.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    fireEvent.click(view.getByRole('button', { name: 'Close' }))
    expect(view.queryByRole('dialog')).toBeNull()
  })

  it('closes the drawer when pressing outside of it', () => {
    const view = render(<ProducedFiles matched={changedReviews} openFile={() => {}} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Review deep/a.html' }))
    expect(view.getByRole('dialog', { name: 'Review' })).toBeTruthy()

    fireEvent.pointerDown(document.body)
    expect(view.queryByRole('dialog')).toBeNull()
    // A press inside the drawer keeps it open.
    fireEvent.click(view.getByRole('button', { name: 'Review deep/a.html' }))
    expect(view.getByRole('dialog', { name: 'Review' })).toBeTruthy()
    fireEvent.pointerDown(view.getByRole('dialog', { name: 'Review' }))
    expect(view.getByRole('dialog', { name: 'Review' })).toBeTruthy()
  })

  it('shows review paths relative to the Session project while opening the absolute path', () => {
    const absolutePath = '/Users/test/projects/example/docs/guide.md'
    const absoluteReview = fileReview(absolutePath, [{
      path: absolutePath, oldText: 'before', newText: 'after', oldStart: 1, newStart: 1,
    }])
    const openFile = vi.fn<(path: string) => void>()
    const view = render(
      <ProducedFiles
        matched={[absoluteReview]}
        openFile={openFile}
        projectRoot="/Users/test/projects/example"
        t={t}
      />,
    )

    fireEvent.click(view.getByRole('button', { name: `Review ${absolutePath}` }))
    const drawer = view.getByRole('dialog', { name: 'Review' })
    expect(within(drawer).getByText('docs/guide.md')).toBeTruthy()
    expect(within(drawer).queryByText(absolutePath)).toBeNull()
    fireEvent.click(within(drawer).getByRole('button', { name: 'Open in editor' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith(absolutePath)
  })

  it('keeps only one review drawer open across multiple produced-file cards', () => {
    const view = render(
      <>
        <ProducedFiles matched={[fileReview('first.md')]} openFile={() => {}} t={t} />
        <ProducedFiles matched={[fileReview('second.md')]} openFile={() => {}} t={t} />
      </>,
    )

    fireEvent.click(view.getByRole('button', { name: 'Review first.md' }))
    expect(view.getAllByRole('dialog', { name: 'Review' })).toHaveLength(1)
    fireEvent.click(view.getByRole('button', { name: 'Review second.md' }))
    expect(view.getAllByRole('dialog', { name: 'Review' })).toHaveLength(1)
    expect(view.getByRole('dialog', { name: 'Review' }).textContent).toContain('first.md')

    fireEvent.click(within(view.getByRole('dialog', { name: 'Review' }))
      .getByRole('button', { name: 'Close' }))
    fireEvent.click(view.getByRole('button', { name: 'Review second.md' }))
    expect(view.getAllByRole('dialog', { name: 'Review' })).toHaveLength(1)
    expect(view.getByRole('dialog', { name: 'Review' }).textContent).toContain('second.md')
  })

  it('resizes the drawer by dragging or keyboard and persists the chosen width', () => {
    const innerWidth = vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1024)
    const view = render(<ProducedFiles matched={changedReviews} openFile={() => {}} t={t} />)
    fireEvent.click(view.getByRole('button', { name: 'Review deep/a.html' }))
    const drawer = view.getByRole('dialog', { name: 'Review' })
    const handle = within(drawer).getByRole('separator', { name: 'Resize review panel' })

    expect(handle.getAttribute('aria-valuenow')).toBe('369')
    fireEvent.pointerDown(handle, { button: 0, pointerId: 7, clientX: 500 })
    fireEvent.pointerMove(handle, { pointerId: 7, clientX: 400 })
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 400 })
    expect(drawer.style.getPropertyValue('--review-drawer-width')).toBe('45.77vw')
    expect(window.localStorage.getItem('dsh-file-review:drawer-ratio')).toBe('0.4577')

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(drawer.style.getPropertyValue('--review-drawer-width')).toBe('43.77vw')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(drawer.style.getPropertyValue('--review-drawer-width')).toBe('24vw')

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    innerWidth.mockReturnValue(1440)
    fireEvent(window, new Event('resize'))
    expect(drawer.style.getPropertyValue('--review-drawer-width')).toBe('26vw')
    expect(handle.getAttribute('aria-valuenow')).toBe('374')

    fireEvent.doubleClick(handle)
    expect(drawer.style.getPropertyValue('--review-drawer-width')).toBe('')
    expect(window.localStorage.getItem('dsh-file-review:drawer-ratio')).toBeNull()
  })

  it('uses the host details track instead of covering the conversation', () => {
    const view = render(
      <div
        data-testid="host-frame"
        style={{ display: 'grid', gridTemplateColumns: '280px minmax(0, 1fr) 0px' }}
      >
        <aside style={{ width: 280 }} />
        <main>
          <ProducedFiles matched={changedReviews} openFile={() => {}} t={t} />
        </main>
        <aside data-testid="host-details">Native details</aside>
      </div>,
    )
    const frame = view.getByTestId('host-frame')
    const details = view.getByTestId('host-details')

    fireEvent.click(view.getByRole('button', { name: 'Review deep/a.html' }))
    expect(frame.style.gridTemplateColumns)
      .toBe('280px minmax(0, 1fr) var(--dsh-file-review-drawer-width)')
    expect(frame.style.getPropertyValue('--dsh-file-review-drawer-width')).toBe('36vw')
    expect(details.style.visibility).toBe('hidden')
    expect(details.style.pointerEvents).toBe('none')
    expect(details.getAttribute('aria-hidden')).toBe('true')
    const drawer = view.getByRole('dialog', { name: 'Review' })
    expect(drawer.className).toContain('drawerSplit')

    const handle = within(drawer).getByRole('separator', { name: 'Resize review panel' })
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(frame.style.getPropertyValue('--dsh-file-review-drawer-width')).toBe('38vw')

    fireEvent.click(within(drawer).getByRole('button', { name: 'Close' }))
    expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 0px')
    expect(frame.style.getPropertyValue('--dsh-file-review-drawer-width')).toBe('')
    expect(details.style.visibility).toBe('')
    expect(details.style.pointerEvents).toBe('')
    expect(details.getAttribute('aria-hidden')).toBeNull()
  })

  it('explains unavailable diffs and disables copying while keeping editor access', () => {
    const openFile = vi.fn<(path: string) => void>()
    const view = render(
      <ProducedFiles matched={[fileReview('notes.md')]} openFile={openFile} t={t} />,
    )
    fireEvent.click(view.getByRole('button', { name: 'Review notes.md' }))
    const drawer = view.getByRole('dialog', { name: 'Review' })
    expect(within(drawer).getByText(
      'No reconstructable diff is available for this change. You can still open the current file.',
    )).toBeTruthy()
    expect((within(drawer).getByRole('button', { name: 'Copy diff' }) as HTMLButtonElement).disabled)
      .toBe(true)
    fireEvent.click(within(drawer).getByRole('button', { name: 'Open in editor' }))
    expect(openFile).toHaveBeenCalledExactlyOnceWith('notes.md')
  })
})

describe('producedFileMentions resolver', () => {
  const label = (path: string) => `Open ${path}`

  it('resolves exact paths and unique basenames; ambiguity and unknowns stay unresolved', () => {
    const opened: string[] = []
    const resolver = producedFileMentions(
      ['out/index.html', 'a/style.css', 'b/style.css'],
      (path) => { opened.push(path) },
      label,
    )
    // Unique basename resolves to its full path; the full path rides title.
    const byBasename = resolver.resolve('index.html')
    expect(byBasename?.label).toBe('Open out/index.html')
    expect(byBasename?.title).toBe('out/index.html')
    byBasename?.open()
    expect(opened).toEqual(['out/index.html'])
    // An exact path resolves even when its basename is ambiguous.
    const exact = resolver.resolve('a/style.css')
    expect(exact?.title).toBe('a/style.css')
    // A basename two paths share stays unresolved rather than guessing,
    // and so does a token naming nothing the turn wrote.
    expect(resolver.resolve('style.css')).toBeUndefined()
    expect(resolver.resolve('notes.md')).toBeUndefined()
    expect(basename('a\\b\\c.txt')).toBe('c.txt')
  })
})

describe('plugin registration', () => {
  it('registers the Remote, turn definition, tail entry, dictionaries, and mention service', async () => {
    let definition: unknown
    let slot: {
      options: { inject?: (sessionId: string) => unknown; locale?: string; name?: string }
      component: unknown
    } | undefined
    let service: ChatFileMentions | undefined
    const registerLocale = vi.fn(() => () => {})
    const disposeRemote = vi.fn(async () => {})
    const mountRemote = vi.fn(async () => disposeRemote)
    class RemoteFixture extends Service {
      constructor(scoped: Context) { super(scoped, 'remote') }
    }
    class FileReviewRemoteFixture extends Service {
      constructor(scoped: Context) { super(scoped, 'remote.fileReview') }
      async status(): Promise<{ ok: true; value: { files: readonly [] } }> {
        return { ok: true, value: { files: [] } }
      }
      async apply(): Promise<{ ok: true; value: { files: readonly [] } }> {
        return { ok: true, value: { files: [] } }
      }
    }
    const cordis = new Context()
    const remoteFixture = cordis.plugin({ apply: scoped => { new RemoteFixture(scoped) } })
    const fileReviewFixture = cordis.plugin({
      apply: scoped => { new FileReviewRemoteFixture(scoped) },
    })
    await Promise.all([remoteFixture, fileReviewFixture])
    // Match SessionRuntime: its Agent-scope fiber knows the root Remote service,
    // but not feature namespaces mounted after the runtime started.
    const sessionScope = cordis.plugin({ inject: ['remote'], apply: () => {} })
    await sessionScope
    const ctx = {
      remote: { $mount: mountRemote },
      sessions: {
        scope: vi.fn(() => sessionScope.ctx),
        list: { getSnapshot: () => ({ byId: {
          'session-1': { cwd: '/workspace/project' },
        } }) },
      },
      conversationEvents: { register: (value: unknown) => { definition = value; return () => {} } },
      effect: (setup: () => void) => { setup() },
      locale: { register: registerLocale, bind: () => makeTranslate(en) },
      slots: {
        inject: (_name: string, setup: () => void) => { setup() },
        register: (
          options: { inject?: (sessionId: string) => unknown; locale?: string; name?: string },
          component: unknown,
        ) => {
          slot = { options, component }
          return () => {}
        },
      },
      provide: (name: string, value: ChatFileMentions) => {
        if (name === 'chatFileMentions') service = value
      },
    }

    const dispose = await apply(ctx as never)
    expect(inject).toEqual(['slots', 'locale', 'conversationEvents', 'remote', 'sessions'])
    expect(mountRemote).toHaveBeenCalledOnce()
    expect(definition).toBe(deliverablesDefinition)
    expect(registerLocale).toHaveBeenCalledWith('file-review', { zh, en })
    expect(slot?.component).toBe(ProducedFiles)
    expect(slot?.options.locale).toBe(NS)
    expect(slot?.options.inject).toBeTypeOf('function')
    const reviewActions = slot?.options.inject?.('session-1') as {
      projectRoot?: string
      inspectChanges(request: {
        action: 'undo'
        files: readonly []
      }): Promise<{ files: readonly [] }>
      applyChanges(request: {
        action: 'undo'
        files: readonly []
      }): Promise<{ files: readonly [] }>
    }
    expect(reviewActions.projectRoot).toBe('/workspace/project')
    await expect(reviewActions.inspectChanges({ action: 'undo', files: [] }))
      .resolves.toEqual({ files: [] })
    await expect(reviewActions.applyChanges({ action: 'undo', files: [] }))
      .resolves.toEqual({ files: [] })

    const opened: string[] = []
    const owner = tailOwner(
      produced([2, 'site/report.html']),
      3,
      (path) => { opened.push(path) },
    )
    const mentions = service?.forClosing(owner)
    mentions?.resolve('report.html')?.open()
    expect(opened).toEqual(['site/report.html'])
    expect(service?.forClosing(tailOwner(undefined, 2))).toBeUndefined()
    await dispose()
    expect(disposeRemote).toHaveBeenCalledOnce()
    await sessionScope.dispose()
    await fileReviewFixture.dispose()
    await remoteFixture.dispose()
  })
})
