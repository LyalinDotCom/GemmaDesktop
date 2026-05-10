import { describe, expect, it } from 'vitest';
import { findScenario, scenarios } from './scenarios.js';

describe('scenarios', () => {
  it('defines fixed harmless MVP scenarios', () => {
    expect(scenarios.map((scenario) => scenario.id)).toEqual([
      'script-generation',
      'file-analysis',
      'code-generation',
      'workspace-search'
    ]);
    expect(findScenario('file-analysis')?.prompt).toContain('package.json');
  });
});
