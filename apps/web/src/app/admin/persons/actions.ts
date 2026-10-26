"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import {
  activateAsset,
  createPerson,
  deletePersonCompletely,
  setConsent,
  setStageSubject,
} from "@/features/face/server/repository";
import { ID_PATTERN } from "@/lib/paths";

export type ActionState = { error: string | null };

const id = z.string().regex(ID_PATTERN);

const createSchema = z.object({
  name: z.string().trim().min(1, "名前を入力してください").max(64, "名前は 64 文字以内にしてください"),
  consent: z.literal("on").optional(),
});

export async function createPersonAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = createSchema.safeParse(Object.fromEntries(formData.entries()));
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "入力が不正です" };
  createPerson(parsed.data.name, parsed.data.consent === "on");
  revalidatePath("/admin/persons");
  return { error: null };
}

export async function setConsentAction(personId: string, consented: boolean): Promise<void> {
  setConsent(id.parse(personId), consented);
  revalidatePath("/admin/persons");
  revalidatePath(`/admin/persons/${personId}/face`);
  revalidatePath("/stage/face");
}

export async function deletePersonAction(personId: string, redirectTo?: string): Promise<void> {
  await deletePersonCompletely(id.parse(personId));
  revalidatePath("/admin/persons");
  revalidatePath("/stage/face");
  if (redirectTo) redirect(redirectTo);
}

export async function activateAssetAction(personId: string, assetId: string): Promise<void> {
  activateAsset(id.parse(personId), id.parse(assetId));
  revalidatePath(`/admin/persons/${personId}/face`);
  revalidatePath("/admin/persons");
  revalidatePath("/stage/face");
}

export async function setStageSubjectAction(personId: string): Promise<void> {
  setStageSubject(id.parse(personId));
  revalidatePath("/admin/persons");
  revalidatePath("/stage/face");
}
