import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const readJson = <T>(name: string): T =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8')) as T

type TsConfig = { compilerOptions: Record<string, unknown> }

type PackageJson = {
  packageManager?: string
  engines?: { node?: string }
  type?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const tsconfig = readJson<TsConfig>('tsconfig.json')
const pkg = readJson<PackageJson>('package.json')

describe('toolchain configuration', () => {
  it('pins the compiler options', () => {
    expect(tsconfig.compilerOptions).toEqual({
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      lib: ['ES2024'],
      strict: true,
      skipLibCheck: true,
      noUncheckedIndexedAccess: true,
      verbatimModuleSyntax: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      declaration: true,
      types: ['node'],
      noEmit: true,
    })
  })

  it('pins the package manifest metadata', () => {
    expect(pkg.packageManager).toBe('pnpm@12.15.0')
    expect(pkg.engines?.node).toBe('>=24')
    expect(pkg.type).toBe('module')
  })

  it('installs only the expected dependencies', () => {
    const names = [
      ...new Set([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]),
    ].sort()
    expect(names).toEqual(['@types/node', 'tsdown', 'typescript', 'vitest', 'zod'])
  })

  it('pins the exact devDependency versions', () => {
    expect(pkg.devDependencies).toEqual({
      '@types/node': '24.19.2',
      tsdown: '0.22.14',
      typescript: '6.0.3',
      vitest: '4.1.8',
    })
  })

  it('pins the exact dependency versions', () => {
    expect(pkg.dependencies).toEqual({
      zod: '4.4.3',
    })
  })
})
