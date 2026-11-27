export interface ProcessIdentity {
  pid: number;
  pgid: number;
  startTicks: number;
}

export interface InferiorGroupIdentity {
  leaderPid: number;
  leaderStartTicks: number;
  pgid: number;
  gdbPid: number;
  /** Recorded inferior-side group members: PID -> Linux process start ticks. */
  members: Map<number, number>;
  /** False when /proc enumeration failed and the member snapshot is incomplete. */
  membersComplete: boolean;
}

export interface InferiorCleanupPlan {
  /** Individually revalidated members; callers must kill these through pidfds. */
  killMemberPids: number[];
  /** True when the current group cannot be proven to contain only recorded identities. */
  unresolved: boolean;
}

/**
 * Plans cleanup without trusting a recycled PGID. Only recorded inferior-side
 * members with matching start times are eligible for individual pidfd kills.
 * Unknown members make the cleanup unresolved; the debugger itself is never a
 * target merely because it shares the inferior process group.
 */
export function planInferiorCleanup(
  group: InferiorGroupIdentity,
  currentMembers: readonly ProcessIdentity[],
): InferiorCleanupPlan {
  if (!group.membersComplete) return { killMemberPids: [], unresolved: true };

  const killMemberPids: number[] = [];
  let unresolved = false;
  let candidateCount = 0;
  for (const member of currentMembers) {
    if (member.pid === group.gdbPid || member.pgid !== group.pgid) continue;
    candidateCount += 1;
    if (group.members.get(member.pid) === member.startTicks) killMemberPids.push(member.pid);
    else unresolved = true;
  }
  if (candidateCount > 0 && killMemberPids.length === 0) unresolved = true;
  return { killMemberPids, unresolved };
}
