import type { ModelOption, ModelThinkingOption } from "@socrates/contracts";
import type { ComposerAttachment } from "@/components/chat/ChatComposer";

const HANDOFF_KEY_PREFIX = "socrates-view-handoff-v1";
const HANDOFF_MAX_AGE_MS = 10 * 60 * 1_000;

export type ViewHandoffTarget = "classic" | "flow";

export type ViewHandoffEnvelope = Readonly<{
  version: 1;
  target: ViewHandoffTarget;
  projectId: string;
  conversationId?: string;
  text: string;
  attachments: readonly Readonly<Pick<ComposerAttachment, "fileName" | "kind" | "url" | "uri">>[];
  model?: Readonly<Pick<ModelOption, "providerId" | "authMode" | "modelId">>;
  thinkingOptionId?: string;
  createdAt: number;
}>;

export const createViewHandoff = (input: {
  target: ViewHandoffTarget;
  projectId: string;
  conversationId?: string;
  text: string;
  attachments?: readonly ComposerAttachment[];
  model?: ModelOption | null;
  thinking?: ModelThinkingOption | null;
}): string => {
  const nonce = crypto.randomUUID();
  const envelope: ViewHandoffEnvelope = {
    version: 1,
    target: input.target,
    projectId: input.projectId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    text: input.text,
    attachments: (input.attachments ?? []).map((attachment) => ({
      fileName: attachment.fileName,
      kind: attachment.kind,
      uri: attachment.uri,
      ...(attachment.url ? { url: attachment.url } : {}),
    })),
    ...(input.model ? { model: {
      providerId: input.model.providerId,
      authMode: input.model.authMode,
      modelId: input.model.modelId,
    } } : {}),
    ...(input.thinking ? { thinkingOptionId: input.thinking.id } : {}),
    createdAt: Date.now(),
  };
  window.sessionStorage.setItem(`${HANDOFF_KEY_PREFIX}:${nonce}`, JSON.stringify(envelope));
  return nonce;
};

export const appendViewHandoff = (href: string, nonce: string): string => {
  const url = new URL(href, window.location.origin);
  url.searchParams.set("handoff", nonce);
  return `${url.pathname}${url.search}${url.hash}`;
};

export const readViewHandoffSnapshot = (): string | null => {
  if (typeof window === "undefined") return null;
  const nonce = new URL(window.location.href).searchParams.get("handoff");
  return nonce ? window.sessionStorage.getItem(`${HANDOFF_KEY_PREFIX}:${nonce}`) : null;
};

export const parseViewHandoffSnapshot = (
  raw: string | null,
  target: ViewHandoffTarget,
  projectId: string,
  conversationId?: string,
): ViewHandoffEnvelope | null => {
  if (!raw) return null;
  try {
    const envelope = JSON.parse(raw) as ViewHandoffEnvelope;
    if (
      envelope.version !== 1 ||
      envelope.target !== target ||
      envelope.projectId !== projectId ||
      (conversationId && envelope.conversationId && envelope.conversationId !== conversationId) ||
      Date.now() - envelope.createdAt > HANDOFF_MAX_AGE_MS
    ) return null;
    return envelope;
  } catch {
    return null;
  }
};

export const consumeViewHandoff = (target: ViewHandoffTarget, projectId: string, conversationId?: string): ViewHandoffEnvelope | null => {
  if (typeof window === "undefined") return null;
  const url = new URL(window.location.href);
  const nonce = url.searchParams.get("handoff");
  if (!nonce) return null;
  url.searchParams.delete("handoff");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  const key = `${HANDOFF_KEY_PREFIX}:${nonce}`;
  const raw = window.sessionStorage.getItem(key);
  window.sessionStorage.removeItem(key);
  if (!raw) return null;
  return parseViewHandoffSnapshot(raw, target, projectId, conversationId);
};

export const clearCurrentViewHandoff = (): void => {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const nonce = url.searchParams.get("handoff");
  if (!nonce) return;
  window.sessionStorage.removeItem(`${HANDOFF_KEY_PREFIX}:${nonce}`);
  url.searchParams.delete("handoff");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
};

export const handoffAttachmentsToFiles = async (attachments: ViewHandoffEnvelope["attachments"]): Promise<File[]> => {
  const files: File[] = [];
  for (const attachment of attachments) {
    const source = attachment.url ? new URL(attachment.url, window.location.origin).toString() : attachment.uri;
    if (!source) continue;
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Could not transfer ${attachment.fileName}.`);
    const blob = await response.blob();
    files.push(new File([blob], attachment.fileName, { type: blob.type || undefined }));
  }
  return files;
};
