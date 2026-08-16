/**
 * Turn-scoped produced-file definition and readers. Client-only and
 * model-free: the vocabulary is the mutation tools' own follow-along
 * `locations`, never the closing prose.
 */
import type {
  ConversationMatch, ConversationNodeDefinition, ToolResultNode,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { MarkdownFileMentions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
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

declare module '@deepseek-ai/dsh-client-runtime/client' {
  interface ConversationTurnDataMap {
    /** Successful mutation paths accumulated in this Turn. */
    deliverables: DeliverablesTurnData
  }
}

interface DeliverablesState extends DeliverablesTurnData {
  readonly turn: number
  readonly calls: ReadonlyMap<string, ToolResultNode['callView']>
  /** Insert diffs reconstructed from tool-call arguments, keyed by callId. */
  readonly inserts: ReadonlyMap<string, readonly ProducedFileDiff[]>
  /** Human source label (tool command) per callId. */
  readonly callSources: ReadonlyMap<string, string>
}

/**
 * A short source label for a mutation call: the `str_replace_editor` command
 * name, or the tool name for every other tool.
 */
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

/**
 * Reconstruct a reversible diff for `str_replace_editor`'s `insert` command.
 * Its result view is a generic `edit` card with no `diffs`, so the change is
 * recovered from the call arguments: inserting `new_str` after `insert_line`
 * is undone by locating and deleting that text at line `insert_line + 1`.
 */
function insertDiffsFromCall(name: string, argsJson: string): readonly ProducedFileDiff[] {
  if (name !== 'str_replace_editor') return []
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return []
  }
  if (args?.command !== 'insert') return []
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

/**
 * Paths a call view reports having created or changed, by render intent rather
 * than tool name: a diff card, or a generic card whose kind is `edit` (the
 * shape `str_replace_editor`'s insert presents). Every other card produces
 * nothing to open — a read looked, a delete removed, a terminal ran. Only
 * root call views enter this Turn accumulator; nested Code Mode dispatches
 * preserve the pre-assembly behavior and do not contribute independently.
 */
function producedPaths(view: ToolResultNode['callView']): readonly string[] {
  if (view === null
    || (view.card !== 'diff' && !(view.card === 'generic' && view.kind === 'edit'))) return []
  const locations = (view as { locations?: unknown }).locations
  if (!Array.isArray(locations)) return []
  const paths: string[] = []
  const seen = new Set<string>()
  for (const location of locations) {
    if (typeof location !== 'object' || location === null || Array.isArray(location)) continue
    const path = (location as Record<string, unknown>).path
    if (typeof path !== 'string' || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

/** Validate diff hunks crossing the Host/browser transport. */
function producedDiffs(view: unknown): readonly ProducedFileDiff[] {
  if (typeof view !== 'object' || view === null || Array.isArray(view)) return []
  const record = view as Record<string, unknown>
  if (record.card !== 'diff' || !Array.isArray(record.diffs)) return []
  const diffs: ProducedFileDiff[] = []
  for (const value of record.diffs) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return []
    const { path, oldText, newText, oldStart, newStart } = value as Record<string, unknown>
    if (typeof path !== 'string'
      || (oldText !== null && typeof oldText !== 'string')
      || typeof newText !== 'string'
      || (oldStart !== undefined
        && (typeof oldStart !== 'number' || !Number.isInteger(oldStart) || oldStart < 1))
      || (newStart !== undefined
        && (typeof newStart !== 'number' || !Number.isInteger(newStart) || newStart < 1))) return []
    diffs.push({
      path,
      oldText,
      newText,
      ...(typeof oldStart === 'number' ? { oldStart } : {}),
      ...(typeof newStart === 'number' ? { newStart } : {}),
    })
  }
  return diffs
}

/** Applied result hunks, falling back to the call intent when the result
 * view carries no reconstructable hunks. */
function reviewDiffs(
  callView: ToolResultNode['callView'],
  resultView: ConversationMatch['view'],
): readonly ProducedFileDiff[] {
  const resultDiffs = resultView?.for === 'result' ? producedDiffs(resultView.view) : []
  if (resultDiffs.length > 0) return resultDiffs
  return producedDiffs(callView)
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
 * The source is the mutation tools' own follow-along `locations`, not the
 * closing prose: a produced file must be listed whether or not the model
 * remembered to name it. A mutation is recognized by render intent, not by
 * tool name — a diff card, or a generic card whose `kind` is `edit` (the shape
 * `str_replace_editor`'s insert presents) — so a new mutation tool joins by
 * declaring what it does. Reads contribute nothing (looking at a file does not
 * produce it), and neither do deletes (there is nothing left to open) or
 * failed calls. Paths keep first-seen order and appear once, so a file written
 * and then edited in the same turn is one entry.
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
      turn: match.event.data.turn, calls: new Map(), inserts: new Map(),
      callSources: new Map(), produced: [],
    }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      const calls = new Map(context.state.calls)
      calls.set(
        String(match.event.data.callId),
        match.view?.for === 'call' ? match.view.view : null,
      )
      const inserts = new Map(context.state.inserts)
      const callSources = new Map(context.state.callSources)
      // The conversation event carries the raw call arguments as `argsRaw`
      // (the runtime maps ToolCallBlock.arguments to argsRaw); `arguments`
      // is only the fixture spelling, kept for robustness.
      const data = match.event.data as {
        name?: unknown
        argsRaw?: unknown
        arguments?: unknown
      }
      const name = data.name
      const args = data.argsRaw ?? data.arguments
      if (typeof name === 'string' && typeof args === 'string') {
        const insertDiffs = insertDiffsFromCall(name, args)
        if (insertDiffs.length > 0) inserts.set(String(match.event.data.callId), insertDiffs)
        const source = callSourceLabel(name, args)
        if (source !== null) callSources.set(String(match.event.data.callId), source)
      }
      return { ...context.state, calls, inserts, callSources }
    }
    if (match.event.type !== 'tool/result') return context.state
    const result = match.event.data.message.content[0]
    if (result.isError === true) return context.state
    const callId = String(match.event.data.message.source.callId)
    const callView = context.state.calls.get(callId) ?? null
    let diffs = reviewDiffs(callView, match.view)
    if (diffs.length === 0) {
      // The result carries no reconstructable hunks (generic `insert` cards);
      // fall back to the diff rebuilt from the call arguments.
      diffs = context.state.inserts.get(callId) ?? []
    }
    const source = context.state.callSources.get(callId)
    const additions = producedPaths(callView).map(path => ({
      seq: match.event.seq,
      path,
      source,
      diffs: diffs.filter(diff => diff.path === path),
    }))
    return additions.length === 0
      ? context.state
      : { ...context.state, produced: [...context.state.produced, ...additions] }
  },
  buildLocationData: (context, scope) => scope !== 'turn' || context.state === undefined
    ? null
    : {
      kind: 'turn',
      turn: context.state.turn,
      key: 'deliverables',
      value: { produced: context.state.produced },
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
