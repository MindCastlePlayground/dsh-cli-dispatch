// Contract test for the Web panel bundle.
//
// The panel is hand-authored in the `window.__ModuleLoader__.load({ id, factory })`
// format that `dsh-client-modules` serves. A syntax check cannot prove it works,
// and the browser bundle cannot be imported as ESM, so this test executes it in a
// Node `vm` with a stub `window` and a stub `require`: the same shape the host
// gives it. It fails if the bundle registers under the wrong id, asks for a
// module outside the shared baseline, or stops contributing its sidebar entry
// and `main` panel.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const packageDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const bundlePath = path.join(packageDir, 'client', 'index.js')

// The shared module table the shell seeds for every plugin bundle. A bundle may
// require these and nothing else.
const BASELINE = new Set(['react', 'react/jsx-runtime'])

const h = (type, props) => ({ type: typeof type === 'string' ? type : (type?.name ?? 'component'), props: props ?? {} })
const jsxRuntime = { jsx: h, jsxs: h, Fragment: 'fragment' }
const react = {
  useCallback: (fn) => fn,
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
}

/** Execute the bundle and return what it registered. */
async function loadBundle() {
  const source = await readFile(bundlePath, 'utf8')
  const registrations = []
  const requested = []
  const window = {
    __ModuleLoader__: {
      load: (registration) => registrations.push(registration),
    },
  }
  const context = vm.createContext({ window, fetch: async () => ({ text: async () => '{}' }), console })
  vm.runInContext(source, context, { filename: bundlePath })

  const require = (request) => {
    requested.push(request)
    if (request === 'react') return react
    if (request === 'react/jsx-runtime') return jsxRuntime
    throw new Error(`the panel required a module outside the shared baseline: ${request}`)
  }

  return { registrations, requested, require }
}

test('the panel registers exactly one bundle under the package name', async () => {
  const { registrations } = await loadBundle()
  assert.equal(registrations.length, 1)
  assert.equal(registrations[0].id, '@local/dsh-cli-dispatch')
  assert.equal(typeof registrations[0].factory, 'function')
})

test('the panel asks only for baseline modules', async () => {
  const { registrations, requested, require } = await loadBundle()
  const exports = registrations[0].factory(require)
  assert.equal(typeof exports, 'object')
  for (const request of requested) {
    assert.ok(BASELINE.has(request), `unexpected require(${request})`)
  }
})

test('the panel exports the client plugin contract', async () => {
  const { registrations, require } = await loadBundle()
  const exports = registrations[0].factory(require)
  assert.equal(typeof exports.apply, 'function', 'the bundle must export apply(ctx)')
  assert.ok(Array.isArray(exports.inject), 'the bundle must export an inject list')
  for (const service of ['slots', 'layout']) {
    assert.ok(exports.inject.includes(service), `inject must include ${service}`)
  }
})

test('applying the panel registers its sidebar entry and main panel', async () => {
  const { registrations, require } = await loadBundle()
  const exports = registrations[0].factory(require)

  const registered = []
  const disposers = []
  const ctx = {
    slots: {
      inject: (name, callback) => {
        disposers.push(callback())
        return () => {}
      },
      register: (slot) => {
        registered.push(slot)
        return () => {}
      },
    },
    layout: { selectPanel: () => {} },
  }

  exports.apply(ctx)

  const names = registered.map((slot) => slot.name)
  assert.ok(names.includes('sidebar.panellist'), `sidebar entry missing (got ${names.join(', ')})`)
  const main = registered.find((slot) => slot.name === 'main')
  assert.ok(main !== undefined, 'the main panel slot is missing')
  assert.equal(main.key, 'cli-dispatch')

  const entry = registered.find((slot) => slot.name === 'sidebar.panellist')
  assert.equal(entry.id, 'cli-dispatch')
  assert.equal(entry.label, 'Dispatch')
  assert.equal(typeof entry.order, 'number')
})

test('the panel does not read the DOM at load time', async () => {
  // A bundle that touches document/window APIs while registering breaks the
  // lazy factory contract: nothing may run before materialization.
  const source = await readFile(bundlePath, 'utf8')
  const factoryBody = source.slice(source.indexOf('factory:'))
  for (const forbidden of ['document.', 'localStorage', 'window.location']) {
    assert.ok(!factoryBody.includes(forbidden), `the factory body must not touch ${forbidden}`)
  }
})
