"use client";

import {
  ArrowUp,
  Brain,
  FileText,
  Image as ImageIcon,
  Mic,
  Paperclip,
  Square,
  Wrench,
  X,
} from "lucide-react";
import {
  MAX_INLINE_MESSAGE_CHARS,
  MAX_MESSAGE_ATTACHMENTS,
} from "@socrates/contracts";
import { useRef, useState } from "react";
import styles from "./seamless.module.css";
import type { FlowDraftAttachment, FlowModelOption, FlowThinkingOption } from "./types";

export interface V2FlowComposerProps {
  isConnected: boolean;
  isSending?: boolean;
  placeholder?: string;
  models?: FlowModelOption[];
  selectedModelId?: string;
  thinkingOptions?: FlowThinkingOption[];
  selectedThinkingOptionId?: string;
  toolsEnabled?: boolean;
  voiceAvailable?: boolean;
  voiceRecording?: boolean;
  voiceBusy?: boolean;
  draftText?: string;
  connectionLabel?: string;
  onDraftTextChange?: (value: string) => void;
  onModelChange?: (modelId: string) => void;
  onThinkingChange?: (thinkingOptionId: string) => void;
  onToolsToggle?: (enabled: boolean) => void;
  onVoiceToggle?: () => void;
  onUploadAttachments?: (files: File[]) => Promise<FlowDraftAttachment[]>;
  onSend?: (content: string, attachments: FlowDraftAttachment[]) => Promise<void>;
  onStop?: () => void;
}

const acceptedAttachment = (file: File): boolean =>
  file.type.startsWith("image/") ||
  file.type === "text/plain" ||
  file.type === "application/zip" ||
  file.name.toLowerCase().endsWith(".txt") ||
  file.name.toLowerCase().endsWith(".zip");

export function V2FlowComposer({
  isConnected,
  isSending = false,
  placeholder = "Share a thought, question, or task…",
  models = [],
  selectedModelId,
  thinkingOptions = [],
  selectedThinkingOptionId,
  toolsEnabled = false,
  voiceAvailable = false,
  voiceRecording = false,
  voiceBusy = false,
  draftText,
  connectionLabel,
  onDraftTextChange,
  onModelChange,
  onThinkingChange,
  onToolsToggle,
  onVoiceToggle,
  onUploadAttachments,
  onSend,
  onStop,
}: V2FlowComposerProps) {
  const [internalContent, setInternalContent] = useState("");
  const [attachments, setAttachments] = useState<FlowDraftAttachment[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const content = draftText ?? internalContent;
  const setContent = (value: string) => {
    if (draftText !== undefined) onDraftTextChange?.(value);
    else setInternalContent(value);
  };

  const canSend =
    isConnected &&
    Boolean(onSend) &&
    !isSending &&
    !isUploading &&
    (content.trim().length > 0 || attachments.length > 0);
  const showCharacterCount = content.length >= MAX_INLINE_MESSAGE_CHARS * 0.8;

  const uploadFiles = async (fileList: File[] | FileList) => {
    if (!onUploadAttachments || isUploading) {
      return;
    }

    const openSlots = Math.max(0, MAX_MESSAGE_ATTACHMENTS - attachments.length);
    const files = Array.from(fileList).filter(acceptedAttachment).slice(0, openSlots);
    if (files.length === 0) {
      setNotice(openSlots === 0 ? `A turn can include up to ${MAX_MESSAGE_ATTACHMENTS} attachments.` : "Choose an image, text file, or Agent Skill ZIP.");
      return;
    }

    setIsUploading(true);
    setNotice(null);
    try {
      const uploaded = await onUploadAttachments(files);
      setAttachments((current) => [...current, ...uploaded].slice(0, MAX_MESSAGE_ATTACHMENTS));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not attach that file.");
    } finally {
      setIsUploading(false);
    }
  };

  const send = async () => {
    const nextContent = content.trim();
    if (!canSend || !onSend) {
      return;
    }

    setNotice(null);
    try {
      await onSend(nextContent, attachments);
      setContent("");
      setAttachments([]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The turn could not be sent.");
    }
  };

  return (
    <form
      className={styles.composer}
      data-dragging={isDraggingOver || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        void send();
      }}
      onDragOver={(event) => {
        if (!onUploadAttachments) return;
        event.preventDefault();
        setIsDraggingOver(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setIsDraggingOver(false);
        }
      }}
      onDrop={(event) => {
        if (!onUploadAttachments) return;
        event.preventDefault();
        setIsDraggingOver(false);
        void uploadFiles(event.dataTransfer.files);
      }}
    >
      {attachments.length > 0 && (
        <div className={styles.composerAttachments} aria-label="Draft attachments">
          {attachments.map((attachment) => (
            <span className={styles.attachmentChip} key={attachment.id}>
              {attachment.kind === "image" ? <ImageIcon aria-hidden="true" /> : <FileText aria-hidden="true" />}
              <span>{attachment.fileName}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.fileName}`}
                onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
              >
                <X aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      <label className={styles.srOnly} htmlFor="v2-flow-composer">
        Message Socrates
      </label>
      <textarea
        id="v2-flow-composer"
        value={content}
        disabled={!isConnected || !onSend}
        placeholder={isConnected && onSend ? placeholder : "Flow messaging will be available when the Seamless runtime is connected."}
        onChange={(event) => {
          setNotice(null);
          setContent(event.target.value);
        }}
        onPaste={(event) => {
          const imageFiles = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
          if (imageFiles.length > 0 && onUploadAttachments) {
            event.preventDefault();
            void uploadFiles(imageFiles);
            return;
          }

          const pastedText = event.clipboardData.getData("text/plain");
          if (pastedText.length <= MAX_INLINE_MESSAGE_CHARS) {
            return;
          }

          event.preventDefault();
          if (!onUploadAttachments) {
            setNotice(`Text over ${MAX_INLINE_MESSAGE_CHARS.toLocaleString()} characters requires attachment support.`);
            return;
          }

          const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID().slice(0, 8)
            : String(Date.now());
          const pastedFile = new File([pastedText], `pasted-text-${suffix}.txt`, { type: "text/plain" });
          void uploadFiles([pastedFile]);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
      />

      <div className={styles.composerToolbar}>
        <div className={styles.composerTools}>
          <input
            ref={fileInputRef}
            className={styles.srOnly}
            type="file"
            accept="image/*,text/plain,.txt,.zip,application/zip"
            multiple
            tabIndex={-1}
            onChange={(event) => {
              if (event.target.files) {
                void uploadFiles(event.target.files);
              }
              event.currentTarget.value = "";
            }}
          />
          <button
            type="button"
            className={styles.iconControl}
            disabled={!isConnected || !onUploadAttachments || isUploading}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach image, text file, or Agent Skill ZIP"
            title="Attach image, text file, or Agent Skill ZIP"
          >
            <Paperclip aria-hidden="true" />
          </button>

          <select
            className={styles.modelSelect}
            aria-label="Model"
            value={selectedModelId ?? ""}
            disabled={!isConnected || !onModelChange || models.length === 0}
            onChange={(event) => onModelChange?.(event.target.value)}
          >
            <option value="">{models.length === 0 ? "Model unavailable" : "Choose model"}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}{model.providerLabel ? ` · ${model.providerLabel}` : ""}
              </option>
            ))}
          </select>

          {(thinkingOptions.length > 1 || thinkingOptions.some((option) => option.enabled)) && (
            <label className={styles.thinkingSelectWrap} title="Thinking effort">
              <Brain aria-hidden="true" />
              <span className={styles.srOnly}>Thinking effort</span>
              <select
                className={styles.thinkingSelect}
                aria-label="Thinking effort"
                value={selectedThinkingOptionId ?? ""}
                disabled={!isConnected || !onThinkingChange}
                onChange={(event) => onThinkingChange?.(event.target.value)}
              >
                {thinkingOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.label}</option>
                ))}
              </select>
            </label>
          )}

          <button
            type="button"
            className={styles.textControl}
            aria-pressed={toolsEnabled}
            disabled={!isConnected || !onToolsToggle}
            onClick={() => onToolsToggle?.(!toolsEnabled)}
            title="Toggle tools"
          >
            <Wrench aria-hidden="true" />
            <span>Tools</span>
          </button>

          <button
            type="button"
            className={styles.iconControl}
            data-active={voiceRecording || undefined}
            aria-pressed={voiceRecording}
            disabled={!isConnected || !voiceAvailable || !onVoiceToggle || (voiceBusy && !voiceRecording)}
            onClick={onVoiceToggle}
            aria-label={voiceRecording ? "Stop voice recording" : "Start voice recording"}
            title={voiceAvailable ? "Voice input" : "Voice input unavailable"}
          >
            <Mic aria-hidden="true" />
          </button>
        </div>

        <button
          type={isSending ? "button" : "submit"}
          className={styles.sendControl}
          disabled={isSending ? !onStop : !canSend}
          onClick={isSending ? onStop : undefined}
          aria-label={isSending ? "Stop response" : "Send message"}
        >
          {isSending ? <Square aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
        </button>
      </div>

      <div className={styles.composerMeta} aria-live="polite">
        <span>{notice ?? connectionLabel ?? (isConnected ? "Enter to send · Shift + Enter for a new line" : "Seamless runtime disconnected")}</span>
        {showCharacterCount && <span>{content.length.toLocaleString()} / {MAX_INLINE_MESSAGE_CHARS.toLocaleString()}</span>}
      </div>
    </form>
  );
}
