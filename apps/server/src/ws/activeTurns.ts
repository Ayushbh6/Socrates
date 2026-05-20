export class ActiveTurns {
  private readonly controllers = new Map<string, AbortController>()

  create(turnId: string): AbortController {
    const controller = new AbortController()
    this.controllers.set(turnId, controller)
    return controller
  }

  get(turnId: string): AbortController | undefined {
    return this.controllers.get(turnId)
  }

  delete(turnId: string): void {
    this.controllers.delete(turnId)
  }

  abortAll(): void {
    for (const controller of this.controllers.values()) {
      controller.abort()
    }
    this.controllers.clear()
  }
}
