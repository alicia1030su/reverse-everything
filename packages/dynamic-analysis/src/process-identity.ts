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
 * members with matching start times are eligible for individual pidfd kills,
 * even if they changed groups. Unknown members in the original group make the
 * cleanup unresolved; the debugger itself is never a target merely because it
 * shares the inferior process group. currentMembers is a complete /proc snapshot.
 */
export function planInferiorCleanup(
  group: InferiorGroupIdentity,
  currentMembers: readonly ProcessIdentity[],
): InferiorCleanupPlan {
  if (!group.membersComplete) return { killMemberPids: [], unresolved: true };

  const observed = new Map(currentMembers.map(member => [member.pid, member]));
  const killMemberPids: number[] = [];
  let unresolved = false;
  // Membership is tied to PID + start time, not to the original PGID: a live
  // inferior may call setsid()/setpgid() after its identity was captured.
  for (const [pid, startTicks] of group.members) {
    if (pid === group.gdbPid) continue;
    const member = observed.get(pid);
    if (!member) continue;
    if (member.startTicks === startTicks) killMemberPids.push(pid);
    else unresolved = true;
  }
  for (const member of currentMembers) {
    if (member.pid !== group.gdbPid && member.pgid === group.pgid && !group.members.has(member.pid)) unresolved = true;
  }
  return { killMemberPids, unresolved };
}
