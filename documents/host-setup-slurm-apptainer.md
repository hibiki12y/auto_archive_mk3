# Host Setup — single-node SLURM + Apptainer for Auto Archive

This document describes the host-side prerequisites that let the Auto
Archive Discord service dispatch every task through the slurm+apptainer
compute node. The current branch ships the software side
(`SlurmApptainerComputeNode`, `ProcessSubprocessRunner`,
`agent-instance-entry.js`, `containers/agent-instance.def`); the host
configuration described below is the operator's responsibility and is
not provisioned automatically.

## Scope

- One physical/virtual host that acts simultaneously as the SLURM
  controller (`slurmctld`) and a single compute node (`slurmd`).
- Apptainer 1.x installed system-wide.
- Auto Archive built locally (`pnpm build`) so the agent-instance entry
  script is available under `dist/runtime/agent-instance-entry.js`.

## Required binaries

| Binary | Purpose | Default location |
| --- | --- | --- |
| `salloc` | Acquire SLURM allocation per task. | `/usr/bin/salloc` |
| `scancel` | Cooperative cancellation. | `/usr/bin/scancel` |
| `apptainer` | Run the agent-instance container. | `/usr/bin/apptainer` |
| `node` | Container entry point (provided by the SIF image). | `/usr/local/bin/node` (inside container) |

If any binary lives off `$PATH`, set the corresponding env var so the
production `ProcessSubprocessRunner` can pin the absolute path:

- `AUTO_ARCHIVE_APPTAINER_CLI_PATH`
- `AUTO_ARCHIVE_SLURM_SALLOC_PATH`
- `AUTO_ARCHIVE_SLURM_SCANCEL_PATH`

## SLURM (single-node) install outline

Operator-side steps. These touch the host package manager and require
sudo; Claude Code will not perform them automatically.

1. Install `slurm-wlm`, `slurmd`, `slurmctld` from the host distribution
   (Debian/Ubuntu: `sudo apt-get install slurm-wlm`).
2. Drop a minimal `/etc/slurm/slurm.conf` that names the host as both
   the controller and the only compute node. The file ships in the
   `slurm-wlm` example directory; the only edits typically required are
   `ControlMachine=$(hostname -s)` and a single `NodeName=...
   CPUs=N State=UNKNOWN` line plus a `PartitionName=debug Nodes=ALL
   Default=YES MaxTime=INFINITE State=UP` line.
3. Create `/var/spool/slurmd` and `/var/spool/slurmctld` with the right
   ownership.
4. Enable and start `slurmctld` and `slurmd` (`systemctl enable --now`).
5. Verify with `sinfo` and `srun -N1 hostname`.

A safe smoke check is `salloc --no-shell --time=1 --cpus-per-task=1 true`
which should return immediately and emit "salloc: Granted job
allocation N".

## Apptainer install outline

1. Install `apptainer` (Debian/Ubuntu has packages under that name; on
   distributions without packages, build from source). Verify with
   `apptainer --version`.
2. Make sure user namespaces are enabled in the kernel
   (`unprivileged_userns_clone=1` on most distributions).

## Building the agent-instance image

The repository ships `containers/agent-instance.def` and a companion
`containers/agent-instance-post.sh` that performs the in-container OS
package install + Codex CLI install. Build the SIF locally:

```
pnpm build  # produces dist/ used by the .def %files block
apptainer build agent-instance.sif containers/agent-instance.def
```

Move the resulting `agent-instance.sif` to a stable path
(e.g. `/opt/auto-archive/images/agent-instance.sif`) and point
`AUTO_ARCHIVE_APPTAINER_IMAGE` at it.

## Wiring the discord-service

Set in `.env` (or in the systemd unit / docker-compose env block that
runs the discord-service):

```
# Production posture: tasks must execute inside slurm+apptainer.
AUTO_ARCHIVE_COMPUTE_NODE=          # leave empty; defaults to slurm-apptainer
AUTO_ARCHIVE_APPTAINER_IMAGE=/opt/auto-archive/images/agent-instance.sif
AUTO_ARCHIVE_AGENT_INSTANCE_ENTRY=/opt/auto-archive/dist/runtime/agent-instance-entry.js
AUTO_ARCHIVE_AGENT_INSTANCE_NODE_BIN=/usr/local/bin/node
```

Run `pnpm doctor` after the change. The "Runtime provider scope" section
must report:

- `Compute mode: default` (or `slurm-apptainer`)
- `Apptainer image: ` set
- `Agent-instance entry: ` set

If the section reports `warn`, doctor prints the exact remediation. The
service will hard-fail at first dispatch when any of the three settings
is missing because the `ProcessSubprocessRunner` cannot reach `salloc`
or `apptainer`.

## Discord service hosting note

`apptainer exec` and `salloc` typically need access to the host's
`/proc`, `/sys`, and `/run/slurm` mounts and the user namespace. Running
the discord-service inside Docker with bind-mounts to those host paths
is fragile — the recommended deployment for the slurm+apptainer
compute node is to **run the discord-service directly on the host**
(e.g., a `systemd` unit invoking `node dist/src/discord/discord-service-bootstrap.js`)
rather than the existing `docker-compose.yml`. The `docker-compose.yml`
remains valid for `current-node` smoke testing only; production
deployment that satisfies "all tasks must be sandboxed via slurm +
apptainer" should decommission the discord-service Docker container.

## Verification checklist

- `salloc --no-shell --time=1 true` succeeds on host.
- `apptainer exec /opt/auto-archive/images/agent-instance.sif node --version`
  prints a Node version.
- `pnpm doctor` reports `pass` on the runtime provider scope section.
- A test dispatch (e.g., `/ask` of a trivial instruction in the wired
  Discord channel) lands in `runtime-state/research-control-events.jsonl`
  with `provenance: compute-node-slurm-apptainer` (or the
  `agent-instance-entry` provenance from the entry script).

## Roll-back

To temporarily fall back to the old `current-node` (in-process, no
sandbox) path during host outages:

```
AUTO_ARCHIVE_COMPUTE_NODE=current-node
```

Doctor will report `warn` because production policy requires
slurm-apptainer. Always restore the slurm-apptainer setting once the
host environment is healthy again.
