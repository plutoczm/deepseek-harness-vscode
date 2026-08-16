/** Cross-feature navigation face for opening an existing Settings destination. */

/** One existing Settings section and optional child tab. */
export interface SettingsNavigationTarget {
  readonly sectionId: string
  readonly tabId?: string
}

/** Minimal outward face consumed by features that link into Settings. */
export interface ISettingsNavigation {
  open(target: SettingsNavigationTarget): void
  subscribe(listener: (target: SettingsNavigationTarget) => void): () => void
}

/** Ephemeral navigation events; Settings remains the only owner of panel state. */
export class SettingsNavigationController implements ISettingsNavigation {
  readonly #listeners = new Set<(target: SettingsNavigationTarget) => void>()
  #lastTarget: SettingsNavigationTarget | undefined

  open(target: SettingsNavigationTarget): void {
    if (target.sectionId === '') throw new Error('settings navigation requires a section id')
    this.#lastTarget = target
    for (const listener of this.#listeners) listener(target)
  }

  subscribe(listener: (target: SettingsNavigationTarget) => void): () => void {
    this.#listeners.add(listener)
    // The requested child can mount only after the shell consumes the same
    // navigation event, so replay the latest target to that late subscriber.
    if (this.#lastTarget !== undefined) listener(this.#lastTarget)
    return () => { this.#listeners.delete(listener) }
  }
}
