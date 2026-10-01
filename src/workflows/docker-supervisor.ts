const flag = '--flow-docker-supervisor';

/**
 * External execution is unavailable until mount-source identity is enforced end to end.
 *
 * A validated Scope pathname can be replaced through a concurrently writable ancestor
 * before Docker mounts it. Rechecking the pathname before/after `docker run` does not
 * close that race. The runtime bundle's read-only bind has the same source-identity issue.
 *
 * A prospective implementation must acquire validated source descriptors in trusted,
 * already-loaded host code, keep them open until container removal is confirmed, and
 * submit /proc/<host-visible-supervisor-pid>/fd/<fd>, never the resolved mutable name.
 * It must also establish that the actual daemon/containerd/OCI runtime preserves those
 * magic links (and shares the relevant host PID/proc view). Docker's string-based mount
 * API does not promise descriptor identity; Flow currently admits arbitrary installed
 * daemon versions and operator-selected runtimes, not an audited stack.
 *
 * Upstream review (not a guarantee for the installed stack):
 * - docker/cli v28.5.1 opts/mount.go: absolute Source is retained.
 * - moby/moby v28.5.1 volume/mounts/{linux_parser,mounts}.go and daemon/oci_linux.go:
 *   private bind sources are retained; EvalSymlinks is used for relabeling/propagation.
 * - opencontainers/runc v1.3.3 libcontainer/{specconv/spec_linux,rootfs_linux,mount_linux}.go:
 *   Source is retained; mountViaFds uses mount(2), and mountFd can open an O_PATH source.
 * These paths suggest pinning can work on a restricted stack, but do not prove it for
 * every runtime Flow can launch. No real Docker validation was available for this review.
 * Do not replace this refusal with path checks, version probes, or a mutable-path fallback.
 */
export function assertDockerMountSourceSupport(): never {
  throw new Error('External sandbox execution refused: Docker bind mount source pinning is not verified for the installed daemon/runtime; mutable Scope paths cannot be mounted safely. No unrestricted fallback is permitted.');
}

/** Preserve the launcher API, but refuse before spawning any external execution. */
export function dockerSupervisorLaunch(): { command: string; args: string[] } {
  assertDockerMountSourceSupport();
}

export function isDockerSupervisor(): boolean { return process.argv[2] === flag; }

/** Refuse direct/SEA supervisor entry too, before reading configuration or spawning Docker. */
export async function runDockerSupervisor(): Promise<void> {
  assertDockerMountSourceSupport();
}
