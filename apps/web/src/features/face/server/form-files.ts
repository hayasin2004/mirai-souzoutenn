import "server-only";

export async function bytesOf(v: FormDataEntryValue | null, max: number): Promise<Uint8Array | null> {
  if (!(v instanceof File) || v.size === 0 || v.size > max) return null;
  return new Uint8Array(await v.arrayBuffer());
}

