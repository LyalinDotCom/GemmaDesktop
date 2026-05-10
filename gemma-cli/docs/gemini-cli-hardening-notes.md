# Gemini CLI Hardening Pass Notes

## Objective

Compare the local Gemini CLI fork worktrees against Gemma CLI and import low-risk hardening that helps Gemma CLI behave better on Terminal-Bench v2 with local Ollama models.

## Reference Branches Inspected

- `feat/benchmark-improvements`
- `feat/add-gemma-4-31b-it-support`
- `redirect-to-gemma4`
- `akkr_evals_router_off_temp_0`
- `sameez/gemma-hybrid-mode`

## Findings

- The reported 18k-turn run is consistent with 89 Terminal-Bench v2 tasks at a 200-turn non-interactive cap. That is not benchmark cheating by itself, but it is not comparable to Gemma CLI runs capped at 32 turns.
- The most directly useful Gemini CLI changes are benchmark posture changes: 200 non-interactive turns, clearer retry discipline, practical missing-command package mappings, and background-service verification patterns.
- Gemini CLI has deeper memory-management and loop-detection systems than Gemma CLI. Gemma CLI now has a deterministic provider-facing compaction layer as a first step, but loop-pattern detection remains future work.
- Gemini-specific routing and cloud hybrid-mode changes are not a fit for local-only Terminal-Bench runs. They are useful design references, not direct imports.
- The strongest tool-suite lesson is not backward compatibility. Gemma CLI can break its current tool contract if a cleaner model-facing API is better. Gemini CLI's hardened surface is smaller and more conventional: `run_shell_command`, `read_file`, `read_many_files`, `grep_search`, `glob`, `list_directory`, `write_file`, and `replace`.
- Do not import Gemini CLI's `replace` tool as-is. Gemma CLI already learned that exact `old_string`/`new_string` edits are brittle for Gemma models; keep `apply_patch` or a more constrained patch-first editing tool instead.
- Gemini CLI's bulky tool-output handling is worth importing. It protects recent tool outputs, masks older large outputs, and keeps enough preview text for recovery. Gemma CLI should do the same without dropping full diagnostics.

## Imported In This Pass

- Terminal-Bench Harbor defaults now use a 200-turn cap and a longer 300s shell idle timeout.
- The Terminal-Bench run script defaults now match the 200-turn comparison posture and uses a higher Harbor timeout multiplier for slow local models.
- Core agent prompts now include non-interactive service startup verification, process-check fallbacks, missing Linux package mappings, and repeated-failure strategy guidance.
- Core agent calls now compact older conversation history before provider calls when the configured context budget is exceeded, while preserving the system prompt, original request, and recent turns.
- Core agent calls now mask older bulky tool results before provider calls while preserving recent tool output and full local diagnostics.
- `read_files` now accepts Gemini-style `include` path/glob patterns and `exclude` patterns, so broad multi-file reads do not require the model to construct a nested `requests` array.
- Workspace globs now treat patterns like `src/**/*.ts` as matching both direct children and nested files, which is what models generally expect from Gemini-style glob syntax.

## Tool-Suite Recommendation

If we are willing to break the current Gemma CLI tool contract, the next major version should consider this model-facing suite:

- `run_shell_command`: replace `exec_command`; include `command`, `dir_path`, `description`, `timeout_ms`, and ideally `is_background`.
- `read_file`: keep the name but switch model-facing parameters to `file_path`, `start_line`, and `end_line`.
- `read_many_files`: replace `read_files`; accept `include` and `exclude` globs with a strict total byte budget.
- `grep_search`: replace `search_text`; default to regex search, with `fixed_strings`, `names_only`, `total_max_matches`, and `max_matches_per_file`.
- `glob`: replace `search_paths`; make it pattern-first instead of fuzzy-query-first.
- `list_directory`: replace `list_tree`; keep depth/tree behavior only if the name and description make that clear.
- `write_file`: keep, with complete-content semantics and suspicious-content feedback.
- `apply_patch`: keep as Gemma CLI's editing primitive instead of Gemini CLI `replace`.

Tools to question in a clean break:

- `materialize_content`, `read_content`, and `search_content`: possibly redundant once tool-output masking and paginated reads are solid.
- `finalize_build`: useful as a guardrail, but it is a nonstandard model-facing tool and may distract benchmark agents.
- `run_tests`: useful convenience, but shell plus better prompt guidance may be simpler and closer to Gemini CLI.
- `list_symbols` and `find_definition`: potentially valuable for coding work, but they are not part of Gemini CLI's smaller benchmark-proven core.

## Next Areas To Inspect

- Decide whether to rename the model-facing tool suite to the recommended clean-break contract instead of adding aliases.
- Add run metadata for compaction counts and estimated provider-message size so long local runs are easier to debug.
- Review whether Terminal-Bench runs should use `--max-tokens 8192` after measuring whether 4096 is cutting off valid tool calls or final answers.
- Compare `run_shell_command` background semantics against Gemma CLI `exec_command`; the biggest missing capability is an explicit `is_background` parameter.
- Re-run a small v2 task sample with the 200-turn budget before spending time on a full 89-task run.
