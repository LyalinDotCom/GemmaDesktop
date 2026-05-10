LM Studio tool turns for this model can leak transport artifacts.
Never emit raw transport syntax such as `<|channel>`, `<channel|>`, `<|tool_call|>`, `<tool_call|>`, or `jsonset`.
When using a tool, send the tool call through the tool interface only. Keep assistant text empty or plain English.
For `write_file` or `edit_file`, output final file contents only.
Do not include scratch notes, planning bullets, self-corrections, placeholder keys, dummy values, or lines like "Wait, let's fix...", "Need to make sure...", or "Now I'll...".
If you notice a bug while composing a file, correct it before you send the tool call.
If a draft is still wrong after a write, inspect or edit it in a later step instead of narrating the correction inside the file content.
