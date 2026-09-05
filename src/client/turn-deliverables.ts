/**
 * Turn-scoped produced-file definition and readers. Client-only and
 * model-free: the vocabulary is the mutation tools' own call arguments and
 * result metadata, never the closing prose.
 */
import type {
  ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ProducedFileDiff, ProducedFileReview } from '../change-types.ts'

export type { ProducedFileDiff, ProducedFileReview } from '../change-types.ts'

interface ProducedPath {
  readonly seq: number
  readonly path: string
  readonly diffs: readonly ProducedFileDiff[]
  /** Which tool command produced this entry, e.g. `insert`, `str_replace`. */
  readonly source?: string | undefined
}

/** Immutable produced-file facts published against one Turn. */
export interface DeliverablesTurnData {
  readonly produced: readonly ProducedPath[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Successful mutation paths accumulated in this Turn. */
    deliverables: DeliverablesTurnData
  }
}

interface CallEntry {
  readonly path: string
  readonly source?: string | undefined
  /** Argument-derived hunks, used when the settled result carries none. */
  readonly intended: readonly ProducedFileDiff[]
}

interface DeliverablesState extends DeliverablesTurnData {
  readonly turn: number
  readonly calls: ReadonlyMap<string, CallEntry>
}

/** A short source label for a mutation call: the `str_replace_editor` command
 * name, or the tool name for every other tool. */
function callSourceLabel(name: string, argsJson: string): string | null {
  if (name === 'str_replace_editor') {
    try {
      const args = JSON.parse(argsJson) as { command?: unknown }
      return typeof args.command === 'string' && args.command !== '' ? args.command : null
    } catch {
      return null
    }
  }
  return name
}

/** Validate one optional line anchor as a positive integer. */
function lineAnchor(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined
}

/** Validate diff hunks crossing the Host/browser transport. */
function producedDiffs(view: unknown): readonly ProducedFileDiff[] {
  if (typeof view !== 'object' || view === null || Array.isArray(view)) return []
  const record = view as Record<string, unknown>
  if (!Array.isArray(record.diffs)) return []
  const diffs: ProducedFileDiff[] = []
  for (const value of record.diffs) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const { path, oldText, newText, oldStart, newStart } = value as Record<string, unknown>
    if (typeof path !== 'string'
      || (oldText !== null && oldText !== undefined && typeof oldText !== 'string')
      || typeof newText !== 'string') return []
    diffs.push({
      path,
      oldText: oldText === undefined ? null : oldText,
      newText,
      ...(lineAnchor(oldStart) !== undefined ? { oldStart: lineAnchor(oldStart) } : {}),
      ...(lineAnchor(newStart) !== undefined ? { newStart: lineAnchor(newStart) } : {}),
    })
  }
  return diffs
}

/**
 * Argument-derived whole-file or in-place change for a root mutation call.
 * Mirrors the harness's own diff-card derivation: `write`/`edit` and
 * `str_replace_editor` `create`/`str_replace` carry one reconstructable hunk
 * with no line anchors (the Host resolves by unique occurrence).
 */
function intendedDiff(name: string, argsJson: string): readonly ProducedFileDiff[] {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return []
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return []
  if (name === 'str_replace_editor') {
    const path = typeof args.path === 'string' ? args.path : null
    if (path === null || path.trim() === '') return []
    if (args.command === 'create') {
      const fileText = args.file_text
      if (fileText !== undefined && typeof fileText !== 'string') return []
      return [{ path, oldText: null, newText: fileText ?? '' }]
    }
    if (args.command === 'str_replace') {
      const oldText = args.old_str
      const newText = args.new_str
      if (oldText !== undefined && typeof oldText !== 'string') return []
      if (newText !== undefined && typeof newText !== 'string') return []
      return [{ path, oldText: oldText ?? null, newText: newText ?? '' }]
    }
    return []
  }
  const path = args.file_path
  if (typeof path !== 'string' || path.trim() === '') return []
  if (name === 'write') {
    const content = args.content
    return typeof content === 'string' ? [{ path, oldText: null, newText: content }] : []
  }
  if (name !== 'edit') return []
  const oldText = args.old_string
  const newText = args.new_string
  if (typeof oldText !== 'string' || typeof newText !== 'string') return []
  return [{ path, oldText: oldText || null, newText }]
}

/**
 * Reconstruct a reversible diff for `str_replace_editor`'s `insert` command.
 * Its result carries no `diffs` metadata, so the change is recovered from the
 * call arguments: inserting `new_str` after `insert_line` is undone by
 * locating and deleting that text at line `insert_line + 1`.
 */
function insertDiffsFromCall(name: string, argsJson: string): readonly ProducedFileDiff[] {
  if (name !== 'str_replace_editor') return []
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return []
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return []
  if (args.command !== 'insert') return []
  const path = typeof args.path === 'string' ? args.path : null
  const newText = typeof args.new_str === 'string' ? args.new_str : null
  const insertLine = typeof args.insert_line === 'number' && Number.isInteger(args.insert_line)
    ? args.insert_line + 1
    : undefined
  if (path === null || newText === null || newText === '' || insertLine === undefined) return []
  return [{
    path,
    oldText: '',
    newText,
    oldStart: insertLine,
    newStart: insertLine,
  }]
}

/** Argument-derived hunks for a mutation call (whole-file, in-place, or insert). */
function diffsFromCall(name: string, argsJson: string): readonly ProducedFileDiff[] {
  const inserted = insertDiffsFromCall(name, argsJson)
  if (inserted.length > 0) return inserted
  return intendedDiff(name, argsJson)
}

/** Applied result hunks from `meta.diffs`, or the call intent when the result
 * carries none. */
function reviewDiffs(
  intended: readonly ProducedFileDiff[],
  meta: unknown,
): readonly ProducedFileDiff[] {
  const applied = producedDiffs(meta)
  if (applied.length > 0) return applied
  return intended
}

/**
 * Files and review hunks available at one closing Assistant boundary.
 * @param data - engine-published Deliverables data for one Turn.
 * @param seq - closing Assistant seq; later Tool settlements are excluded.
 * @returns Produced files in first-seen order with same-path hunks appended in settlement order.
 */
export function reviewsForClosing(
  data: Readonly<DeliverablesTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
): readonly ProducedFileReview[] {
  if (data === undefined) return []
  const reviews: Array<{ path: string; diffs: ProducedFileDiff[]; sources?: string[] }> = []
  const byPath = new Map<string, { path: string; diffs: ProducedFileDiff[]; sources?: string[] }>()
  for (const produced of data.produced) {
    if (produced.seq > seq) continue
    const review = byPath.get(produced.path)
    if (review === undefined) {
      const created: { path: string; diffs: ProducedFileDiff[]; sources?: string[] } = {
        path: produced.path,
        diffs: [...produced.diffs],
      }
      if (produced.source !== undefined) created.sources = [produced.source]
      byPath.set(produced.path, created)
      reviews.push(created)
    } else {
      review.diffs.push(...produced.diffs)
      if (produced.source !== undefined && !review.sources?.includes(produced.source)) {
        review.sources = [...(review.sources ?? []), produced.source]
      }
    }
  }
  return reviews
}

/**
 * Files produced by one Turn data value.
 *
 * The source is the mutation tools' own call arguments, not the closing
 * prose: a produced file must be listed whether or not the model remembered
 * to name it. A mutation is recognized by tool name and arguments, so a new
 * mutation tool joins by declaring what it does. Reads contribute nothing
 * (looking at a file does not produce it), and neither do deletes (there is
 * nothing left to open) or failed calls. Paths keep first-seen order and
 * appear once, so a file written and then edited in the same turn is one entry.
 *
 * The Conversation Location index owns turn membership before this function
 * runs, so paths cannot spill across turns and this derivation does not infer
 * boundaries from neighboring presentation Nodes.
 * @param data - engine-published Deliverables data for one Turn.
 * @param seq - closing Assistant seq; later Tool settlements are excluded.
 * @returns Produced paths in first-seen order; empty when the turn wrote nothing.
 */
export function producedForClosing(
  data: Readonly<DeliverablesTurnData> | undefined,
  seq = Number.POSITIVE_INFINITY,
): readonly string[] {
  if (data === undefined) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const produced of data.produced) {
    if (produced.seq > seq || seen.has(produced.path)) continue
    seen.add(produced.path)
    paths.push(produced.path)
  }
  return paths
}

/**
 * Claim the turn-tail chain only when its closing turn produced files.
 * @param owner - Turn-tail owner currency for the closing assistant.
 * @returns Produced-file reviews as the component's match, or null to decline before mount.
 */
export function selectProducedFiles(owner: TurnTailOwnerProps): readonly ProducedFileReview[] | null {
  const reviews = reviewsForClosing(owner.turn.data.get('deliverables'), owner.seq)
  return reviews.length === 0 ? null : reviews
}

/** Turn-local successful mutation accumulator; it publishes no view Node. */
export const deliverablesDefinition: ConversationNodeDefinition<DeliverablesState> = {
  kind: 'deliverables',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'tool/result'
      && (event as { surfaceOp?: unknown }).surfaceOp === 'append') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('deliverables start requires turn/start')
    return {
      turn: match.event.data.turn, calls: new Map(), produced: [],
    }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      const diffs = diffsFromCall(match.event.data.name, match.event.data.arguments)
      if (diffs.length > 0 && diffs[0] !== undefined) {
        const source = callSourceLabel(match.event.data.name, match.event.data.arguments)
        calls.set(String(match.event.data.callId), {
          path: diffs[0].path,
          source: source ?? undefined,
          intended: diffs,
        })
      }
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result') return context.state
    if (match.event.data.message.content[0].isError === true) return context.state
    const callId = String(match.event.data.message.source.callId)
    const entry = context.state.calls.get(callId)
    if (entry === undefined) return context.state
    const diffs = reviewDiffs(entry.intended, match.event.data.meta)
    if (diffs.length === 0) return context.state
    const additions = diffs
      .filter(diff => diff.path === entry.path)
      .map(diff => ({
        seq: match.event.seq,
        path: diff.path,
        source: entry.source,
        diffs: [diff],
      }))
    return additions.length === 0
      ? context.state
      : { ...context.state, produced: [...context.state.produced, ...additions] }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    const value: DeliverablesTurnData = { produced: context.state.produced }
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'deliverables'
      && previous.value === value) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'deliverables',
      value,
    }
  },
}

/**
 * Trailing path segment, the part that identifies the file at a glance.
 * @param path - Slash- or backslash-separated path.
 * @returns The final segment, or the whole string when separator-free.
 */
export function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/**
 * File-mention vocabulary over one turn's produced paths, for the closing
 * message's prose: an inline-code token opens the file it names. A token
 * resolves by exact path, or by being exactly the basename of exactly one
 * produced path — a basename two paths share stays inert rather than
 * guessing, so a mention link can never open the wrong file or 404.
 * @param paths - The turn's produced paths (tool order, already deduped).
 * @param openFile - The chat view's file opener.
 * @param label - Localizes the accessible open-label for a resolved path.
 * @returns The resolver MarkdownText consumes; the full path rides `title`,
 * the same disambiguator the row's chips carry.
 */
export function producedFileMentions(
  paths: readonly string[],
  openFile: (path: string) => void,
  label: (path: string) => string,
): MarkdownFileMentions {
  return {
    resolve(value) {
      const path = paths.includes(value) ? value : onlyPathWithBasename(paths, value)
      if (path === undefined) return undefined
      return { open: () => { openFile(path) }, label: label(path), title: path }
    },
  }
}

/** The single produced path whose basename is exactly `value`, else undefined. */
function onlyPathWithBasename(paths: readonly string[], value: string): string | undefined {
  const matches = paths.filter(path => basename(path) === value)
  return matches.length === 1 ? matches[0] : undefined
}
