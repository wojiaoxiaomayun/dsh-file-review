// ProducedFiles: the review card a finished turn ends with. Paths and hunks
// come from mutation-tool results, never from the closing prose.

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  CSSProperties, KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent,
} from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  FileReviewFileState, FileReviewRequest, FileReviewResult,
} from '../change-types.ts'
import { basename, type ProducedFileDiff, type ProducedFileReview } from './turn-deliverables.ts'
import type { NS } from './locales.ts'
import {
  summarizeDiffs, UnifiedDiff, unifiedDiffText, type UnifiedDiffStats,
} from './UnifiedDiff.tsx'
import css from './ProducedFiles.module.css'

/** Keep the turn-tail card compact; the drawer always contains every file. */
const SHOWN_LIMIT = 6
const DRAWER_RATIO_KEY = 'dsh-file-review:drawer-ratio'
const DRAWER_DEFAULT_RATIO = 0.36
const DRAWER_MIN_RATIO = 0.24
const DRAWER_MAX_RATIO = 0.75
const DRAWER_KEYBOARD_STEP = 0.02
const MOBILE_BREAKPOINT = 760
const HOST_DRAWER_TRACK_PROPERTY = '--dsh-file-review-drawer-width'
const SUCCESS_NOTICE_DURATION = 2000
const ERROR_NOTICE_DURATION = 5000

/** Review drawers share the host's single details column, so only one may own it at a time. */
let activeReviewOwner: symbol | null = null

function claimReviewDrawer(owner: symbol): boolean {
  if (activeReviewOwner !== null) return activeReviewOwner === owner
  activeReviewOwner = owner
  return true
}

function releaseReviewDrawer(owner: symbol): void {
  if (activeReviewOwner === owner) activeReviewOwner = null
}

type ReviewScope = { readonly kind: 'all' } | { readonly kind: 'file'; readonly path: string }

interface ResizeDrag {
  readonly pointerId: number
  readonly startX: number
  readonly startWidth: number
  currentRatio: number
}

interface HostSplitLayout {
  readonly frame: HTMLElement
  readonly sidebar: HTMLElement
  readonly center: HTMLElement
  readonly details: HTMLElement
}

interface ActiveHostSplit {
  readonly layout: HostSplitLayout
  readonly splitColumns: string
  readonly previousGridTemplateColumns: string
  readonly previousDrawerTrack: string
}

interface NoticeFile {
  readonly path: string
}

interface ToggleNotice {
  readonly seq: number
  readonly tone: 'success' | 'error'
  readonly title: string
  readonly description?: string | undefined
  readonly files: readonly NoticeFile[]
}

function viewportWidth(): number {
  return typeof window === 'undefined' ? 1280 : window.innerWidth
}

function clampDrawerRatio(ratio: number): number {
  const clamped = Math.min(DRAWER_MAX_RATIO, Math.max(DRAWER_MIN_RATIO, ratio))
  return Math.round(clamped * 10_000) / 10_000
}

function storedDrawerRatio(): number | null {
  if (typeof window === 'undefined') return null
  try {
    const stored = Number.parseFloat(window.localStorage.getItem(DRAWER_RATIO_KEY) ?? '')
    return Number.isFinite(stored) ? clampDrawerRatio(stored) : null
  } catch {
    return null
  }
}

function persistDrawerRatio(ratio: number | null): void {
  try {
    if (ratio === null) window.localStorage.removeItem(DRAWER_RATIO_KEY)
    else window.localStorage.setItem(DRAWER_RATIO_KEY, String(ratio))
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

/** Locate the host's sidebar / conversation / details grid without relying on hashed classes. */
function findHostSplitLayout(anchor: HTMLElement): HostSplitLayout | null {
  let directChild: HTMLElement = anchor
  for (let candidate = anchor.parentElement; candidate !== null; candidate = candidate.parentElement) {
    if (getComputedStyle(candidate).display === 'grid') {
      const children = Array.from(candidate.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      )
      const centerIndex = children.indexOf(directChild)
      if (centerIndex > 0 && centerIndex + 1 < children.length) {
        const sidebar = children[centerIndex - 1]
        const details = children[centerIndex + 1]
        if (sidebar !== undefined && details !== undefined
          && details.getBoundingClientRect().width <= 1) {
          return { frame: candidate, sidebar, center: directChild, details }
        }
      }
    }
    directChild = candidate
  }
  return null
}

function sidebarTrackWidth(layout: HostSplitLayout): number {
  const rectWidth = layout.sidebar.getBoundingClientRect().width
  if (rectWidth > 0) return rectWidth
  const styleWidth = Number.parseFloat(getComputedStyle(layout.sidebar).width)
  return Number.isFinite(styleWidth) ? styleWidth : 0
}

function drawerTrackForRatio(ratio: number): string {
  return `${Number((ratio * 100).toFixed(2))}vw`
}

/** Matched file reviews plus the opener and locale supplied by the turn-tail slot. */
export type ProducedFilesProps = Pick<TurnTailOwnerProps, 'openFile'> & {
  matched: readonly ProducedFileReview[]
  /** Session workspace root, used only to shorten paths shown in the review UI. */
  projectRoot?: string | undefined
  inspectChanges?: (request: FileReviewRequest) => Promise<FileReviewResult>
  applyChanges?: (request: FileReviewRequest) => Promise<FileReviewResult>
} & PropsLocale<typeof NS>

/** Keep host paths intact for actions while presenting files relative to their project. */
function displayPath(path: string, projectRoot: string | undefined): string {
  if (projectRoot === undefined || projectRoot.length === 0) return path
  const normalizedPath = path.replaceAll('\\', '/')
  const normalizedRoot = projectRoot.replaceAll('\\', '/').replace(/\/+$/, '')
  if (normalizedRoot.length === 0) return path
  const windowsPath = /^[A-Za-z]:\//.test(normalizedPath)
  const comparablePath = windowsPath ? normalizedPath.toLowerCase() : normalizedPath
  const comparableRoot = windowsPath ? normalizedRoot.toLowerCase() : normalizedRoot
  const prefix = `${comparableRoot}/`
  return comparablePath.startsWith(prefix)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : path
}

/** Stable identity of one hunk within one file's recorded change list. */
function hunkId(path: string, index: number): string {
  return `${path}#${index}`
}

/** A hunk is reversible when the Host can locate and replace both sides. */
function hunkReversible(path: string, diff: ProducedFileDiff): boolean {
  return diff.path === path
    && diff.oldText !== null
    && diff.oldText !== diff.newText
    && (diff.oldText !== '' || diff.oldStart !== undefined)
    && (diff.newText !== '' || diff.newStart !== undefined)
}

/**
 * A file's recorded change is undoable when it is a set of reversible edits,
 * or a creation (first hunk has no old text) whose later hunks are reversible
 * edits — undoing a creation deletes the file on the Host.
 */
function fileUndoable(path: string, diffs: readonly ProducedFileDiff[]): boolean {
  const [first, ...rest] = diffs
  if (first === undefined) return false
  if (first.oldText === null) return rest.every(diff => hunkReversible(path, diff))
  return diffs.every(diff => hunkReversible(path, diff))
}

const unavailableChanges = async (request: FileReviewRequest): Promise<FileReviewResult> => ({
  files: request.files.map(file => ({
    path: file.path,
    state: 'unsupported',
    changed: false,
    reason: 'Host file toggle is unavailable',
  })),
})

function FileIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={css.icon}>
      <path d="M5.25 2.75h6l3.5 3.5v10a1 1 0 0 1-1 1h-8.5a1 1 0 0 1-1-1V3.75a1 1 0 0 1 1-1Z" />
      <path d="M11.25 2.75v3.5h3.5M7 10h5M7 13h5" />
    </svg>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={css.buttonIcon}>
      <rect x="6.5" y="6.5" width="9" height="9" rx="1.5" />
      <path d="M13.5 6.5v-2a1 1 0 0 0-1-1h-8a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h2" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={css.closeIcon}>
      <path d="m5.5 5.5 9 9m0-9-9 9" />
    </svg>
  )
}

function SuccessIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={css.noticeIconSvg}>
      <path d="m5 10 3.25 3.25L15 6.5" />
    </svg>
  )
}

function ErrorIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={css.noticeIconSvg}>
      <circle cx="10" cy="10" r="6.5" />
      <path d="m7.5 7.5 5 5m0-5-5 5" />
    </svg>
  )
}

// Iconography below is from lucide (Iconify), viewBox 0 0 24 24, drawn in
// currentColor so the approved/locked states can tint it.

function ApproveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={css.toggleIcon}>
      <path
        fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"
        strokeWidth={2} d="M20 6L9 17l-5-5"
      />
    </svg>
  )
}

function ApproveAllIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={css.toggleIcon}>
      <path
        fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"
        strokeWidth={2} d="M18 6L7 17l-5-5m20-2l-7.5 7.5L13 16"
      />
    </svg>
  )
}

function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={css.toggleIcon}>
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}>
        <path d="M3 7v6h6" />
        <path d="M21 17a9 9 0 0 0-9-9a9 9 0 0 0-6 2.3L3 13" />
      </g>
    </svg>
  )
}

function UndoAllIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={css.toggleIcon}>
      <g fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}>
        <path d="M9 14L4 9l5-5" />
        <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11" />
      </g>
    </svg>
  )
}

function LoaderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={css.loaderIcon}>
      <path
        fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round"
        strokeWidth={2} d="M21 12a9 9 0 1 1-6.219-8.56"
      />
    </svg>
  )
}

function ResultToast({
  notice, closeLabel, dismissLabel, fileListLabel, fileOpenLabel, openFile, onDone,
}: {
  readonly notice: ToggleNotice
  readonly closeLabel: string
  readonly dismissLabel: string
  readonly fileListLabel: string
  readonly fileOpenLabel: (path: string) => string
  readonly openFile: (path: string) => void
  readonly onDone: () => void
}) {
  useEffect(() => {
    const duration = notice.tone === 'success'
      ? SUCCESS_NOTICE_DURATION
      : ERROR_NOTICE_DURATION
    const timer = window.setTimeout(onDone, duration)
    return () => { window.clearTimeout(timer) }
  }, [notice.tone, onDone])
  return (
    <div
      className={`${css.toast} ${notice.tone === 'success' ? css.toastSuccess : css.toastError}`}
      role="alert"
    >
      <div className={css.toastHeader}>
        <span className={css.noticeIcon}>
          {notice.tone === 'success' ? <SuccessIcon /> : <ErrorIcon />}
        </span>
        <div className={css.toastCopy}>
          <strong className={css.toastTitle}>{notice.title}</strong>
          {notice.description !== undefined && (
            <span className={css.toastDescription}>{notice.description}</span>
          )}
        </div>
        <button
          type="button"
          className={css.toastCloseButton}
          aria-label={closeLabel}
          onClick={onDone}
        >
          <CloseIcon />
        </button>
      </div>
      {notice.files.length > 0 && (
        <div className={css.noticeFiles}>
          <span className={css.noticeFileListLabel}>{fileListLabel}</span>
          <ul className={css.noticeFileList}>
            {notice.files.map(file => (
              <li key={file.path}>
                <button
                  type="button"
                  className={css.noticeFileButton}
                  aria-label={fileOpenLabel(file.path)}
                  onClick={() => { openFile(file.path) }}
                >
                  <span className={css.noticeFilePath}>{basename(file.path)}</span>
                  <span className={css.noticeFileArrow} aria-hidden="true">↗</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {notice.tone === 'error' && (
        <button type="button" className={css.noticeDismissButton} onClick={onDone}>
          {dismissLabel}
        </button>
      )}
    </div>
  )
}

function addStats(left: UnifiedDiffStats, right: UnifiedDiffStats): UnifiedDiffStats {
  return { added: left.added + right.added, removed: left.removed + right.removed }
}

function Stats({ stats, label }: { readonly stats: UnifiedDiffStats; readonly label: string }) {
  return (
    <span className={css.stats} aria-label={label}>
      <span className={css.added}>+{stats.added}</span>
      <span className={css.removed}>-{stats.removed}</span>
    </span>
  )
}

/** Render one turn's produced files as a summary card and review drawer. */
export function ProducedFiles({
  matched: reviews, openFile, projectRoot,
  inspectChanges = unavailableChanges, applyChanges = unavailableChanges, t,
}: ProducedFilesProps) {
  const drawerTitleId = useId()
  const [reviewScope, setReviewScope] = useState<ReviewScope | null>(null)
  const [copied, setCopied] = useState(false)
  const [drawerRatio, setDrawerRatio] = useState<number | null>(storedDrawerRatio)
  const [currentViewportWidth, setCurrentViewportWidth] = useState(viewportWidth)
  const [isResizing, setIsResizing] = useState(false)
  const [isHostSplit, setIsHostSplit] = useState(false)
  const [statusPending, setStatusPending] = useState(true)
  const [togglePending, setTogglePending] = useState(false)
  /** Last known Host state per produced file, driving each row's own undo. */
  const [fileStates, setFileStates] = useState<ReadonlyMap<string, FileReviewFileState>>(() => new Map())
  /** Files with an in-flight per-file undo. */
  const [filePending, setFilePending] = useState<ReadonlySet<string>>(() => new Set())
  /** Files the user approved; approval locks the file against further undo. */
  const [approved, setApproved] = useState<ReadonlySet<string>>(() => new Set())
  /** Hunk-level approvals keyed by `${path}#${index}`; locks that hunk. */
  const [approvedHunks, setApprovedHunks] = useState<ReadonlySet<string>>(() => new Set())
  /** Last known Host state per hunk, refreshed while the review drawer is open. */
  const [hunkStates, setHunkStates] = useState<ReadonlyMap<string, FileReviewFileState>>(() => new Map())
  /** Hunk-level undo requests in flight. */
  const [hunkPending, setHunkPending] = useState<ReadonlySet<string>>(() => new Set())
  /** Whether the file list shows every file instead of the six-file preview. */
  const [expanded, setExpanded] = useState(false)
  const [toast, setToast] = useState<ToggleNotice | null>(null)
  const toastSeqRef = useRef(0)
  const reviewOwnerRef = useRef(Symbol('review-drawer-owner'))
  const cardRef = useRef<HTMLElement>(null)
  const drawerRef = useRef<HTMLElement>(null)
  const hostSplitRef = useRef<ActiveHostSplit | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const copyResetRef = useRef<number | null>(null)
  const resizeDragRef = useRef<ResizeDrag | null>(null)

  const reviewsWithStats = useMemo(() => reviews.map(review => ({
    review,
    stats: summarizeDiffs(review.diffs),
  })), [reviews])
  const totalStats = useMemo(
    () => reviewsWithStats.reduce<UnifiedDiffStats>(
      (total, item) => addStats(total, item.stats),
      { added: 0, removed: 0 },
    ),
    [reviewsWithStats],
  )
  const toggleFiles = useMemo(() => reviews.map(review => ({
    path: review.path,
    diffs: review.diffs,
  })), [reviews])
  const reversiblePaths = useMemo(() => new Set(reviews.filter(review =>
    fileUndoable(review.path, review.diffs)).map(review => review.path)), [reviews])
  const anyFilePending = filePending.size > 0
  const shown = expanded ? reviewsWithStats : reviewsWithStats.slice(0, SHOWN_LIMIT)
  const hidden = expanded ? 0 : reviewsWithStats.length - shown.length
  /**
   * Files a whole-file undo may still run on: reversible, not approved, no
   * approved or partially undone hunk, and not blocked on disk. Unknown hunk
   * states count as safe; the Host re-checks every hunk before writing.
   */
  const undoablePaths = useMemo(() => {
    const locked = new Set<string>()
    for (const review of reviews) {
      for (let index = 0; index < review.diffs.length; index += 1) {
        const id = hunkId(review.path, index)
        if (approvedHunks.has(id)
          || (hunkStates.get(id) !== undefined && hunkStates.get(id) !== 'applied')) {
          locked.add(review.path)
          break
        }
      }
    }
    return new Set([...reversiblePaths].filter(path =>
      !approved.has(path)
      && !locked.has(path)
      && fileStates.get(path) !== 'undone'
      && fileStates.get(path) !== 'conflict'
      && fileStates.get(path) !== 'error'))
  }, [approved, approvedHunks, fileStates, hunkStates, reversiblePaths, reviews])
  const hasUndoableFiles = undoablePaths.size > 0
  const allApproved = reviews.length > 0 && approved.size >= reviews.length
  /** Human explanation for a disabled whole-file undo. */
  const undoTitleFor = (path: string): string | undefined => {
    if (!reversiblePaths.has(path)) return t('produced.toggleUnavailable')
    const state = fileStates.get(path)
    const review = reviews.find(item => item.path === path)
    const hasApprovedHunk = review?.diffs.some((_, index) => approvedHunks.has(hunkId(path, index))) ?? false
    const hunkPartiallyUndone = review?.diffs.some((_, index) =>
      hunkStates.get(hunkId(path, index)) === 'undone') ?? false
    if (approved.has(path) || hasApprovedHunk) return t('produced.approvedLocked')
    if (state === 'undone') return t('produced.alreadyUndone')
    if (hunkPartiallyUndone) return t('produced.hunkPartiallyUndone')
    if (state === 'conflict' || state === 'error') return t('produced.fileToggleBlocked')
    return undefined
  }
  const visibleReviews = useMemo(() => reviewScope?.kind === 'file'
    ? reviews.filter(review => review.path === reviewScope.path)
    : reviews, [reviewScope, reviews])
  const visibleDiffs = useMemo(
    () => visibleReviews.flatMap(review => review.diffs),
    [visibleReviews],
  )
  const visibleStats = useMemo(() => visibleReviews.reduce<UnifiedDiffStats>(
    (total, review) => addStats(total, summarizeDiffs(review.diffs)),
    { added: 0, removed: 0 },
  ), [visibleReviews])

  const showToast = useCallback((notice: Omit<ToggleNotice, 'seq'>) => {
    toastSeqRef.current += 1
    setToast({ seq: toastSeqRef.current, ...notice })
  }, [])

  /** Merge Host per-file states into the row state table (never removes entries). */
  const recordFileStates = useCallback((result: FileReviewResult) => {
    setFileStates(current => {
      const next = new Map(current)
      for (const file of result.files) next.set(file.path, file.state)
      return next
    })
  }, [])

  useEffect(() => {
    let active = true
    setStatusPending(true)
    void inspectChanges({ action: 'undo', files: toggleFiles }).then((result) => {
      if (!active) return
      recordFileStates(result)
    }).catch(() => {
      // The action remains usable after a transient inspection failure; execution
      // performs the same Host-side checks again.
    }).finally(() => {
      if (active) setStatusPending(false)
    })
    return () => { active = false }
  }, [inspectChanges, recordFileStates, toggleFiles])

  /**
   * Undo every unlocked reversible file in one Host request. Files that are
   * already undone, approved, or blocked are left out; the Host re-checks each
   * included file against disk before writing.
   */
  const runUndoAll = useCallback(() => {
    if (statusPending || togglePending || anyFilePending) return
    const files = toggleFiles.filter(file => undoablePaths.has(file.path))
    if (files.length === 0) return
    setTogglePending(true)
    void applyChanges({ action: 'undo', files }).then((result) => {
      recordFileStates(result)
      const byPath = new Map(result.files.map(file => [file.path, file]))
      const failures: NoticeFile[] = files.flatMap((file) => {
        const outcome = byPath.get(file.path)
        if (outcome?.state === 'undone') return []
        return [{ path: file.path }]
      })
      if (failures.length === 0) {
        showToast({
          tone: 'success',
          title: t('produced.undoSuccess'),
          files: [],
        })
        return
      }
      showToast({
        tone: 'error',
        title: t('produced.undoPartial'),
        description: t('produced.undoPartialDescription'),
        files: failures,
      })
    }).catch((error: unknown) => {
      showToast({
        tone: 'error',
        title: t('produced.undoError'),
        description: error instanceof Error ? error.message : String(error),
        files: [],
      })
    }).finally(() => { setTogglePending(false) })
  }, [
    anyFilePending, applyChanges, recordFileStates, showToast, statusPending,
    t, toggleFiles, togglePending, undoablePaths,
  ])

  /** Approve one file, locking it against undo for this turn. */
  const approveFile = useCallback((path: string) => {
    setApproved(current => current.has(path) ? current : new Set(current).add(path))
  }, [])

  /** Approve every produced file, locking the whole turn's changes. */
  const approveAll = useCallback(() => {
    setApproved(current => {
      if (current.size >= reviews.length) return current
      return new Set(reviews.map(review => review.path))
    })
  }, [reviews])

  /**
   * Undo one produced file from its row or drawer header. The request carries
   * exactly that file, so Host-side per-file safety checks still apply. A file
   * with approved or partially undone hunks is never submitted.
   */
  const runFileUndo = useCallback((path: string) => {
    const file = toggleFiles.find(item => item.path === path)
    if (file === undefined || !undoablePaths.has(path)) return
    if (statusPending || togglePending || anyFilePending || filePending.has(path)) return
    setFilePending(current => new Set(current).add(path))
    void applyChanges({ action: 'undo', files: [file] }).then((result) => {
      const outcome = result.files.find(item => item.path === path)
      recordFileStates(result)
      if (outcome?.state === 'undone') {
        // A whole-file undo restores every recorded hunk — or deletes a
        // file this turn created.
        const review = reviews.find(item => item.path === path)
        const created = review?.diffs[0]?.oldText === null
        setHunkStates(current => {
          if (review === undefined || review.diffs.length === 0) return current
          const next = new Map(current)
          review.diffs.forEach((_, index) => next.set(hunkId(path, index), 'undone'))
          return next
        })
        showToast({
          tone: 'success',
          title: t(created ? 'produced.fileDeleted' : 'produced.fileUndone'),
          files: [],
        })
        return
      }
      showToast({
        tone: 'error',
        title: t('produced.fileUndoFailed'),
        description: outcome?.reason,
        files: [{ path }],
      })
    }).catch((error: unknown) => {
      showToast({
        tone: 'error',
        title: t('produced.fileUndoFailed'),
        description: error instanceof Error ? error.message : String(error),
        files: [],
      })
    }).finally(() => {
      setFilePending(current => {
        const next = new Set(current)
        next.delete(path)
        return next
      })
    })
  }, [
    anyFilePending, applyChanges, filePending, recordFileStates, reviews,
    showToast, statusPending, t, toggleFiles, togglePending, undoablePaths,
  ])

  /** Approve one hunk in the drawer, locking that change against undo. */
  const approveHunk = useCallback((path: string, index: number) => {
    const id = hunkId(path, index)
    setApprovedHunks(current => current.has(id) ? current : new Set(current).add(id))
  }, [])

  /**
   * Undo exactly one recorded hunk. The Host treats the hunk as its own
   * change (`{ path, diffs: [hunk] }`), so it only touches that segment and
   * re-validates it against disk before writing.
   */
  const runHunkUndo = useCallback((path: string, index: number) => {
    const review = reviews.find(item => item.path === path)
    const diff = review?.diffs[index]
    if (review === undefined || diff === undefined || !hunkReversible(path, diff)) return
    const id = hunkId(path, index)
    if (statusPending || togglePending || anyFilePending || filePending.has(path)) return
    if (hunkPending.has(id) || approved.has(path) || approvedHunks.has(id)) return
    if (hunkStates.get(id) === 'undone') return
    setHunkPending(current => new Set(current).add(id))
    void applyChanges({ action: 'undo', files: [{ path, diffs: [diff] }] }).then((result) => {
      const outcome = result.files[0]
      setHunkStates(current => {
        const next = new Map(current)
        if (outcome !== undefined) next.set(id, outcome.state)
        return next
      })
      if (outcome?.state === 'undone') {
        showToast({
          tone: 'success',
          title: t('produced.fileUndone'),
          files: [],
        })
        return
      }
      showToast({
        tone: 'error',
        title: t('produced.fileUndoFailed'),
        description: outcome?.reason,
        files: [{ path }],
      })
    }).catch((error: unknown) => {
      showToast({
        tone: 'error',
        title: t('produced.fileUndoFailed'),
        description: error instanceof Error ? error.message : String(error),
        files: [],
      })
    }).finally(() => {
      setHunkPending(current => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
    })
  }, [
    anyFilePending, applyChanges, approved, approvedHunks, filePending, hunkPending,
    hunkStates, reviews, showToast, statusPending, t, togglePending,
  ])

  /** Refresh per-hunk Host states whenever the drawer focuses one file. */
  useEffect(() => {
    if (reviewScope?.kind !== 'file') return
    const review = reviews.find(item => item.path === reviewScope.path)
    if (review === undefined || review.diffs.length === 0) return
    const hunkFiles = review.diffs.map(diff => ({ path: review.path, diffs: [diff] }))
    let active = true
    void inspectChanges({ action: 'undo', files: hunkFiles }).then((result) => {
      if (!active) return
      setHunkStates(current => {
        const next = new Map(current)
        result.files.forEach((file, index) => {
          if (file !== undefined && file.path === review.path) {
            next.set(hunkId(review.path, index), file.state)
          }
        })
        return next
      })
    }).catch(() => {
      // Unknown hunk states stay usable; execution re-checks on the Host.
    })
    return () => { active = false }
  }, [inspectChanges, reviewScope, reviews])

  const openReview = useCallback((scope: ReviewScope, trigger: HTMLButtonElement) => {
    if (!claimReviewDrawer(reviewOwnerRef.current)) return
    triggerRef.current = trigger
    setCopied(false)
    setReviewScope(scope)
  }, [])
  const closeReview = useCallback(() => {
    releaseReviewDrawer(reviewOwnerRef.current)
    setReviewScope(null)
  }, [])

  useEffect(() => () => { releaseReviewDrawer(reviewOwnerRef.current) }, [])

  useEffect(() => {
    if (reviewScope === null) return
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeReview()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      triggerRef.current?.focus()
    }
  }, [closeReview, reviewScope])

  /** Close the drawer when pressing anywhere outside it (or its opener). */
  useEffect(() => {
    if (reviewScope === null) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (target === null) return
      if (drawerRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      closeReview()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => { document.removeEventListener('pointerdown', onPointerDown) }
  }, [closeReview, reviewScope])

  useEffect(() => () => {
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
  }, [])

  const effectiveDrawerRatio = drawerRatio ?? DRAWER_DEFAULT_RATIO
  const drawerWidthViewportPercent = drawerRatio === null
    ? null
    : Number((drawerRatio * 100).toFixed(2))
  const drawerTrack = drawerTrackForRatio(effectiveDrawerRatio)
  const reviewIsOpen = reviewScope !== null

  useLayoutEffect(() => {
    if (!reviewIsOpen || currentViewportWidth <= MOBILE_BREAKPOINT
      || cardRef.current === null) {
      setIsHostSplit(false)
      return
    }
    const layout = findHostSplitLayout(cardRef.current)
    if (layout === null) {
      setIsHostSplit(false)
      return
    }

    const previousGridTemplateColumns = layout.frame.style.gridTemplateColumns
    const previousDrawerTrack = layout.frame.style.getPropertyValue(HOST_DRAWER_TRACK_PROPERTY)
    const previousDetailsVisibility = layout.details.style.visibility
    const previousDetailsPointerEvents = layout.details.style.pointerEvents
    const previousDetailsAriaHidden = layout.details.getAttribute('aria-hidden')
    const sidebarWidth = sidebarTrackWidth(layout)
    const splitColumns = `${sidebarWidth}px minmax(0, 1fr) var(${HOST_DRAWER_TRACK_PROPERTY})`
    layout.frame.style.setProperty(HOST_DRAWER_TRACK_PROPERTY, drawerTrack)
    layout.frame.style.gridTemplateColumns = splitColumns
    layout.details.style.visibility = 'hidden'
    layout.details.style.pointerEvents = 'none'
    layout.details.setAttribute('aria-hidden', 'true')
    hostSplitRef.current = {
      layout, splitColumns, previousGridTemplateColumns, previousDrawerTrack,
    }
    setIsHostSplit(true)

    return () => {
      if (layout.frame.style.gridTemplateColumns === splitColumns) {
        layout.frame.style.gridTemplateColumns = previousGridTemplateColumns
      }
      if (previousDrawerTrack === '') {
        layout.frame.style.removeProperty(HOST_DRAWER_TRACK_PROPERTY)
      } else {
        layout.frame.style.setProperty(HOST_DRAWER_TRACK_PROPERTY, previousDrawerTrack)
      }
      layout.details.style.visibility = previousDetailsVisibility
      layout.details.style.pointerEvents = previousDetailsPointerEvents
      if (previousDetailsAriaHidden === null) {
        layout.details.removeAttribute('aria-hidden')
      } else {
        layout.details.setAttribute('aria-hidden', previousDetailsAriaHidden)
      }
      hostSplitRef.current = null
    }
  }, [currentViewportWidth, reviewIsOpen])

  useLayoutEffect(() => {
    hostSplitRef.current?.layout.frame.style.setProperty(HOST_DRAWER_TRACK_PROPERTY, drawerTrack)
  }, [drawerTrack])

  useEffect(() => {
    const onResize = (): void => { setCurrentViewportWidth(viewportWidth()) }
    window.addEventListener('resize', onResize)
    return () => { window.removeEventListener('resize', onResize) }
  }, [])

  useEffect(() => {
    if (reviewScope?.kind !== 'file') return
    if (!reviews.some(review => review.path === reviewScope.path)) closeReview()
  }, [closeReview, reviewScope, reviews])

  const copyVisibleDiff = useCallback(() => {
    if (visibleDiffs.length === 0 || copied) return
    const pending = navigator.clipboard?.writeText(unifiedDiffText(visibleDiffs))
    if (pending === undefined) return
    setCopied(true)
    void pending.then(() => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => {
        setCopied(false)
        copyResetRef.current = null
      }, 1000)
    }).catch(() => { setCopied(false) })
  }, [copied, visibleDiffs])

  const onResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || window.innerWidth <= MOBILE_BREAKPOINT) return
    const startRatio = drawerRatio ?? DRAWER_DEFAULT_RATIO
    const startWidth = viewportWidth() * startRatio
    resizeDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      currentRatio: startRatio,
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    setIsResizing(true)
    event.preventDefault()
  }, [drawerRatio])

  const onResizePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    const next = clampDrawerRatio(
      (drag.startWidth + drag.startX - event.clientX) / viewportWidth(),
    )
    drag.currentRatio = next
    hostSplitRef.current?.layout.frame.style.setProperty(
      HOST_DRAWER_TRACK_PROPERTY,
      drawerTrackForRatio(next),
    )
    setDrawerRatio(next)
  }, [])

  const finishResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = resizeDragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    resizeDragRef.current = null
    setIsResizing(false)
    persistDrawerRatio(drag.currentRatio)
  }, [])

  const onResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const current = drawerRatio ?? DRAWER_DEFAULT_RATIO
    let next: number | null = null
    if (event.key === 'ArrowLeft') next = clampDrawerRatio(current + DRAWER_KEYBOARD_STEP)
    if (event.key === 'ArrowRight') next = clampDrawerRatio(current - DRAWER_KEYBOARD_STEP)
    if (event.key === 'Home') next = DRAWER_MIN_RATIO
    if (event.key === 'End') next = DRAWER_MAX_RATIO
    if (next === null) return
    event.preventDefault()
    hostSplitRef.current?.layout.frame.style.setProperty(
      HOST_DRAWER_TRACK_PROPERTY,
      drawerTrackForRatio(next),
    )
    setDrawerRatio(next)
    persistDrawerRatio(next)
  }, [drawerRatio])

  const resetDrawerWidth = useCallback(() => {
    hostSplitRef.current?.layout.frame.style.setProperty(
      HOST_DRAWER_TRACK_PROPERTY,
      drawerTrackForRatio(DRAWER_DEFAULT_RATIO),
    )
    setDrawerRatio(null)
    persistDrawerRatio(null)
  }, [])

  const effectiveDrawerWidth = Math.round(currentViewportWidth * effectiveDrawerRatio)
  const drawerStyle = drawerRatio === null
    ? undefined
    : { '--review-drawer-width': `${drawerWidthViewportPercent}vw` } as CSSProperties

  return (
    <>
      <section ref={cardRef} className={css.card} aria-label={t('produced.summary')}>
        <header className={css.cardHeader}>
          <span className={css.fileIconWrap}><FileIcon /></span>
          <div className={css.cardTitleBlock}>
            <span className={css.cardTitle}>
              {reviews.length === 1
                ? t('produced.editedOne')
                : t('produced.edited', { count: String(reviews.length) })}
            </span>
            <Stats
              stats={totalStats}
              label={t('review.stats', {
                added: String(totalStats.added), removed: String(totalStats.removed),
              })}
            />
          </div>
          <button
            type="button"
            className={css.toggleButton}
            disabled={statusPending || togglePending || anyFilePending || allApproved}
            aria-label={t('produced.approveAll')}
            title={t('produced.approveAll')}
            onClick={approveAll}
          >
            <ApproveAllIcon />
          </button>
          <button
            type="button"
            className={css.toggleButton}
            disabled={statusPending || togglePending || anyFilePending || !hasUndoableFiles}
            title={!statusPending && !hasUndoableFiles
              ? t('produced.toggleUnavailable')
              : t('produced.undoAll')}
            aria-label={t('produced.undoAll')}
            onClick={runUndoAll}
          >
            {togglePending ? <LoaderIcon /> : <UndoAllIcon />}
          </button>
        </header>
        <div className={css.fileList}>
          {shown.map(({ review, stats }) => {
            const pending = filePending.has(review.path)
            const isApproved = approved.has(review.path)
            const undoDisabled = statusPending || togglePending || anyFilePending || pending
              || !undoablePaths.has(review.path)
            const undoTitle = statusPending ? undefined : undoTitleFor(review.path)
            return (
              <div key={review.path} className={css.fileRow} title={review.path}>
                <button
                  type="button"
                  className={css.fileRowOpen}
                  aria-label={t('produced.review', { name: review.path })}
                  onClick={event => {
                    openReview({ kind: 'file', path: review.path }, event.currentTarget)
                  }}
                >
                  <span className={css.fileName}>{basename(review.path)}</span>
                  {review.sources !== undefined && review.sources.length > 0 && (
                    <span
                      className={css.fileSources}
                      aria-label={t('produced.sources', { names: review.sources.join(', ') })}
                    >
                      {review.sources.map(source => (
                        <span key={source} className={css.fileSource}>{source}</span>
                      ))}
                    </span>
                  )}
                  <Stats
                    stats={stats}
                    label={t('review.stats', {
                      added: String(stats.added), removed: String(stats.removed),
                    })}
                  />
                </button>
                <button
                  type="button"
                  className={`${css.fileApprove} ${isApproved ? css.fileApproveApproved : ''}`}
                  disabled={statusPending || togglePending || anyFilePending || isApproved}
                  aria-label={t('produced.approveFile', { name: review.path })}
                  title={isApproved ? t('produced.approved') : t('produced.approve')}
                  onClick={() => { approveFile(review.path) }}
                >
                  <ApproveIcon />
                </button>
                <button
                  type="button"
                  className={css.fileToggle}
                  disabled={undoDisabled}
                  title={undoTitle ?? t('produced.undo')}
                  aria-label={t('produced.undoFile', { name: review.path })}
                  onClick={() => { runFileUndo(review.path) }}
                >
                  {pending ? <LoaderIcon /> : <UndoIcon />}
                </button>
              </div>
            )
          })}
          {(hidden > 0 || expanded) && (
            <button
              type="button"
              className={css.moreFiles}
              aria-expanded={expanded}
              onClick={() => { setExpanded(current => !current) }}
            >
              {expanded
                ? t('produced.collapse')
                : (hidden === 1
                  ? t('produced.moreOne')
                  : t('produced.more', { count: String(hidden) }))}
            </button>
          )}
        </div>
      </section>

      {reviewScope !== null && createPortal(
        <aside
          ref={drawerRef}
          className={`${css.drawer} ${isHostSplit ? css.drawerSplit : ''} ${isResizing ? css.drawerResizing : ''}`}
          style={drawerStyle}
          role="dialog"
          aria-modal="false"
          aria-labelledby={drawerTitleId}
          data-review-drawer=""
        >
          <div
            className={css.resizeHandle}
            role="separator"
            aria-label={t('review.resize')}
            aria-orientation="vertical"
            aria-valuemin={Math.round(currentViewportWidth * DRAWER_MIN_RATIO)}
            aria-valuemax={Math.round(currentViewportWidth * DRAWER_MAX_RATIO)}
            aria-valuenow={effectiveDrawerWidth}
            tabIndex={0}
            title={t('review.resizeHint')}
            onPointerDown={onResizePointerDown}
            onPointerMove={onResizePointerMove}
            onPointerUp={finishResize}
            onPointerCancel={finishResize}
            onKeyDown={onResizeKeyDown}
            onDoubleClick={resetDrawerWidth}
          />
          <header className={css.drawerHeader}>
            <div className={css.drawerHeading}>
              <span id={drawerTitleId} className={css.drawerTitle}>{t('review.title')}</span>
              <span className={css.drawerSubtitle}>
                {visibleReviews.length === 1
                  ? t('review.fileOne')
                  : t('review.files', { count: String(visibleReviews.length) })}
              </span>
            </div>
            <Stats
              stats={visibleStats}
              label={t('review.stats', {
                added: String(visibleStats.added), removed: String(visibleStats.removed),
              })}
            />
            <button
              type="button"
              className={css.toolbarButton}
              disabled={visibleDiffs.length === 0}
              onClick={copyVisibleDiff}
            >
              <CopyIcon />
              {copied ? t('review.copied') : t('review.copy')}
            </button>
            <button
              ref={closeButtonRef}
              type="button"
              className={css.closeButton}
              aria-label={t('review.close')}
              title={t('review.closeHint')}
              onClick={closeReview}
            >
              <CloseIcon />
            </button>
          </header>
          <div className={css.drawerBody}>
            {visibleReviews.map((review) => {
              const stats = summarizeDiffs(review.diffs)
              const relativePath = displayPath(review.path, projectRoot)
              return (
                <section key={review.path} className={css.reviewFile}>
                  <header className={css.reviewFileHeader}>
                    <span className={css.reviewStatus}>M</span>
                    <span className={css.reviewPath} title={relativePath}>{relativePath}</span>
                    {review.sources !== undefined && review.sources.length > 0 && (
                      <span
                        className={css.fileSources}
                        aria-label={t('produced.sources', { names: review.sources.join(', ') })}
                      >
                        {review.sources.map(source => (
                          <span key={source} className={css.fileSource}>{source}</span>
                        ))}
                      </span>
                    )}
                    <Stats
                      stats={stats}
                      label={t('review.stats', {
                        added: String(stats.added), removed: String(stats.removed),
                      })}
                    />
                    <button
                      type="button"
                      className={`${css.fileApprove} ${approved.has(review.path) ? css.fileApproveApproved : ''}`}
                      disabled={statusPending || togglePending || anyFilePending || approved.has(review.path)}
                      aria-label={t('produced.approveFile', { name: review.path })}
                      title={approved.has(review.path) ? t('produced.approved') : t('produced.approve')}
                      onClick={() => { approveFile(review.path) }}
                    >
                      <ApproveIcon />
                    </button>
                    <button
                      type="button"
                      className={css.fileToggle}
                      disabled={statusPending || togglePending || anyFilePending
                        || filePending.has(review.path) || !undoablePaths.has(review.path)}
                      title={(statusPending ? undefined : undoTitleFor(review.path)) ?? t('produced.undo')}
                      aria-label={t('produced.undoFile', { name: review.path })}
                      onClick={() => { runFileUndo(review.path) }}
                    >
                      {filePending.has(review.path) ? <LoaderIcon /> : <UndoIcon />}
                    </button>
                    <button
                      type="button"
                      className={css.openButton}
                      onClick={() => { openFile(review.path) }}
                    >
                      {t('review.openInEditor')}
                    </button>
                  </header>
                  {review.diffs.length === 0
                    ? <p className={css.reviewUnavailable}>{t('review.unavailable')}</p>
                    : (
                      <div className={css.hunkList}>
                        {review.diffs.map((diff, index) => {
                          const id = hunkId(review.path, index)
                          const hState = hunkStates.get(id)
                          const hApproved = approved.has(review.path) || approvedHunks.has(id)
                          const hPending = hunkPending.has(id)
                          const hReversible = hunkReversible(review.path, diff)
                          const hBlocked = hState === 'conflict' || hState === 'error'
                          const hUndoDisabled = statusPending || togglePending || anyFilePending
                            || hPending || filePending.has(review.path) || !hReversible
                            || hApproved || hState === 'undone' || hBlocked
                          const hUndoTitle = !hReversible
                            ? (diff.oldText === null
                              ? t('produced.hunkCreated')
                              : t('produced.toggleUnavailable'))
                            : hApproved
                              ? t('produced.hunkApprovedLocked')
                              : hState === 'undone'
                                ? t('produced.hunkAlreadyUndone')
                                : hBlocked
                                  ? t('produced.fileToggleBlocked')
                                  : undefined
                          return (
                            <div key={id} className={css.hunkBlock}>
                              <div className={css.hunkToolbar}>
                                <span className={css.hunkLabel}>
                                  @@ -{diff.oldStart ?? 1} +{diff.newStart ?? 1} @@
                                </span>
                                <button
                                  type="button"
                                  className={`${css.fileApprove} ${hApproved ? css.fileApproveApproved : ''}`}
                                  disabled={statusPending || togglePending || anyFilePending || hApproved}
                                  aria-label={t('produced.approveHunk')}
                                  title={hApproved ? t('produced.approved') : t('produced.approveHunk')}
                                  onClick={() => { approveHunk(review.path, index) }}
                                >
                                  <ApproveIcon />
                                </button>
                                <button
                                  type="button"
                                  className={css.fileToggle}
                                  disabled={hUndoDisabled}
                                  title={(statusPending ? undefined : hUndoTitle) ?? t('produced.undoHunk')}
                                  aria-label={t('produced.undoHunk')}
                                  onClick={() => { runHunkUndo(review.path, index) }}
                                >
                                  {hPending ? <LoaderIcon /> : <UndoIcon />}
                                </button>
                              </div>
                              <UnifiedDiff
                                diffs={[diff]}
                                contextLines={3}
                                showCopyButton={false}
                                showFileHeaders={false}
                                labels={{
                                  copy: t('review.copy'),
                                  copied: t('review.copied'),
                                  showUnchanged: count => t('review.showUnchanged', { count: String(count) }),
                                  hideUnchanged: count => t('review.hideUnchanged', { count: String(count) }),
                                }}
                                className={css.reviewDiff}
                              />
                            </div>
                          )
                        })}
                      </div>
                    )}
                </section>
              )
            })}
          </div>
        </aside>,
        document.body,
      )}
      {toast !== null && (
        <ResultToast
          key={toast.seq}
          notice={toast}
          closeLabel={t('produced.noticeClose')}
          dismissLabel={t('produced.noticeDismiss')}
          fileListLabel={t('produced.skippedFiles', { count: String(toast.files.length) })}
          fileOpenLabel={path => t('produced.open', { name: basename(path) })}
          openFile={openFile}
          onDone={() => { setToast(current => current?.seq === toast.seq ? null : current) }}
        />
      )}
    </>
  )
}
