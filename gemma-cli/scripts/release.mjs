#!/usr/bin/env node

console.error(
  '[release] Gemma CLI publishing needs a new monorepo release workflow now that @gemma-sdk/agent lives in gemma-sdk. Refusing to run the old standalone release path.',
)
process.exit(1)
