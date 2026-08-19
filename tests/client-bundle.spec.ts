// @vitest-environment jsdom
import { URL as FileURL } from 'node:url'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import * as ReactDOM from 'react-dom'
import { describe, expect, it } from 'vitest'

interface ClientHandoff {
  readonly id: string
  readonly factory: (require: (id: string) => unknown) => unknown
}

describe('published browser artifact', () => {
  it('registers through the Harness module loader and materializes without repository modules', async () => {
    let handoff: ClientHandoff | undefined
    const browserWindow = window as unknown as {
      __ModuleLoader__?: { load(value: ClientHandoff): void }
    }
    browserWindow.__ModuleLoader__ = { load: (value) => { handoff = value } }
    // Vite rewrites literal `new URL(` calls (and the jsdom global URL
    // mis-resolves `file:` bases), so build the artifact URL through an
    // aliased node:url URL constructor instead.
    const artifact = new FileURL('../lib/client.js', import.meta.url)
    await import(/* @vite-ignore */ `${artifact.href}?test=${String(Date.now())}`)

    expect(handoff?.id).toBe('@dsh-xhl/dsh-file-review')
    const shared: Record<string, unknown> = {
      react: React,
      'react/jsx-runtime': jsxRuntime,
      'react-dom': ReactDOM,
    }
    const client = handoff?.factory((id) => {
      if (!(id in shared)) throw new Error(`unexpected shared module: ${id}`)
      return shared[id]
    }) as { apply?: unknown; inject?: unknown } | undefined
    expect(client?.apply).toBeTypeOf('function')
    expect(client?.inject).toEqual(['slots', 'locale', 'conversationEvents', 'remote', 'sessions'])
    expect(document.querySelectorAll('style[data-plugin="@dsh-xhl/dsh-file-review"]')).toHaveLength(2)
  })
})
