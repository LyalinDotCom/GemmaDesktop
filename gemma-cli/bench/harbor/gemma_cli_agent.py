"""Harbor installed-agent adapter for Gemma CLI."""

from __future__ import annotations

import base64
import json
import shlex
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


TERMINAL_BENCH_GUIDANCE = """You are running inside Terminal-Bench.
Scoring is based on workspace artifacts and verifier tests, not explanations.
Work in the task workspace and prefer a short inspect -> edit/write -> validate loop.
Do not paste implementation code as the final answer. Write the artifact or run the command first, then answer briefly.
After every tool result, do not restate the task or redo the full analysis. Use the new facts and issue the next concrete tool call.
For background services, prefer `nohup <command> > /tmp/<service>.log 2>&1 &`, record the PID, sleep briefly, verify with `kill -0 <PID>` or `/proc/<PID>`, and inspect the log.
If pgrep, ps, or pidof are missing, use `/proc/<PID>`, `kill -0 <PID>`, or `/proc/<PID>/cmdline` before installing process tools.
If a command is missing in a Linux container, install the narrow package likely to provide it: pgrep/ps/pidof -> procps; ss/ip -> iproute2; netstat/ifconfig -> net-tools; curl -> curl; jq -> jq; dig/nslookup -> dnsutils or bind-utils; lsof -> lsof; wget -> wget; tree -> tree; zip/unzip -> zip/unzip.
When a command or validation approach fails, inspect the error and change strategy. Do not repeat the exact same failing approach more than twice.
If the task is hard or underspecified, create the best verifiable attempt instead of stopping at a refusal, unless the requested action is unsafe or impossible in the workspace.
Keep private reasoning brief and spend tokens on tool calls, file contents, and validation.

Original task:
"""


class GemmaCliAgent(BaseInstalledAgent):
    """Run Gemma CLI inside a Harbor task container against host Ollama."""

    def __init__(
        self,
        logs_dir: Path,
        model_name: str | None = None,
        core_tarball: str | None = None,
        cli_tarball: str | None = None,
        node_tarball: str | None = None,
        gemma_package: str | None = None,
        ollama_url: str = "http://host.docker.internal:11434",
        context_tokens: int | None = None,
        max_turns: int = 200,
        max_tokens: int | None = None,
        think: str = "on",
        temperature: float | None = None,
        top_p: float | None = None,
        top_k: int | None = None,
        shell_idle_timeout_ms: int | None = 300_000,
        yolo: bool = True,
        **kwargs: Any,
    ) -> None:
        super().__init__(logs_dir=logs_dir, model_name=model_name, **kwargs)
        self.core_tarball = self._optional_path(core_tarball)
        self.cli_tarball = self._optional_path(cli_tarball)
        self.node_tarball = self._optional_path(node_tarball)
        self.gemma_package = gemma_package
        self.ollama_url = ollama_url
        self.context_tokens = int(context_tokens) if context_tokens is not None else None
        self.max_turns = int(max_turns)
        self.max_tokens = int(max_tokens) if max_tokens is not None else None
        self.think = think
        self.temperature = temperature
        self.top_p = top_p
        self.top_k = int(top_k) if top_k is not None else None
        self.shell_idle_timeout_ms = int(shell_idle_timeout_ms) if shell_idle_timeout_ms is not None else None
        self.yolo = bool(yolo)
        self.install_source = "local-tarballs" if self.core_tarball or self.cli_tarball else "npm"

    @staticmethod
    def name() -> str:
        return "gemma-cli"

    def get_version_command(self) -> str | None:
        return "gemma --help | head -n 1"

    @staticmethod
    def _optional_path(value: str | None) -> Path | None:
        if value is None:
            return None
        path = Path(value).expanduser().resolve()
        if not path.is_file():
            raise FileNotFoundError(f"Tarball does not exist: {path}")
        return path

    @staticmethod
    def _shell_join(parts: list[str]) -> str:
        return " ".join(shlex.quote(part) for part in parts)

    @staticmethod
    def _benchmark_instruction(instruction: str) -> str:
        return f"{TERMINAL_BENCH_GUIDANCE}{instruction}"

    async def install(self, environment: BaseEnvironment) -> None:
        remote_packages: list[str] = []

        if self.core_tarball:
            remote_core = "/installed-agent/gemma-cli-core.tgz"
            await environment.upload_file(self.core_tarball, remote_core)
            remote_packages.append(remote_core)

        if self.cli_tarball:
            remote_cli = "/installed-agent/gemma-cli.tgz"
            await environment.upload_file(self.cli_tarball, remote_cli)
            remote_packages.append(remote_cli)

        if not remote_packages:
            if self.gemma_package:
                package_spec = self.gemma_package
            else:
                version_spec = f"@{self._version}" if self._version else "@latest"
                package_spec = f"gemma-cli{version_spec}"
            remote_packages.append(package_spec)

        package_args = self._shell_join(remote_packages)

        if self.node_tarball:
            remote_node = "/installed-agent/node-runtime.tgz"
            await environment.upload_file(self.node_tarball, remote_node)
            await self.exec_as_root(
                environment,
                command=(
                    "set -euo pipefail\n"
                    "tar -xzf /installed-agent/node-runtime.tgz -C /usr/local\n"
                    "node --version\n"
                    "npm --version\n"
                ),
            )
        else:
            await self.exec_as_root(
                environment,
                command=(
                    "if command -v bash >/dev/null 2>&1 && command -v curl >/dev/null 2>&1; then "
                    ":; "
                    "elif ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then "
                    "apk add --no-cache bash ca-certificates curl nodejs npm; "
                    "elif command -v apt-get >/dev/null 2>&1; then "
                    "apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=60 -o Acquire::https::Timeout=60 update && "
                    "apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=60 -o Acquire::https::Timeout=60 install -y --no-install-recommends bash ca-certificates curl; "
                    "elif command -v yum >/dev/null 2>&1; then "
                    "yum install -y bash ca-certificates curl; "
                    "else "
                    "echo 'Warning: no known package manager found; assuming curl, bash, node, and npm are available' >&2; "
                    "fi"
                ),
                env={"DEBIAN_FRONTEND": "noninteractive"},
            )

        await self.exec_as_root(
            environment,
            command=(
                "set -euo pipefail\n"
                "if command -v node >/dev/null 2>&1 && node -e \"const major = Number(process.versions.node.split('.')[0]); process.exit(major >= 20 ? 0 : 1)\"; then\n"
                "  :\n"
                "elif ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then\n"
                "  node -e \"const major = Number(process.versions.node.split('.')[0]); if (major < 20) process.exit(1)\"\n"
                "else\n"
                "  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash\n"
                "  export NVM_DIR=\"$HOME/.nvm\"\n"
                "  . \"$NVM_DIR/nvm.sh\"\n"
                "  nvm install 22\n"
                "  NODE_PREFIX=\"$(dirname \"$(dirname \"$(command -v node)\")\")\"\n"
                "  rm -rf /opt/gemma-node\n"
                "  cp -a \"$NODE_PREFIX\" /opt/gemma-node\n"
                "  ln -sf /opt/gemma-node/bin/node /usr/local/bin/node\n"
                "  ln -sf /opt/gemma-node/bin/npm /usr/local/bin/npm\n"
                "  ln -sf /opt/gemma-node/bin/npx /usr/local/bin/npx\n"
                "fi\n"
                f"npm install -g --prefix /usr/local {package_args}\n"
                "gemma --help >/dev/null\n"
            ),
        )

    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if not self.model_name:
            raise ValueError("Model name is required")

        workdir = environment.task_env_config.workdir or "/app"
        benchmark_instruction = self._benchmark_instruction(instruction)
        instruction_b64 = base64.b64encode(benchmark_instruction.encode("utf-8")).decode("ascii")
        instruction_path = "/tmp/gemma-cli-instruction.txt"
        agent_dir = EnvironmentPaths.agent_dir.as_posix()
        stdout_path = f"{agent_dir}/gemma-cli.jsonl"
        stderr_path = f"{agent_dir}/gemma-cli.stderr.log"
        exit_path = f"{agent_dir}/gemma-cli.exitcode"
        metadata_path = f"{agent_dir}/gemma-cli-run.json"
        diagnostics_dir = "/tmp/gemma-cli-diagnostics"

        cli_parts = [
            "gemma",
            "--provider",
            "ollama",
            "--model",
            self.model_name,
            "--ollama-url",
            self.ollama_url,
            "--think",
            self.think,
            "--json-stream",
            "--max-turns",
            str(self.max_turns),
            "--no-ollama-autostart",
            "--cwd",
            workdir,
        ]
        if self.context_tokens is not None:
            cli_parts.extend(["--context-tokens", str(self.context_tokens)])
        if self.max_tokens is not None:
            cli_parts.extend(["--max-tokens", str(self.max_tokens)])
        if self.temperature is not None:
            cli_parts.extend(["--temperature", str(self.temperature)])
        if self.top_p is not None:
            cli_parts.extend(["--top-p", str(self.top_p)])
        if self.top_k is not None:
            cli_parts.extend(["--top-k", str(self.top_k)])
        if self.shell_idle_timeout_ms is not None:
            cli_parts.extend(["--shell-idle-timeout-ms", str(self.shell_idle_timeout_ms)])
        if self.yolo:
            cli_parts.append("--yolo")

        cli_command = self._shell_join(cli_parts)
        run_metadata = {
            "agent": self.name(),
            "provider": "ollama",
            "model": self.model_name,
            "ollamaUrl": self.ollama_url,
            "maxTurns": self.max_turns,
            "think": self.think,
            "workdir": workdir,
            "installSource": self.install_source,
            "benchmarkGuidance": "terminal-bench-artifact-loop-v2",
            "diagnosticsDir": diagnostics_dir,
        }
        if self.shell_idle_timeout_ms is not None:
            run_metadata["shellIdleTimeoutMs"] = self.shell_idle_timeout_ms
        if self.install_source == "npm":
            run_metadata["gemmaPackage"] = self.gemma_package or (
                f"gemma-cli@{self._version}" if self._version else "gemma-cli@latest"
            )
        if self.context_tokens is not None:
            run_metadata["contextTokens"] = self.context_tokens

        await self.exec_as_agent(
            environment,
            command=(
                "set +e\n"
                f"mkdir -p {shlex.quote(agent_dir)}\n"
                f"rm -rf {shlex.quote(diagnostics_dir)} {shlex.quote(workdir + '/.gemmacli')}\n"
                f"mkdir -p {shlex.quote(diagnostics_dir)}\n"
                f"printf '%s' {shlex.quote(instruction_b64)} | base64 -d > {shlex.quote(instruction_path)}\n"
                f"printf '%s\\n' {shlex.quote(json.dumps(run_metadata, sort_keys=True))} > {shlex.quote(metadata_path)}\n"
                f"{cli_command} --prompt \"$(cat {shlex.quote(instruction_path)})\" "
                f"> {shlex.quote(stdout_path)} 2> {shlex.quote(stderr_path)}\n"
                "status=$?\n"
                f"printf '%s\\n' \"$status\" > {shlex.quote(exit_path)}\n"
                f"if [ -d {shlex.quote(diagnostics_dir)} ]; then "
                f"rm -rf {shlex.quote(agent_dir + '/gemmacli-diagnostics')}; "
                f"cp -R {shlex.quote(diagnostics_dir)} {shlex.quote(agent_dir + '/gemmacli-diagnostics')}; "
                "fi\n"
                f"tail -n 200 {shlex.quote(stdout_path)} > {shlex.quote(agent_dir + '/gemma-cli.tail.jsonl')} 2>/dev/null\n"
                f"tail -n 200 {shlex.quote(stderr_path)} > {shlex.quote(agent_dir + '/gemma-cli.stderr.tail.log')} 2>/dev/null\n"
                "exit \"$status\"\n"
            ),
            env={
                "OLLAMA_URL": self.ollama_url,
                "NO_COLOR": "1",
                "GEMMA_CLI_DIAGNOSTICS_DIR": diagnostics_dir,
            },
        )

        self.populate_context_post_run(context)

    def populate_context_post_run(self, context: AgentContext) -> None:
        metadata: dict[str, Any] = {
            "agent": self.name(),
            "provider": "ollama",
            "model": self.model_name,
            "ollamaUrl": self.ollama_url,
            "maxTurns": self.max_turns,
            "think": self.think,
            "installSource": self.install_source,
        }
        if self.shell_idle_timeout_ms is not None:
            metadata["shellIdleTimeoutMs"] = self.shell_idle_timeout_ms
        if self.install_source == "npm":
            metadata["gemmaPackage"] = self.gemma_package or (
                f"gemma-cli@{self._version}" if self._version else "gemma-cli@latest"
            )
        if self.context_tokens is not None:
            metadata["contextTokens"] = self.context_tokens

        exit_path = self.logs_dir / "gemma-cli.exitcode"
        if exit_path.is_file():
            metadata["exitCode"] = exit_path.read_text(encoding="utf-8").strip()

        stdout_path = self.logs_dir / "gemma-cli.jsonl"
        if stdout_path.is_file():
            events = self._load_jsonl(stdout_path)
            metadata["jsonStreamEvents"] = len(events)
            metadata["jsonStreamEventTypes"] = sorted(
                {str(event.get("type")) for event in events if isinstance(event, dict)}
            )
            for event in reversed(events):
                if not isinstance(event, dict):
                    continue
                if event.get("type") == "run_completed":
                    data = event.get("data")
                    result = data.get("result") if isinstance(data, dict) else event.get("result")
                    if isinstance(result, dict):
                        metadata["completionStatus"] = result.get("completionStatus") or result.get("status")
                        metadata["sessionId"] = result.get("sessionId")
                        metadata["turns"] = result.get("turns")
                        metadata["answerChars"] = len(str(result.get("answer") or ""))
                    break
                if event.get("type") == "run_failed":
                    metadata["completionStatus"] = "failed"
                    metadata["error"] = event.get("error")
                    break

        stderr_path = self.logs_dir / "gemma-cli.stderr.tail.log"
        if stderr_path.is_file():
            stderr_tail = stderr_path.read_text(encoding="utf-8", errors="replace").strip()
            if stderr_tail:
                metadata["stderrTail"] = stderr_tail[-4000:]

        context.metadata = {**(context.metadata or {}), **metadata}

    @staticmethod
    def _load_jsonl(path: Path) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                events.append(value)
        return events
