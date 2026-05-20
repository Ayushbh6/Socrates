import type { CompleteOnboardingRequest, User } from "@socrates/contracts"
import { createId, nowIso, SocratesError } from "@socrates/shared"
import { eq } from "drizzle-orm"
import { users } from "../../db/schema"
import { mapUser } from "../../db/mappers"
import { StoreBase } from "./shared"

export class UserStore extends StoreBase {
  getCurrentUser(): User | null {
    const row = this.getCurrentUserRow()
    return row ? mapUser(row) : null
  }

  completeOnboarding(input: CompleteOnboardingRequest): User {
    const existing = this.getCurrentUserRow()
    const now = nowIso()

    if (existing) {
      this.handle.db
        .update(users)
        .set({
          displayName: input.displayName,
          onboardingCompleted: true,
          updatedAt: now,
          onboardedAt: existing.onboardedAt ?? now,
        })
        .where(eq(users.id, existing.id))
        .run()

      const updated = this.handle.db.select().from(users).where(eq(users.id, existing.id)).get()
      if (!updated) {
        throw new SocratesError("user_not_found", "User was not found after onboarding update")
      }
      this.appendEvent({
        type: "user.updated",
        source: "server",
        payload: { userId: updated.id },
      })
      return mapUser(updated)
    }

    const id = createId("user")
    this.handle.db
      .insert(users)
      .values({
        id,
        displayName: input.displayName,
        onboardingCompleted: true,
        createdAt: now,
        updatedAt: now,
        onboardedAt: now,
      })
      .run()

    this.appendEvent({
      type: "user.onboarding.completed",
      source: "server",
      payload: { userId: id },
    })

    return mapUser(this.mustGetUserRow(id))
  }
}
