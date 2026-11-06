import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

test('the backend entry point has no missing local module dependencies', () => {
  const root = dirname(fileURLToPath(import.meta.url))
  const options: ts.CompilerOptions = { moduleResolution: ts.ModuleResolutionKind.NodeNext, module: ts.ModuleKind.NodeNext }
  const visited = new Set<string>()
  const missing: string[] = []

  function visitFile(file: string) {
    if (visited.has(file)) return
    visited.add(file)
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    function visit(node: ts.Node) {
      const specifier = (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ? node.moduleSpecifier
        : ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword ? node.arguments[0] : undefined
      if (specifier && ts.isStringLiteral(specifier) && specifier.text.startsWith('.')) {
        const result = ts.resolveModuleName(specifier.text, file, options, ts.sys).resolvedModule
        if (!result) missing.push(`${relative(root, file)} → ${specifier.text}`)
        else if (result.resolvedFileName.endsWith('.d.ts')) {
          const runtimeFile = result.resolvedFileName.replace(/\.d\.ts$/, '.js')
          if (existsSync(runtimeFile)) visitFile(runtimeFile)
        } else visitFile(result.resolvedFileName)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  visitFile(resolve(root, 'index.ts'))
  assert.deepEqual(missing, [], `Missing startup dependencies:\n${missing.join('\n')}`)
})
