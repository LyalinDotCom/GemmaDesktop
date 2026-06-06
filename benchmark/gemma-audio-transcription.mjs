#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  audioTranscriptionFixtures,
  helpText,
  parseMediaArgs,
  runMediaBenchmark
} from './gemma-media-benchmark-core.mjs';

export const audioTranscriptionBenchmark = {
  title: 'Gemma Audio Transcription Benchmark',
  category: 'audio-transcription',
  mediaKind: 'audio',
  entrypoint: 'gemma-audio-transcription.mjs',
  reportPrefix: 'gemma-audio-transcription',
  fixtures: audioTranscriptionFixtures,
  prompt(fixture) {
    return [
      `Transcribe the spoken words in the audio file at @"${fixture.localPath}".`,
      'Return only the transcript.'
    ].join(' ');
  }
};

async function main(argv) {
  const options = parseMediaArgs(argv, audioTranscriptionBenchmark);
  if (options.help) {
    console.log(helpText(audioTranscriptionBenchmark));
    return 0;
  }
  const { output } = await runMediaBenchmark(options, audioTranscriptionBenchmark);
  console.log(`Wrote audio benchmark report: ${output}`);
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
