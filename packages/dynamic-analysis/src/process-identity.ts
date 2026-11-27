export interface ProcessIdentity {
  pid: number;
  pgid: number;
  startTicks: number;
}

export interface InferiorGroupIdentity {
  leaderPid: number;
  leaderStartTicks: number;
  /** Recorded group members: PID -> Linux process start ticks. */
  members: ReadonlyMap<number, number>;
}

export interface InferiorCleanupPlan {
  /** Safe only while the original group leader identity is still valid. */
  killGroupPids: number[];
  /** Individually revalidated members, used after the group leader exits. */
  killMemberPids: number[];
  /** True when the current group cannot be proven to contain only recorded identities. */
  unresolved: boolean;
}

/**
 * Plans cleanup without trusting a recycled PGID. A group-wide kill is allowed
 * only while the original leader is still alive with the recorded start time.
 * After leader exit, only recorded members with matching start times may be
 * killed individually; unknown members make the cleanup unresolved.
 */
export function planInferiorCleanup(
  group: InferiorGroupIdentity,
  currentLeader: ProcessIdentity | undefined,
  currentMembers: readonly ProcessIdentity[],
): InferiorCleanupPlan {
  if (currentLeader
    && currentLeader.pid === group.leaderPid
    && currentLeader.startTicks === group.leaderStartTicks
    && currentLeader.pgid === group.leaderPid) {
    return { killGroupPids: [group.leaderPid], killMemberPids: [], unresolved: false };
  }

  const killMemberPids: number[] = [];
  let unresolved = false;
  for (const member of currentMembers) {
    if (member.pgid !== group.leaderPid) continue;
    if (group.members.get(member.pid) === member.startTicks) killMemberPids.push(member.pid);
    else unresolved = true;
  }
  if (currentMembers.length > 0 && killMemberPids.length === 0) unresolved = true;
  return { killGroupPids: [], killMemberPids, unresolved };
}
