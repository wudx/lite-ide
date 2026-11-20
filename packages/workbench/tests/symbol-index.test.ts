import { beforeEach, describe, expect, it } from 'vitest'
import { createMockBackend, MOCK_DEMO_PATHS } from '@lite-ide/protocol'
import {
  createSymbolIndexService,
  extractDefinitions,
  languageOfRelPath,
} from '../src/symbol-index'

describe('languageOfRelPath', () => {
  it('maps known code extensions and rejects the rest', () => {
    expect(languageOfRelPath('src/kernel.ts')).toBe('js')
    expect(languageOfRelPath('src/main.rs')).toBe('rust')
    expect(languageOfRelPath('app.py')).toBe('python')
    expect(languageOfRelPath('main.go')).toBe('go')
    expect(languageOfRelPath('lib.rs')).toBe('rust')
    expect(languageOfRelPath('README.md')).toBeNull()
    expect(languageOfRelPath('logo.psd.meta')).toBeNull()
  })
})

describe('extractDefinitions', () => {
  it('extracts TS functions, interfaces, classes, consts and methods', () => {
    const content = [
      'import { x } from "./other"',
      '',
      'export interface FileStore {',
      '  load(path: string): Promise<string>',
      '}',
      '',
      'export class MemoryFileStore implements FileStore {',
      '  private entries = new Map<string, string>()',
      '',
      '  async load(path: string): Promise<string> {',
      '    return this.entries.get(path) ?? ""',
      '  }',
      '}',
      '',
      'export function createFileStoreKey() {',
      '  return 1',
      '}',
      'const DEFAULT_LIMIT = 10',
    ].join('\n')
    const defs = extractDefinitions('a.ts', 'js', content)
    const byName = new Map(defs.map((d) => [`${d.kind}:${d.name}`, d]))

    expect(byName.get('interface:FileStore')?.line).toBe(3)
    expect(byName.get('class:MemoryFileStore')?.line).toBe(7)
    expect(byName.get('method:load')?.line).toBe(10)
    expect(byName.get('function:createFileStoreKey')?.line).toBe(15)
    expect(byName.get('variable:DEFAULT_LIMIT')?.line).toBe(18)
    // Comment and import lines never yield definitions.
    expect(defs.some((d) => d.name === 'x')).toBe(false)
  })

  it('skips comment lines and block comments', () => {
    const content = [
      '// function fakeOne() {}',
      '/*',
      ' * function fakeTwo() {}',
      ' */',
      'function realOne() {}',
    ].join('\n')
    const defs = extractDefinitions('a.ts', 'js', content)
    expect(defs.map((d) => d.name)).toEqual(['realOne'])
    expect(defs[0].line).toBe(5)
  })

  it('extracts Rust traits, structs, impl blocks and impl-for targets', () => {
    const content = [
      'pub trait PathVisitor {',
      '    fn visit(&mut self, path: &str);',
      '}',
      '',
      'pub struct PrintVisitor {',
      '    pub label: String,',
      '}',
      '',
      'impl PathVisitor for PrintVisitor {',
      '    fn visit(&mut self, path: &str) {',
      '        println!("{}: {}", self.label, path);',
      '    }',
      '}',
      '',
      'pub fn scan_workspace(visitor: &mut dyn PathVisitor) {}',
    ].join('\n')
    const defs = extractDefinitions('a.rs', 'rust', content)
    const byName = new Map(defs.map((d) => [`${d.kind}:${d.name}`, d]))

    expect(byName.get('trait:PathVisitor')?.line).toBe(1)
    expect(byName.get('struct:PrintVisitor')?.line).toBe(5)
    // `impl PathVisitor for PrintVisitor` registers an impl for the trait.
    expect(byName.get('impl:PathVisitor')?.line).toBe(9)
    // `visit` is defined both in the trait and in the impl block.
    expect(defs.filter((d) => d.name === 'visit').map((d) => d.line)).toEqual([2, 10])
    expect(byName.get('function:scan_workspace')?.line).toBe(15)
  })

  it('extracts Python defs, classes and module-level assignments', () => {
    const content = [
      'MAX_DEPTH = 8',
      '',
      'class Scanner:',
      '    def scan(self):',
      '        local_var = 1',
      '',
      'def main():',
      '    pass',
    ].join('\n')
    const defs = extractDefinitions('a.py', 'python', content)
    const byName = new Map(defs.map((d) => [`${d.kind}:${d.name}`, d]))

    expect(byName.get('variable:MAX_DEPTH')?.line).toBe(1)
    expect(byName.get('class:Scanner')?.line).toBe(3)
    expect(byName.get('function:scan')?.line).toBe(4)
    expect(byName.get('function:main')?.line).toBe(7)
    // Indented locals are not definitions.
    expect(defs.some((d) => d.name === 'local_var')).toBe(false)
  })
})

describe('createSymbolIndexService over the mock backend', () => {
  let backend = createMockBackend()
  let projectId = ''

  beforeEach(async () => {
    backend = createMockBackend()
    const info = await backend.openProject(MOCK_DEMO_PATHS[0], () => {})
    projectId = info.id
  })

  function createService() {
    return createSymbolIndexService(backend, projectId)
  }

  it('resolves definitions across files', async () => {
    const index = createService()
    const defs = await index.definitions('createServiceKey')
    expect(defs.length).toBeGreaterThanOrEqual(1)
    expect(defs.some((d) => d.relPath === 'src/kernel.ts' && d.kind === 'function')).toBe(true)

    const classDefs = await index.definitions('MemoryFileStore')
    expect(classDefs.some((d) => d.relPath === 'src/services.ts' && d.kind === 'class')).toBe(true)
    expect(index.status()).toBe('ready')
  })

  it('reports references with definitions flagged', async () => {
    const index = createService()
    const occurrences = await index.occurrences('createServiceKey')
    const kernelDef = occurrences.find((o) => o.relPath === 'src/kernel.ts' && o.isDefinition)
    const servicesRef = occurrences.find((o) => o.relPath === 'src/services.ts')

    expect(kernelDef).toBeTruthy()
    expect(kernelDef?.kind).toBe('function')
    // The usage inside createFileStoreKey's body is a reference, not a def.
    expect(servicesRef?.isDefinition).toBe(false)
  })

  it('word-boundary matching stays case-sensitive and exact', async () => {
    const index = createService()
    const occurrences = await index.occurrences('FileStore')
    // `FileStore` and `MemoryFileStore` are distinct symbols.
    expect(occurrences.some((o) => o.relPath === 'src/services.ts')).toBe(true)
    expect(occurrences.every((o) => o.text.includes('FileStore'))).toBe(true)
  })

  it('finds TS interface implementations and Rust trait impls', async () => {
    const index = createService()
    const impls = await index.implementations('FileStore', 'interface')
    expect(impls.length).toBeGreaterThanOrEqual(1)
    expect(impls.some((d) => d.name === 'MemoryFileStore' && d.relPath === 'src/services.ts')).toBe(true)
  })

  it('prefers dirty editor buffer content over disk', async () => {
    let override: string | null = null
    const index = createSymbolIndexService(backend, projectId, {
      getContentOverride: (relPath) => (relPath === 'src/kernel.ts' ? override : null),
    })

    override = 'export function brandNewSymbol() {}\n'
    const defs = await index.definitions('brandNewSymbol')
    expect(defs.length).toBe(1)
    expect(defs[0].relPath).toBe('src/kernel.ts')
  })

  it('invalidate() forces a rebuild that sees new files', async () => {
    const index = createService()
    expect((await index.definitions('todoTask')).length).toBe(0)

    await backend.createDir(projectId, 'notes')
    await backend.createFile(projectId, 'notes/task.ts')
    await backend.writeText(projectId, 'notes/task.ts', 'export function todoTask() {}\n')
    index.invalidate()
    const defs = await index.definitions('todoTask')
    expect(defs.map((d) => d.relPath)).toContain('notes/task.ts')
  })

  it('Rust demo resolves trait implementations across files', async () => {
    const rustInfo = await backend.openProject(MOCK_DEMO_PATHS[1], () => {})
    const index = createSymbolIndexService(backend, rustInfo.id)
    const impls = await index.implementations('PathVisitor', 'trait')
    expect(impls.some((d) => d.name === 'PrintVisitor' && d.relPath === 'src/scanner.rs')).toBe(true)

    const structImpls = await index.implementations('PrintVisitor', 'struct')
    expect(structImpls.some((d) => d.relPath === 'src/scanner.rs')).toBe(true)
  })
})
