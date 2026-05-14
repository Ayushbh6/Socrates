import { User } from "@socrates/contracts";

// Mock user state
// Change onboardingCompleted to true to test the projects flow
export function useCurrentUser(): { user: User | null; isLoading: boolean } {
  return {
    user: {
      id: "user_mock_123",
      displayName: "Mock User",
      onboardingCompleted: false, // Set to false to trigger welcome -> onboarding
    },
    isLoading: false,
  };
}