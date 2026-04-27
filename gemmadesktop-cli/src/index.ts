#!/usr/bin/env node
import { runCli } from "./cli.js";

const abortController = new AbortController();

process.once("SIGINT", () => {
  abortController.abort();
});

const exitCode = await runCli({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: process.env,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  signal: abortController.signal,
});

process.exitCode = exitCode;
