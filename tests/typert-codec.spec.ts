import { describe, expect, it } from 'vitest'
import type { InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import { PACKAGE_NAME } from '../src/typert-descriptors.ts'
import { TYPERT } from '../src/typert.host.ts'

/**
 * `dsh` has validated strict Typert codecs two different ways, so each codec has
 * to satisfy both:
 * - dsh <= 0.1.5-rc.2 reads `codec.schema` and requires a zod v4 instance.
 * - dsh >= 0.1.6-alpha.1 ignores `schema` and requires a `create()` factory.
 *
 * These tests mirror the two validator checks verbatim; a codec that drops
 * either field makes the whole plugin tree fail to load, not just one endpoint.
 */

type Codec = InvocationDescriptor['parameters'][number]['codec']

const WIRE_SAMPLES: Record<string, unknown> = {
  '@deepseek-ai/dsh-session/types#SessionId': 'session-1',
  [`${PACKAGE_NAME}#FileReviewRequest`]: {
    action: 'undo',
    files: [{ path: 'src/a.ts', diffs: [{ path: 'src/a.ts', oldText: null, newText: 'next' }] }],
  },
  [`${PACKAGE_NAME}#FileReviewResult`]: {
    files: [{ path: 'src/a.ts', state: 'applied', changed: true }],
  },
}

const codecs = TYPERT.invocations.flatMap((descriptor) => [
  ...descriptor.parameters.map((parameter) => ({
    subject: `${descriptor.id} parameter ${parameter.name}`,
    codec: parameter.codec,
  })),
  { subject: `${descriptor.id} result`, codec: descriptor.result },
])

function strictCodec(codec: Codec): Extract<Codec, { mode: 'strict' }> {
  if (codec.mode !== 'strict') throw new Error('the file-review endpoints require strict codecs')
  return codec
}

describe('Typert strict codecs', () => {
  it('covers every parameter and result of both endpoints', () => {
    expect(codecs.map(({ subject }) => subject)).toEqual([
      `${PACKAGE_NAME}#fileReview/status parameter agent`,
      `${PACKAGE_NAME}#fileReview/status parameter request`,
      `${PACKAGE_NAME}#fileReview/status result`,
      `${PACKAGE_NAME}#fileReview/apply parameter agent`,
      `${PACKAGE_NAME}#fileReview/apply parameter request`,
      `${PACKAGE_NAME}#fileReview/apply result`,
    ])
  })

  it.each(codecs)('$subject exposes a zod v4 schema', ({ codec }) => {
    const value = strictCodec(codec)

    expect('_zod' in value.schema).toBe(true)
    expect(typeof value.schema.parse).toBe('function')
  })

  it.each(codecs)('$subject exposes a create() factory', ({ codec }) => {
    const value = strictCodec(codec)

    expect(typeof value.create).toBe('function')
    expect(value.create()).toBe(value.schema)
  })

  it.each(codecs)('$subject decodes one wire value through both contracts', ({ codec }) => {
    const value = strictCodec(codec)
    const sample = WIRE_SAMPLES[value.typeSymbol]
    if (sample === undefined) throw new Error(`no wire sample for ${value.typeSymbol}`)

    expect(value.create().parse(sample)).toEqual(value.schema.parse(sample))
  })
})
