/** Writes stay off unless a deployment build sets this. The default desk cannot broadcast. */
export const writesEnabled = process.env.NEXT_PUBLIC_ENABLE_WRITES === "1";

export function assertCanWrite() {
  if (!writesEnabled) {
    throw new Error("This build does not send transactions. It is a preview.");
  }
}
