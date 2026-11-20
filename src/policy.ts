export type PolicyEffect = "allow_all" | "deny_all" | "allow";

export interface PolicyRule {
  readonly effect: PolicyEffect;
  readonly toolName?: string;
}

/**
 * Policy helpers matching google-antigravity `policy.allow_all()`, `deny_all()`, and `allow(name)`.
 */
export const policy = {
  allowAll(): PolicyRule {
    return { effect: "allow_all" };
  },
  denyAll(): PolicyRule {
    return { effect: "deny_all" };
  },
  allow(toolName: string): PolicyRule {
    return { effect: "allow", toolName };
  },
  evaluate(rules: readonly PolicyRule[], toolName: string): boolean {
    if (rules.length === 0) {
      return true;
    }
    let allowed = true;
    for (const rule of rules) {
      if (rule.effect === "allow_all") {
        allowed = true;
      } else if (rule.effect === "deny_all") {
        allowed = false;
      } else if (rule.effect === "allow" && rule.toolName === toolName) {
        allowed = true;
      }
    }
    return allowed;
  },
};
