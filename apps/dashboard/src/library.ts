/**
 * Which ready-made flow best fits the goal a customer chose at signup. Mirrors
 * recommendedLibraryFlow in @loomail/core (the dashboard keeps its own copy so it
 * does not import server code).
 *
 * Mirror side: PUBLIC (apps/dashboard is mirrored).
 */
export function recommendedFlowId(goal: string | null | undefined): string | null {
  switch (goal) {
    case "welcome":
    case "explore":
      return "welcome-onboarding";
    case "convert_trials":
      return "renewal-reminder";
    case "upgrade_free":
      return "upgrade-nudge";
    default:
      return null;
  }
}
