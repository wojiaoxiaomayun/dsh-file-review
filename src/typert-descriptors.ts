/** Strict Typert codecs shared by the Host and browser contribution artifacts. */

import { z } from 'zod'
import type { InvocationDescriptor, TypertCodec, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

export const PACKAGE_NAME = '@dsh-xhl/dsh-file-review'

const diffSchema = z.object({
  path: z.string(),
  oldText: z.string().nullable(),
  newText: z.string(),
  oldStart: z.number().int().min(1).optional(),
  newStart: z.number().int().min(1).optional(),
})

const requestSchema = z.object({
  action: z.enum(['undo', 'redo']),
  files: z.array(z.object({ path: z.string(), diffs: z.array(diffSchema) })),
})

const resultSchema = z.object({
  files: z.array(z.object({
    path: z.string(),
    state: z.enum(['applied', 'undone', 'conflict', 'unsupported', 'error']),
    changed: z.boolean(),
    reason: z.string().optional(),
  })),
})

/**
 * dsh <= 0.1.5-rc.2 validates a strict codec through `schema` (a zod v4
 * instance), while dsh >= 0.1.6-alpha.1 validates the lazy `create()` factory
 * instead. Both are carried so one published artifact loads on either line.
 */
type StrictCodec = Extract<TypertCodec, { mode: 'strict' }> & {
  readonly schema: TypertSchema
  readonly create: () => TypertSchema
}

const agentSchema = z.intersection(z.string(), z.unknown())

const agentCodec: StrictCodec = {
  mode: 'strict',
  typeSymbol: '@deepseek-ai/dsh-session/types#SessionId',
  schema: agentSchema,
  create: () => agentSchema,
}

const requestCodec: StrictCodec = {
  mode: 'strict',
  typeSymbol: `${PACKAGE_NAME}#FileReviewRequest`,
  schema: requestSchema,
  create: () => requestSchema,
}

const resultCodec: StrictCodec = {
  mode: 'strict',
  typeSymbol: `${PACKAGE_NAME}#FileReviewResult`,
  schema: resultSchema,
  create: () => resultSchema,
}

function descriptor(method: 'status' | 'apply'): InvocationDescriptor {
  return {
    id: `${PACKAGE_NAME}#fileReview/${method}`,
    service: 'fileReview',
    namespace: 'fileReview',
    method,
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [{
      name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'agent', codec: agentCodec,
    }, {
      name: 'request', wire: 'request', source: 'json', codec: requestCodec,
    }],
    result: resultCodec,
  }
}

export const FILE_REVIEW_INVOCATIONS: readonly InvocationDescriptor[] = [
  descriptor('status'),
  descriptor('apply'),
]
