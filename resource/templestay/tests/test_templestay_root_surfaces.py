"""Sanity checks for the templestay-root native template (3rd-gen).

These tests pin the canonical layout at the templestay repository root, separate
from the upstream tests that live inside the `resource/templerun/` submodule.
The submodule remains valid for the templerun package; this file validates
that templestay itself is a self-contained installable template.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CLAUDE = ROOT / "claude" / "templestay"
CODEX = ROOT / "codex" / "templestay"
PHASE = "Input → Atomize → Plan → Execute → Verify → Critique → Report"
VERIFY_REPAIR = "Verify → Execute"
REPAIR = "Critique → Atomize → Plan"


def test_root_layout_is_self_contained():
    # Top-level metadata.
    assert (ROOT / "README.md").exists()
    assert (ROOT / "plugin.json").exists()
    assert (ROOT / ".codex-plugin" / "plugin.json").exists()
    assert (ROOT / "shared" / "templestay" / "README.md").exists()
    assert (ROOT / "shared" / "templestay" / "instructions" / "common-kernel.md").exists()
    assert (ROOT / "scripts" / "materialize_shared_resources.py").exists()
    # Claude marketplace + plugin.
    assert (ROOT / "claude" / ".claude-plugin" / "marketplace.json").exists()
    assert (CLAUDE / ".claude-plugin" / "plugin.json").exists()
    assert (CLAUDE / "CLAUDE.md").exists()
    assert (CLAUDE / ".mcp.json").exists()
    # Codex package.
    assert (CODEX / ".codex-plugin" / "plugin.json").exists()
    assert (CODEX / "AGENTS.md").exists()
    # Bundled MCP server backends.
    for srv in ("memory-v2", "context-manager", "document-parser",
                "codex-gateway", "claude-gateway", "gemini-gateway"):
        assert (ROOT / "mcp-servers" / srv / "server.py").exists()
        assert (ROOT / "mcp-servers" / srv / "requirements.txt").exists()
    # Top-level install entrypoints.
    assert (ROOT / "install.sh").exists()
    assert (ROOT / "scripts" / "install_templestay_claude_cli.sh").exists()
    assert (ROOT / "scripts" / "install_templestay_codex_cli.sh").exists()
    assert (ROOT / "scripts" / "install_templestay_memory.sh").exists()
    assert (ROOT / "scripts" / "remove_legacy_settings.sh").exists()
    assert (ROOT / "scripts" / "remove_templerun_legacy.sh").exists()
    assert (ROOT / "docs" / "mcp.md").exists()
    assert (ROOT / "specs" / "templestay-memory-v2-platform-v3-prep.md").exists()
    assert (ROOT / "specs" / "_index.md").exists()
    for template in ("lightweight", "full", "plan", "report"):
        assert (ROOT / "specs" / "_templates" / f"{template}.md").exists()


def test_root_manifests_parse_and_share_name():
    root_manifest = json.loads((ROOT / "plugin.json").read_text())
    root_codex_manifest = json.loads((ROOT / ".codex-plugin" / "plugin.json").read_text())
    claude_manifest = json.loads((CLAUDE / ".claude-plugin" / "plugin.json").read_text())
    codex_manifest = json.loads((CODEX / ".codex-plugin" / "plugin.json").read_text())
    marketplace = json.loads((ROOT / "claude" / ".claude-plugin" / "marketplace.json").read_text())

    assert root_manifest["name"] == "templestay"
    assert root_codex_manifest["name"] == "templestay"
    assert claude_manifest["name"] == "templestay"
    assert codex_manifest["name"] == "templestay"
    assert marketplace["name"] == "templestay"
    assert root_manifest["version"] == root_codex_manifest["version"]
    assert root_manifest["version"] == claude_manifest["version"]
    assert root_manifest["version"] == codex_manifest["version"]
    assert root_manifest["sharedResources"]["source"] == "shared/templestay"
    assert root_manifest["sharedResources"]["materializer"] == "scripts/materialize_shared_resources.py"
    assert root_codex_manifest["skills"] == "./codex/templestay/skills/"
    assert root_codex_manifest["repository"] == root_manifest["homepage"]
    assert root_codex_manifest["interface"]["category"] == "Coding"
    assert claude_manifest["repository"] == root_manifest["homepage"]
    assert codex_manifest["repository"] == root_manifest["homepage"]


def test_shared_resources_are_source_of_truth_for_generated_surfaces():
    """Claude/Codex common instructions and skills must be generated from shared/.

    This guards against drifting back to independent hand-maintained copies.
    """
    result = subprocess.run(
        ["python3", str(ROOT / "scripts" / "materialize_shared_resources.py"), "--check"],
        check=True, capture_output=True, text=True, cwd=ROOT,
    )
    assert "shared resource materialization check passed" in result.stdout

    for path in (CLAUDE / "CLAUDE.md", CODEX / "AGENTS.md"):
        text = path.read_text(encoding="utf-8")
        assert "templestay-generated-from: shared/templestay/instructions/" in text, path
        assert "templestay-shared-source: shared/templestay/instructions/common-kernel.md" in text, path

    shared_skill_names = (
        "templestay-memory",
        "templestay-verification",
        "templestay-research",
        "templestay-deep-think",
        "templestay-memory-consolidation",
    )
    for skill_name in shared_skill_names:
        template = ROOT / "shared" / "templestay" / "skills" / skill_name / "SKILL.md.in"
        assert template.exists(), template
        for surface in (CLAUDE, CODEX):
            rendered = surface / "skills" / skill_name / "SKILL.md"
            text = rendered.read_text(encoding="utf-8")
            if surface == CODEX and skill_name == "templestay-verification":
                expected = "shared/templestay/skills/templestay-verification/CODEX.SKILL.md.in"
                assert (ROOT / expected).exists()
            else:
                expected = f"shared/templestay/skills/{skill_name}/SKILL.md.in"
            assert f"templestay-generated-from: {expected}" in text, rendered


def test_phase_graph_present_at_root_surfaces():
    for path in (CLAUDE / "CLAUDE.md", CODEX / "AGENTS.md"):
        text = path.read_text(encoding="utf-8")
        collapsed = " ".join(text.split())
        assert PHASE in text, path
        assert VERIFY_REPAIR in text, path
        assert REPAIR in text, path
        assert "bounded state machine" in text, path
        assert "failed_check" in text, path
        assert "execute_repair_target" in text, path
        assert "parent state machine owns" in text, path
        assert "in_scope_repair_target" in text, path
        assert "updated_assumption" in text, path
        assert "loop-budget-exhausted" in text, path
        assert "max_loop_budget=pending" in text, path
        assert "max_loop_budget = choose(1, 3, 5, 10)" in text, path
        assert "initial Atomize" in text, path
        assert "recursive Atomize" in text, path
        assert "problem interpretation" in collapsed, path
        assert "Verify → Critique" in text, path
        assert "Verify → Execute" in text, path
        assert "re-run Verify after the focused Execute fix" in text, path
        assert "Critique → Report(PASS)" in text, path
        assert "Critique → Atomize" in text, path
        assert "Critique remains a read-only hetero-model evidence lane" in text, path
        assert "same GPT-family" in text, path
        assert "hetero-model" in text, path
        assert "GPT-5.5 interaction posture" in text, path
        assert "outcome-first instructions" in text, path
        assert "low or medium reasoning effort" in text, path
        assert "DT Audit and high-utility orchestration are explicit xhigh lanes" in text, path
        assert "Excute" not in text, path


def test_state_machine_docs_define_bounded_repair_loop():
    common = (ROOT / "shared" / "templestay" / "instructions" / "common-kernel.md").read_text(encoding="utf-8")
    kernel = (ROOT / "docs" / "templestay-native-kernel.md").read_text(encoding="utf-8")

    for text in (common, kernel):
        collapsed = " ".join(text.split())
        assert PHASE in text
        assert VERIFY_REPAIR in text
        assert REPAIR in text
        assert "Input(capture anchor; loop_index=0; max_loop_budget=pending)" in text
        assert "max_loop_budget = choose(1, 3, 5, 10)" in text
        assert "initial Atomize" in text
        assert "recursive Atomize" in text
        assert "problem interpretation" in collapsed
        assert "loop_index < max_loop_budget" in text
        assert "Loop budget counts the initial pass plus any Verify or Critique repair passes" in text
        assert "failed_check" in text
        assert "execute_repair_target" in text
        assert "parent state machine owns" in text
        assert "lacks an actionable repair target" in text
        assert "Verify → Report(FAIL loop-budget-exhausted)" in text
        assert "in_scope_repair_target" in text or "repair_target" in text
        assert "updated_assumption" in text
        assert "loop-budget-exhausted" in text

    assert "Transition table" in kernel
    assert "Atomize → Plan" in kernel
    assert "pending `max_loop_budget`" in kernel
    assert "max_loop_budget` chosen during Atomize" in kernel
    assert "Verify → Critique" in kernel
    assert "Verify → Execute" in kernel
    assert "re-run Verify after the focused Execute fix" in kernel
    assert "Example edge contrast" in kernel
    assert "Critique → Report(WARN)" in kernel
    assert "Critique → Report(FAIL)" in kernel
    assert "Plan → Execute" in kernel
    assert "Critique → Atomize" in kernel
    assert "Critique → Execute" in kernel


def test_orchestration_skill_assigns_loop_budget_to_atomize():
    codex_orchestration = (CODEX / "skills" / "templestay-orchestration" / "SKILL.md").read_text(encoding="utf-8")
    collapsed = " ".join(codex_orchestration.split())

    assert "`loop_index=0`" in codex_orchestration
    assert "Select `max_loop_budget` during Atomize" in collapsed
    assert "initial Atomize pass" in codex_orchestration
    assert "problem interpretation" in collapsed
    assert "recursive Atomize reached from Critique" in codex_orchestration
    assert "Verify → Execute" in codex_orchestration
    assert "execute_repair_target" in codex_orchestration
    assert "repeat the relevant Verify check" in codex_orchestration
    assert "failed_check" in codex_orchestration
    assert "updated_assumption" in codex_orchestration


def test_no_excute_typo_in_state_machine_surfaces():
    for path in (
        ROOT / "README.md",
        ROOT / "docs" / "templestay-native-kernel.md",
        ROOT / "shared" / "templestay" / "instructions" / "common-kernel.md",
        CLAUDE / "CLAUDE.md",
        CODEX / "AGENTS.md",
        CLAUDE / "README.md",
        CODEX / "README.md",
        CLAUDE / ".claude" / "rules" / "state-machine.md",
    ):
        text = path.read_text(encoding="utf-8")
        assert "Excute" not in text, path
        assert "Verify → Feedback" not in text, path


def test_mcp_paths_resolve_inside_templestay_root():
    """`.mcp.json` must reference the templestay-root mcp-servers/ directory,
    not the legacy `copilot/mcp-servers/` path under the templerun submodule."""
    mcp = json.loads((CLAUDE / ".mcp.json").read_text(encoding="utf-8"))
    for name, spec in mcp["mcpServers"].items():
        joined = " ".join(spec["args"])
        assert "copilot/mcp-servers" not in joined, name
        assert "${CLAUDE_PLUGIN_ROOT}/../../mcp-servers/" in joined, name


def test_root_scripts_do_not_call_submodule_installers():
    """Root-native install paths must not delegate to resource/templerun."""
    for path in (
        ROOT / "install.sh",
        ROOT / "scripts" / "install_templestay_codex_cli.sh",
        ROOT / "scripts" / "install_templestay_claude_cli.sh",
        ROOT / "scripts" / "install_templestay_memory.sh",
    ):
        text = path.read_text(encoding="utf-8")
        assert "resource/templerun/scripts" not in text, path
        assert "copilot/mcp-servers" not in text, path


def test_docs_point_to_root_native_policy():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    mcp = (ROOT / "docs" / "mcp.md").read_text(encoding="utf-8")
    mcp_collapsed = " ".join(mcp.split())
    shared = (ROOT / "docs" / "shared-techniques.md").read_text(encoding="utf-8")
    kernel = (ROOT / "docs" / "templestay-native-kernel.md").read_text(encoding="utf-8")
    assert "resource/templerun/scripts/install_templestay" not in readme
    assert ".codex-plugin/plugin.json" in readme
    assert "scripts/remove_legacy_settings.sh" in readme
    assert "specs/_templates/" in readme
    assert "specs/_index.md" in readme
    assert "mcp-servers/" in mcp
    assert "claude-gateway" in mcp
    assert "standard Claude Opus 4.7 Critique lane" in mcp
    assert "policy preauthorization" in mcp
    assert "content_transfer_allowed" in mcp
    assert "per-call explicit" in mcp
    assert "destination trust is not established" in mcp
    assert "no-repository synthetic connectivity check" in mcp_collapsed
    assert "claude_route_probe" in mcp
    assert "content_transfer_policy" in mcp
    assert "copilot/mcp-servers/" in mcp
    assert "cleanup inputs" in mcp
    assert "codex/templerun-codex" not in shared
    assert "Spec tiering and traceability" in shared
    assert "Compact output headings" in shared
    assert "Spec and Output Standards" in kernel
    for token in ("[PLAN]", "[REPORT]", "[VERIFY]", "[RISK]"):
        assert token in kernel


def test_spec_templates_are_root_native_and_traceable():
    templates = {
        name: (ROOT / "specs" / "_templates" / f"{name}.md").read_text(encoding="utf-8")
        for name in ("lightweight", "full", "plan", "report")
    }
    required_metadata = ("status:", "level:", "type:", "created:", "author:", "relates_to:")
    for name, text in templates.items():
        assert text.startswith("---\n"), name
        for field in required_metadata:
            assert field in text, (name, field)
        assert "templestay" in text.lower(), name
        assert "mcp-servers/" not in text, name
        for forbidden in ("requestedSchema", "ask_user", "AWAIT", "[PLAN APPROVAL]", "[DONE]"):
            assert forbidden not in text, (name, forbidden)

    assert "Evidence Contract" in templates["plan"]
    assert "Static readiness" in templates["report"]
    assert "Live runtime readiness" in templates["report"]
    for token in ("[PLAN]", "[REPORT]", "[VERIFY]", "[RISK]", "PASS", "WARN", "FAIL"):
        assert token in templates["plan"] or token in templates["report"], token


def test_specs_index_separates_current_supporting_and_legacy_reference():
    index = (ROOT / "specs" / "_index.md").read_text(encoding="utf-8")
    for heading in (
        "## Current root-native specs",
        "## Standard templates",
        "## Supporting root references",
        "## Legacy reference map",
        "## Root-native output standard",
    ):
        assert heading in index
    assert "templestay-memory-v2-platform-v3-prep.md" in index
    assert "resource/templerun" in index
    assert "reference only" in index
    assert "runtime authority" in index
    assert "resource/templerun/scripts/install_templestay" not in index


def test_codex_presets_parse_with_templestay_kernel():
    expected_effort = {
        "minimal": "low",
        "balanced": "medium",
        "deep": "xhigh",
    }
    for name in ("balanced", "deep", "minimal"):
        with (CODEX / "config" / "presets" / f"{name}.toml").open("rb") as fh:
            data = tomllib.load(fh)
        assert data["templestay"]["deployment_id"] == "templestay"
        assert data["templestay"]["preset"] == name
        assert data["templestay"]["state_machine"] == PHASE
        assert data["templestay"]["verify_repair_edge"] == VERIFY_REPAIR
        assert data["templestay"]["repair_edge"] == REPAIR
        assert data["templestay"]["hooks_required"] is False
        assert data["codex"]["model_reasoning_effort"] == expected_effort[name]
        if name != "minimal":
            assert data["codex"]["model"] == "gpt-5.5"

    preview = subprocess.run(
        ["python3", str(ROOT / "scripts" / "preview_templestay_presets.py"),
         "codex", "--preset", "balanced"],
        check=True, capture_output=True, text=True, cwd=ROOT,
    )
    assert "critique_double_check: regular Claude Opus 4.7 via claude-gateway (effort=max)" in preview.stdout
    assert f"verify_repair_edge: {VERIFY_REPAIR}" in preview.stdout
    assert f"repair_edge: {REPAIR}" in preview.stdout


def test_claude_presets_parse_and_carry_required_keys():
    for name in ("balanced", "deep", "minimal"):
        data = json.loads((CLAUDE / "settings" / "presets" / f"{name}.json").read_text())
        assert data["model"]
        assert data["effortLevel"]
        assert data.get("autoMemoryEnabled") is False, name


def test_skills_carry_portable_techniques_at_root():
    """Same portable-technique anchors as the templerun unit tests, but pinned
    on the canonical templestay-root copies."""
    for surface in (CLAUDE, CODEX):
        orch = (surface / "skills" / "templestay-orchestration" / "SKILL.md").read_text(encoding="utf-8")
        assert "SUBAGENT_TASK" in orch, surface
        assert "SUBAGENT_RESULT" in orch, surface
        assert "scope-degraded" in orch, surface

        research = (surface / "skills" / "templestay-research" / "SKILL.md").read_text(encoding="utf-8")
        assert "tavily" in research.lower(), surface

        memory = (surface / "skills" / "templestay-memory" / "SKILL.md").read_text(encoding="utf-8")
        assert "project_key" in memory, surface
        assert "request_hash" in memory, surface
        assert "memory-record-degraded" in memory, surface
        assert "memory_session_save" in memory, surface
        assert "current task" in memory.lower(), surface
        assert "checkpoint" in memory.lower(), surface


def test_native_skills_carry_output_and_verification_standard():
    for surface in (CLAUDE, CODEX):
        orch = (surface / "skills" / "templestay-orchestration" / "SKILL.md").read_text(encoding="utf-8")
        verify = (surface / "skills" / "templestay-verification" / "SKILL.md").read_text(encoding="utf-8")

        for token in ("[PLAN]", "[REPORT]", "[VERIFY]", "[RISK]"):
            assert token in orch, (surface, token)
        for heading in ("* Summary:", "* Implementation:", "* Verification:", "* Remaining Risk:"):
            assert heading in orch, (surface, heading)
        for token in ("PASS", "WARN", "FAIL"):
            assert token in verify, (surface, token)

        assert "computational sensors" in verify.lower(), surface
        assert "Static" in verify and "Live" in verify, surface
        assert "Generator/Evaluator Separation" in verify, surface
        assert "scope-degraded" in verify, surface
        assert "All-passing verification" in verify and "digest" in verify, surface


def test_codex_verify_then_critique_uses_claude_opus_hetero_model():
    codex_verify = (CODEX / "skills" / "templestay-verification" / "SKILL.md").read_text(encoding="utf-8")
    codex_agent = (CODEX / "agents" / "verifier.md").read_text(encoding="utf-8")
    codex_agents = (CODEX / "AGENTS.md").read_text(encoding="utf-8")
    claude_verify = (CLAUDE / "skills" / "templestay-verification" / "SKILL.md").read_text(encoding="utf-8")

    for text in (codex_verify, codex_agent, codex_agents):
        collapsed = " ".join(text.split())
        assert "Claude Opus 4.7" in text
        assert "claude-opus-4-7" in text
        assert "claude-gateway" in text
        assert "Critique" in text
        assert "same GPT-family" in text
        assert "hetero" in text
        assert "parent state machine owns" in text
        assert "Verify → Execute" in text and "execute_repair_target" in text
        assert (
            "instead of implementing the fix yourself" in text
            or "remain read-only" in collapsed
            or "Critique remains a read-only hetero-model evidence lane" in text
        )
        assert "secret-screened" in text
        assert "data-transfer" in text
        assert "content_transfer_allowed=true" in text
        assert "policy-preauthorized" in text
        assert "per-call explicit external-transfer approval is not" in text
        assert "policy preauthorization" in text
        assert "destination trust" in text
        assert "synthetic connectivity check" in collapsed
        assert "content-bearing Critique" in collapsed

    # User requested this as a Codex-vs-Claude difference; Claude's own
    # verification skill remains deterministic-first without the Codex-only
    # Claude hetero Critique contract.
    assert "Claude Opus 4.7 Critique" not in claude_verify


def test_skills_have_no_copilot_only_terms():
    for skill in list((CLAUDE / "skills").glob("*/SKILL.md")) + list((CODEX / "skills").glob("*/SKILL.md")):
        text = skill.read_text(encoding="utf-8")
        assert "AWAIT" not in text, skill
        assert "ask_user" not in text, skill


def test_claude_default_operating_posture_contract():
    claude_md = (CLAUDE / "CLAUDE.md").read_text(encoding="utf-8")
    assert "## Default Operating Posture" in claude_md, CLAUDE / "CLAUDE.md"
    assert "### Subagent map" in claude_md, CLAUDE / "CLAUDE.md"
    assert "### Direct parent actions" in claude_md, CLAUDE / "CLAUDE.md"
    for agent in ("templestay-coder", "templestay-codex-coder", "templestay-explorer",
                  "templestay-reader", "templestay-researcher", "templestay-verifier",
                  "templestay-challenge", "templestay-writer"):
        assert agent in claude_md, (CLAUDE / "CLAUDE.md", agent)
    assert "must not call `Edit`" in claude_md, CLAUDE / "CLAUDE.md"

    orch_rule = (CLAUDE / ".claude" / "rules" / "orchestration.md").read_text(encoding="utf-8")
    assert orch_rule.startswith("# templestay Orchestration Rule"), CLAUDE / ".claude/rules/orchestration.md"
    assert "templestay-coder" in orch_rule, CLAUDE / ".claude/rules/orchestration.md"
    assert "templestay-codex-coder" in orch_rule, CLAUDE / ".claude/rules/orchestration.md"
    assert "See `CLAUDE.md` § Default Operating Posture" in orch_rule, CLAUDE / ".claude/rules/orchestration.md"

    orch_skill = (CLAUDE / "skills" / "templestay-orchestration" / "SKILL.md").read_text(encoding="utf-8")
    assert "Default Operating Posture" in orch_skill, CLAUDE / "skills/templestay-orchestration/SKILL.md"

    codex_skill = (CLAUDE / "skills" / "templestay-codex-delegation" / "SKILL.md").read_text(encoding="utf-8")
    assert "Default Operating Posture" in codex_skill, CLAUDE / "skills/templestay-codex-delegation/SKILL.md"

    claude_readme = (CLAUDE / "README.md").read_text(encoding="utf-8")
    assert "Default operating posture" in claude_readme, CLAUDE / "README.md"

    root_readme = (ROOT / "README.md").read_text(encoding="utf-8")
    boundaries_section = root_readme[root_readme.index("## Boundaries"):]
    assert "orchestrator-by-default" in boundaries_section, ROOT / "README.md"
    assert "Default Operating Posture" in boundaries_section, ROOT / "README.md"


def test_install_dry_runs_at_root_do_not_mutate(tmp_path):
    claude = subprocess.run(
        ["bash", str(ROOT / "scripts" / "install_templestay_claude_cli.sh"),
         "--scope", "user", "--preset", "minimal", "--dry-run"],
        check=True, capture_output=True, text=True, cwd=tmp_path,
    )
    assert "templestay Claude preset: minimal" in claude.stdout
    assert "templestay@templestay" in claude.stdout

    codex = subprocess.run(
        ["bash", str(ROOT / "scripts" / "install_templestay_codex_cli.sh"),
         "--preset", "minimal", "--dry-run"],
        check=True, capture_output=True, text=True, cwd=tmp_path,
    )
    assert "templestay Codex preset: minimal" in codex.stdout
    assert "model: <preserve-current>" in codex.stdout
    assert "reasoning_effort: low" in codex.stdout
    # Memory and gateway MCP registration must be advertised in dry-run so
    # users see what ~/.codex/config.toml will gain — this is the
    # cross-runtime contract from the plan.
    assert "[mcp_servers.templestay-memory]" in codex.stdout
    assert "claude-gateway" not in codex.stdout  # minimal preset skips gateways

    codex_no_mem = subprocess.run(
        ["bash", str(ROOT / "scripts" / "install_templestay_codex_cli.sh"),
         "--preset", "minimal", "--memory-profile", "none", "--dry-run"],
        check=True, capture_output=True, text=True, cwd=tmp_path,
    )
    assert "memory-profile=none" in codex_no_mem.stdout
    assert "skipping [mcp_servers.templestay-memory] registration" in codex_no_mem.stdout

    memory = subprocess.run(
        ["bash", str(ROOT / "scripts" / "install_templestay_memory.sh"),
         "--profile", "shared", "--dry-run"],
        check=True, capture_output=True, text=True, cwd=tmp_path,
    )
    assert "templestay memory profile: shared" in memory.stdout
    assert "schema: memory-v2.5" in memory.stdout


def test_install_sh_runs_cli_prereq_check_before_other_steps(tmp_path):
    """install.sh dry-run must walk through the CLI bootstrap step first."""
    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--dry-run"],
        check=True, capture_output=True, text=True, cwd=tmp_path,
    )
    out = result.stdout
    # Step labels reflect the shared-resource materialization stage.
    assert "[1/6] CLI prerequisites" in out
    assert "[2/6] templestay shared resources" in out
    assert "[3/6] templestay shared memory profile" in out
    assert "[4/6] templestay Codex CLI" in out
    assert "[5/6] templestay Claude Code" in out
    assert "[6/6] templestay MCP server restart" in out
    assert "shared resource materialization check passed" in out
    # When the CLIs are already on PATH the prereq step reports presence; in
    # CI/dev environments either form is acceptable.
    assert ("Claude Code CLI present:" in out) or ("would run: npm install -g @anthropic-ai/claude-code" in out)
    assert ("Codex CLI present:" in out) or ("would run: npm install -g @openai/codex" in out)


def test_install_sh_no_install_flags_skip_npm_bootstrap(tmp_path):
    """--no-install-claude and --no-install-codex disable npm bootstrap.

    We invoke install.sh under an empty PATH containing only the bash
    interpreter and basic coreutils so that `command -v claude` / `command -v
    codex` return false. With --no-install-* set, the prereq step must warn
    and continue rather than try to bootstrap or exit.
    """
    minimal_path_dir = tmp_path / "minpath"
    minimal_path_dir.mkdir()
    # Symlink only the interpreters install.sh and its callees rely on so
    # that codex/claude/npm cannot resolve.
    for tool in ("bash", "ls", "cat", "head", "rm", "mkdir", "cp", "tr",
                 "grep", "sed", "awk", "find", "python3", "uv", "git",
                 "id", "uname", "tee", "tail", "cut", "sort", "wc", "date",
                 "dirname", "basename", "pwd", "printf", "echo", "env",
                 "test", "[", "true", "false", "sleep", "kill", "pgrep",
                 "tomllib"):
        src = shutil.which(tool)
        if src:
            (minimal_path_dir / tool).symlink_to(src)

    env = {
        "PATH": str(minimal_path_dir),
        "HOME": str(tmp_path / "fake-home"),
    }
    (tmp_path / "fake-home").mkdir()
    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"),
         "--dry-run", "--no-install-claude", "--no-install-codex"],
        capture_output=True, text=True, cwd=tmp_path, env=env,
    )
    # Even without claude/codex/npm on PATH, dry-run + --no-install-* should
    # not exit non-zero on the prereq step itself; the warnings appear and
    # the script proceeds.
    out = result.stdout + result.stderr
    if result.returncode != 0:
        # Surface the relevant lines if this fails so the failure is debuggable.
        raise AssertionError(
            f"install.sh exited {result.returncode}; "
            f"stdout/stderr tail:\n{out[-2000:]}"
        )
    assert "auto-install was disabled" in out, out[-1000:]
    assert "Install manually: npm install -g @anthropic-ai/claude-code" in out
    assert "Install manually: npm install -g @openai/codex" in out


def test_install_sh_help_lists_install_flags(tmp_path):
    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"), "--help"],
        check=True, capture_output=True, text=True, cwd=tmp_path,
    )
    assert "--memory-root PATH" in result.stdout
    assert "--no-install-claude" in result.stdout
    assert "--no-install-codex" in result.stdout
    assert "@anthropic-ai/claude-code" in result.stdout
    assert "@openai/codex" in result.stdout
    assert "claude-opus-4-7" in result.stdout
    assert "effort=max" in result.stdout
    assert "CLAUDE_DEFAULT_EFFORT" in result.stdout
    assert "CLAUDE_GATEWAY_DESTINATION_TRUST" in result.stdout
    assert "CLAUDE_GATEWAY_ALLOW_REPO_CONTENT" in result.stdout


def test_install_sh_forwards_memory_root_to_codex_installer(tmp_path):
    """Root install.sh --memory-root must reach the Codex MCP config path.

    The shared memory installer already accepted --memory-root; this guards the
    root-to-Codex propagation so Claude and Codex are pointed at the same
    memory-v2.5 store when a custom path is provided.
    """
    custom_memory_root = tmp_path / "custom-shared-memory"
    result = subprocess.run(
        ["bash", str(ROOT / "install.sh"),
         "--dry-run", "--memory-root", str(custom_memory_root),
         "--no-install-claude", "--no-install-codex"],
        check=True, capture_output=True, text=True, cwd=tmp_path,
    )
    out = result.stdout + result.stderr
    assert f"memory_root: {custom_memory_root}" in out
    assert f"root: {custom_memory_root}" in out
    assert "CLAUDE_DEFAULT_EFFORT=max" in out
    assert "CLAUDE_GATEWAY_DESTINATION_TRUST=trusted_internal" in out
    assert "CLAUDE_GATEWAY_ALLOW_REPO_CONTENT=true" in out


def test_shell_scripts_report_missing_required_flag_values(tmp_path):
    cases = (
        (ROOT / "install.sh", "--memory-root"),
        (ROOT / "scripts" / "install_templestay_codex_cli.sh", "--memory-root"),
        (ROOT / "scripts" / "install_templestay_claude_cli.sh", "--memory-root"),
        (ROOT / "scripts" / "install_templestay_memory.sh", "--memory-root"),
        (ROOT / "scripts" / "restart_templestay_mcp_servers.sh", "--grace"),
    )
    for script, flag in cases:
        result = subprocess.run(
            ["bash", str(script), flag],
            capture_output=True, text=True, cwd=tmp_path,
        )
        assert result.returncode != 0
        assert f"Missing value for {flag}" in (result.stdout + result.stderr)


def test_codex_install_registers_memory_mcp_into_config_toml(tmp_path):
    fake_codex_home = tmp_path / "fake-codex"
    fake_codex_home.mkdir()
    config = fake_codex_home / "config.toml"
    # Pre-existing user-owned MCP entry must be preserved verbatim.
    config.write_text(
        '[mcp_servers.user-owned]\n'
        'command = "node"\n'
        'args = ["server.js"]\n',
        encoding="utf-8",
    )
    fake_memory_root = tmp_path / "shared-memory"

    env = os.environ.copy()
    env["CODEX_HOME"] = str(fake_codex_home)

    subprocess.run(
        ["bash", str(ROOT / "scripts" / "install_templestay_codex_cli.sh"),
         "--preset", "minimal", "--memory-profile", "shared",
         "--memory-root", str(fake_memory_root)],
        check=True, capture_output=True, text=True, cwd=tmp_path, env=env,
    )

    text = config.read_text(encoding="utf-8")
    # User-owned entry survives the install pass.
    assert "[mcp_servers.user-owned]" in text
    assert 'command = "node"' in text
    # templestay-managed entry was added with the resolved memory root.
    assert "[mcp_servers.templestay-memory]" in text
    assert "[mcp_servers.templestay-context-manager]" not in text
    assert "[mcp_servers.templestay-claude-gateway]" not in text
    assert f'TEMPLATESTAY_MEMORY_ROOT = "{fake_memory_root}"' in text
    assert 'MEMORY_V2_SCHEMA_VERSION = "2.5"' in text
    assert 'MEMORY_V2_SERVICE_NAME = "templestay"' in text
    # Backup created on first managed write.
    assert list(fake_codex_home.glob("config.toml.bak.templestay-mcp.*"))


def test_codex_install_is_idempotent_for_memory_mcp_block(tmp_path):
    fake_codex_home = tmp_path / "codex-home"
    fake_codex_home.mkdir()
    fake_memory_root = tmp_path / "memory"

    env = os.environ.copy()
    env["CODEX_HOME"] = str(fake_codex_home)
    env["TEMPLATESTAY_MEMORY_ROOT"] = str(fake_memory_root)

    for run_idx in range(2):
        subprocess.run(
            ["bash", str(ROOT / "scripts" / "install_templestay_codex_cli.sh"),
             "--preset", "minimal", "--memory-profile", "shared"],
            check=True, capture_output=True, text=True, cwd=tmp_path, env=env,
        )

    text = (fake_codex_home / "config.toml").read_text(encoding="utf-8")
    # Block is present exactly once; no duplicate sections.
    assert text.count("[mcp_servers.templestay-memory]") == 1


def test_codex_install_balanced_registers_essential_mcp_profile(tmp_path):
    fake_codex_home = tmp_path / "codex-balanced"
    fake_codex_home.mkdir()
    fake_memory_root = tmp_path / "memory"

    env = os.environ.copy()
    env["CODEX_HOME"] = str(fake_codex_home)
    env["TEMPLATESTAY_MEMORY_ROOT"] = str(fake_memory_root)

    subprocess.run(
        ["bash", str(ROOT / "scripts" / "install_templestay_codex_cli.sh"),
         "--preset", "balanced", "--memory-profile", "shared"],
        check=True, capture_output=True, text=True, cwd=tmp_path, env=env,
    )

    text = (fake_codex_home / "config.toml").read_text(encoding="utf-8")
    for name in (
        "templestay-memory",
        "templestay-context-manager",
        "templestay-document-parser",
        "templestay-claude-gateway",
    ):
        assert f"[mcp_servers.{name}]" in text
    assert "[mcp_servers.templestay-gemini-gateway]" not in text
    assert "mcp-servers/claude-gateway/server.py" in text
    assert "[mcp_servers.templestay-claude-gateway.env]" in text
    assert 'CLAUDE_DEFAULT_MODEL = "claude-opus-4-7"' in text
    assert 'CLAUDE_DEFAULT_EFFORT = "max"' in text
    assert 'CLAUDE_GATEWAY_DESTINATION_TRUST = "trusted_internal"' in text
    assert 'CLAUDE_GATEWAY_ALLOW_REPO_CONTENT = "true"' in text
    parsed = tomllib.loads(text)
    claude_env = parsed["mcp_servers"]["templestay-claude-gateway"]["env"]
    assert claude_env["CLAUDE_GATEWAY_DESTINATION_TRUST"] == "trusted_internal"
    assert claude_env["CLAUDE_GATEWAY_ALLOW_REPO_CONTENT"] == "true"


def test_codex_install_deep_registers_full_mcp_profile(tmp_path):
    fake_codex_home = tmp_path / "codex-deep"
    fake_codex_home.mkdir()

    env = os.environ.copy()
    env["CODEX_HOME"] = str(fake_codex_home)

    subprocess.run(
        ["bash", str(ROOT / "scripts" / "install_templestay_codex_cli.sh"),
         "--preset", "deep", "--memory-profile", "shared"],
        check=True, capture_output=True, text=True, cwd=tmp_path, env=env,
    )

    text = (fake_codex_home / "config.toml").read_text(encoding="utf-8")
    assert "[mcp_servers.templestay-claude-gateway]" in text
    assert "[mcp_servers.templestay-gemini-gateway]" in text
    assert 'CLAUDE_GATEWAY_DESTINATION_TRUST = "trusted_internal"' in text
    assert 'CLAUDE_GATEWAY_ALLOW_REPO_CONTENT = "true"' in text


def test_codex_install_replaces_legacy_managed_claude_gateway_env_table(tmp_path):
    fake_codex_home = tmp_path / "codex-legacy"
    fake_codex_home.mkdir()
    config = fake_codex_home / "config.toml"
    config.write_text(
        "[mcp_servers.templestay-claude-gateway]\n"
        'command = "uv"\n'
        'args = ["old-server.py"]\n\n'
        "[mcp_servers.templestay-claude-gateway.env]\n"
        'CLAUDE_DEFAULT_MODEL = "claude-opus-4-7"\n'
        'CLAUDE_DEFAULT_EFFORT = "max"\n\n',
        encoding="utf-8",
    )

    env = os.environ.copy()
    env["CODEX_HOME"] = str(fake_codex_home)

    subprocess.run(
        ["bash", str(ROOT / "scripts" / "install_templestay_codex_cli.sh"),
         "--preset", "balanced", "--memory-profile", "none"],
        check=True, capture_output=True, text=True, cwd=tmp_path, env=env,
    )

    text = config.read_text(encoding="utf-8")
    assert text.count("[mcp_servers.templestay-claude-gateway]") == 1
    assert text.count("[mcp_servers.templestay-claude-gateway.env]") == 1
    assert 'args = ["old-server.py"]' not in text
    parsed = tomllib.loads(text)
    claude_env = parsed["mcp_servers"]["templestay-claude-gateway"]["env"]
    assert claude_env["CLAUDE_GATEWAY_DESTINATION_TRUST"] == "trusted_internal"
    assert claude_env["CLAUDE_GATEWAY_ALLOW_REPO_CONTENT"] == "true"


def test_codex_install_memory_profile_none_skips_mcp_registration(tmp_path):
    fake_codex_home = tmp_path / "codex-home-none"
    fake_codex_home.mkdir()

    env = os.environ.copy()
    env["CODEX_HOME"] = str(fake_codex_home)

    subprocess.run(
        ["bash", str(ROOT / "scripts" / "install_templestay_codex_cli.sh"),
         "--preset", "minimal", "--memory-profile", "none"],
        check=True, capture_output=True, text=True, cwd=tmp_path, env=env,
    )

    config = fake_codex_home / "config.toml"
    if config.exists():
        text = config.read_text(encoding="utf-8")
        assert "[mcp_servers.templestay-memory]" not in text


def test_claude_plugin_validate_when_cli_available():
    if not shutil.which("claude"):
        return
    subprocess.run(
        ["claude", "plugin", "validate", str(CLAUDE)],
        check=True, capture_output=True, text=True, cwd=ROOT,
    )
