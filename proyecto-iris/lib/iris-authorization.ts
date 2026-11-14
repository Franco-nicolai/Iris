export function ownsResource(resourceUserId: string | null | undefined, userId: string) {
  return Boolean(resourceUserId) && resourceUserId === userId
}
