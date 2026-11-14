export type LiveCaptionSegment = { id: string; text: string; startedAt: string }

export function buildLiveCaptionStack(persisted: LiveCaptionSegment[], local: LiveCaptionSegment[], interim: string) {
  const persistedIds = new Set(persisted.map((segment) => segment.id))
  return {
    finals: [...persisted, ...local.filter((segment) => !persistedIds.has(segment.id))].sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()).slice(-3),
    interim,
  }
}
