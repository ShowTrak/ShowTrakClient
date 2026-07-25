export async function Wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
