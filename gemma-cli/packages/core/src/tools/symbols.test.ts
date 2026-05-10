import { describe, expect, it } from 'vitest';
import { detectLanguage, findDefinitions, listSymbols } from './symbols.js';

describe('detectLanguage', () => {
  it('maps file extensions to languages', () => {
    expect(detectLanguage('a.ts')).toBe('ts');
    expect(detectLanguage('a.tsx')).toBe('tsx');
    expect(detectLanguage('a.js')).toBe('js');
    expect(detectLanguage('a.py')).toBe('py');
    expect(detectLanguage('a.go')).toBe('go');
    expect(detectLanguage('a.rs')).toBe('rs');
    expect(detectLanguage('a.txt')).toBe('unknown');
  });
});

describe('listSymbols (TypeScript)', () => {
  it('finds exported function, class, interface, type, enum, and const', () => {
    const source = `
export function alpha() {}
export class Beta {}
export interface Gamma {}
export type Delta = string;
export enum Epsilon { A, B }
export const zeta = 1;
`;
    const symbols = listSymbols(source, 'ts');
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'function:alpha',
      'class:Beta',
      'interface:Gamma',
      'type:Delta',
      'enum:Epsilon',
      'const:zeta'
    ]);
    expect(symbols.every((s) => s.exported)).toBe(true);
  });

  it('captures non-exported declarations and reports correct line numbers', () => {
    const source = 'function helper() {\n  return 1\n}\n';
    const symbols = listSymbols(source, 'ts');
    expect(symbols).toEqual([
      { name: 'helper', kind: 'function', line: 1, column: 10, exported: false }
    ]);
  });

  it('captures methods inside classes', () => {
    const source = `
export class Service {
  doThing() {}
  private async doOther() {}
}
`;
    const symbols = listSymbols(source, 'ts');
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'class:Service',
      'method:doThing',
      'method:doOther'
    ]);
  });
});

describe('listSymbols (Python)', () => {
  it('finds top-level functions, classes, and methods', () => {
    const source = `
def top_level():
    pass

class Greeter:
    def hello(self):
        pass

    async def hello_async(self):
        pass
`;
    const symbols = listSymbols(source, 'py');
    expect(symbols.map((s) => `${s.kind}:${s.name}`)).toEqual([
      'function:top_level',
      'class:Greeter',
      'method:hello',
      'method:hello_async'
    ]);
  });
});

describe('listSymbols (Go)', () => {
  it('finds funcs and types and marks exported by capitalization', () => {
    const source = `
package main

func ExportedFn() {}
func unexportedFn() {}
type Person struct {}
type kind interface{}
`;
    const symbols = listSymbols(source, 'go');
    expect(symbols.find((s) => s.name === 'ExportedFn')?.exported).toBe(true);
    expect(symbols.find((s) => s.name === 'unexportedFn')?.exported).toBe(false);
    expect(symbols.find((s) => s.name === 'Person')?.kind).toBe('struct');
    expect(symbols.find((s) => s.name === 'kind')?.kind).toBe('interface');
  });
});

describe('listSymbols (Rust)', () => {
  it('finds pub/non-pub fn, struct, enum, trait', () => {
    const source = `
pub fn public_fn() {}
fn private_fn() {}
pub struct Thing {}
enum State { On, Off }
pub trait Talkable {}
`;
    const symbols = listSymbols(source, 'rs');
    expect(symbols.find((s) => s.name === 'public_fn')?.exported).toBe(true);
    expect(symbols.find((s) => s.name === 'private_fn')?.exported).toBe(false);
    expect(symbols.find((s) => s.name === 'Thing')?.kind).toBe('struct');
    expect(symbols.find((s) => s.name === 'State')?.kind).toBe('enum');
    expect(symbols.find((s) => s.name === 'Talkable')?.kind).toBe('interface');
  });
});

describe('findDefinitions', () => {
  it('returns matching symbols by exact name', () => {
    const source = 'export function alpha() {}\nfunction beta() {}\n';
    expect(findDefinitions('beta', source, 'ts')).toEqual([
      { name: 'beta', kind: 'function', line: 2, column: 10, exported: false }
    ]);
    expect(findDefinitions('missing', source, 'ts')).toEqual([]);
  });
});
