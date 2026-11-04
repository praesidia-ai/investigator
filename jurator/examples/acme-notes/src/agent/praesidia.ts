// Stand-in for the Praesidia SDK: asks for human approval before a risky tool runs.
export async function approvalGate(tool: string, args: Record<string, unknown>): Promise<void> {
  void tool; void args;
}
