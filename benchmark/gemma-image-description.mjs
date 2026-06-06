#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  helpText,
  imageDescriptionFixtures,
  parseMediaArgs,
  runMediaBenchmark
} from './gemma-media-benchmark-core.mjs';

export const imageDescriptionBenchmark = {
  title: 'Gemma Image Description Benchmark',
  category: 'image-description',
  mediaKind: 'image',
  entrypoint: 'gemma-image-description.mjs',
  reportPrefix: 'gemma-image-description',
  fixtures: imageDescriptionFixtures,
  prompt(fixture) {
    return [
      `Describe the image at @"${fixture.localPath}" in 2-4 factual sentences.`,
      'Focus on visible subjects, setting, and notable details.',
      'Return only the description.'
    ].join(' ');
  }
};

async function main(argv) {
  const options = parseMediaArgs(argv, imageDescriptionBenchmark);
  if (options.help) {
    console.log(helpText(imageDescriptionBenchmark));
    return 0;
  }
  const { output } = await runMediaBenchmark(options, imageDescriptionBenchmark);
  console.log(`Wrote image benchmark report: ${output}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
