export interface Scenario {
  id: string;
  description: string;
  prompt: string;
}

export const scenarios: Scenario[] = [
  {
    id: 'script-generation',
    description: 'Generate a small shell script without executing it.',
    prompt: 'Use write_file to create scripts/hello.sh with a shell script that prints "hello from gemma cli". Then answer with one sentence.'
  },
  {
    id: 'file-analysis',
    description: 'Read a small project file and summarize its purpose.',
    prompt: 'Use read_file to inspect package.json. Then answer with a short summary of the scripts and workspace layout.'
  },
  {
    id: 'code-generation',
    description: 'Create a small JavaScript utility module.',
    prompt: 'Use write_file to create tmp/sum.js exporting a sum(numbers) function. Then answer with one sentence.'
  },
  {
    id: 'workspace-search',
    description: 'Use a read-only command to locate TypeScript source files.',
    prompt: 'Use search_paths with glob "packages/core/src/**/*.ts" to list TypeScript files. Then answer with a short responsibility summary.'
  }
];

export function findScenario(id: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}
