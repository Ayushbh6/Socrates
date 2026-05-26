"use client";

import type { ConversationPartialTurn, ConversationToolRun, Message } from "@socrates/contracts";
import { Check, ChevronDown, Copy } from "lucide-react";
import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChatToolTimeline } from "./ChatToolTimeline";
import type { PendingApproval, ToolTimelineItem } from "./ToolTimelineTypes";
import { toolRunToTimelineItem } from "./ToolTimelineTypes";

interface ChatTranscriptProps {
  messages: Message[];
  toolRuns?: ConversationToolRun[];
  partialTurns?: ConversationPartialTurn[];
  liveThinking?: string;
  liveAnswer?: string;
  liveTools?: ToolTimelineItem[];
  approvals?: PendingApproval[];
  isStreaming?: boolean;
  isCompacting?: boolean;
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
}

export function ChatTranscript({
  messages,
  toolRuns = [],
  partialTurns = [],
  liveThinking,
  liveAnswer,
  liveTools = [],
  approvals = [],
  isStreaming,
  isCompacting,
  onApprovalDecision,
}: ChatTranscriptProps) {
  const isWaitingForFirstToken = Boolean(isStreaming && !isCompacting && !liveThinking && !liveAnswer && liveTools.length === 0);
  const historicalToolsByTurn = groupToolRunsByTurn(toolRuns);
  const assistantTurnIds = new Set(
    messages.filter((message) => message.role === "assistant" && message.turnId).map((message) => message.turnId as string),
  );
  const partialTurnsByTurn = new Map(partialTurns.map((turn) => [turn.turnId, turn]));

  return (
    <div className="flex-1 overflow-y-auto px-6 py-8">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        {messages.map((message) => {
          const tools =
            message.role === "assistant" && message.turnId ? historicalToolsByTurn.get(message.turnId) ?? [] : [];
          const shouldRenderIncompleteTurn =
            message.role === "user" && message.turnId && !assistantTurnIds.has(message.turnId);
          const incompleteTurn = shouldRenderIncompleteTurn ? partialTurnsByTurn.get(message.turnId as string) : undefined;
          const incompleteTools = shouldRenderIncompleteTurn ? historicalToolsByTurn.get(message.turnId as string) ?? [] : [];

          return (
            <div key={message.id} className="contents">
              <MessageBubble message={message} tools={tools} />
              {shouldRenderIncompleteTurn ? (
                <IncompleteTurnBubble turn={incompleteTurn} tools={incompleteTools} />
              ) : null}
            </div>
          );
        })}
        {(liveThinking || liveAnswer || isStreaming || isCompacting) && (
          <div className="flex justify-start">
            <div className="w-full max-w-3xl text-sm leading-6 text-brand-text-dark">
              {liveThinking && (
                <ThinkingBlock content={liveThinking} defaultOpen />
              )}
              <ChatToolTimeline tools={liveTools} approvals={approvals} onApprovalDecision={onApprovalDecision} />
              {isCompacting ? <CompactionLoader /> : null}
              {liveAnswer ? <MarkdownContent content={liveAnswer} /> : isWaitingForFirstToken ? <FirstTokenLoader /> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function IncompleteTurnBubble({ turn, tools }: { turn?: ConversationPartialTurn; tools: ToolTimelineItem[] }) {
  if (!turn && tools.length === 0) {
    return null;
  }

  const hasPartialText = Boolean(turn?.answer || turn?.reasoning);
  const label =
    turn?.status === "running"
      ? "Interrupted turn"
      : turn?.status === "failed"
        ? "Stopped: turn failed before final answer"
        : "Stopped before final answer";

  return (
    <div className="flex justify-start">
      <div className="w-full max-w-3xl rounded-2xl rounded-tl-sm border border-amber-100 bg-amber-50/40 px-4 py-3 text-sm leading-6 text-brand-text-dark">
        <StoppedIndicator reason={label} />
        {turn?.reasoning ? <ThinkingBlock content={turn.reasoning} /> : null}
        <ChatToolTimeline tools={tools} />
        {turn?.answer ? (
          <MarkdownContent content={turn.answer} />
        ) : hasPartialText ? null : (
          <p className="text-brand-text-light">No assistant text was streamed before this turn stopped.</p>
        )}
      </div>
    </div>
  );
}

function CompactionLoader() {
  return (
    <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-teal-100 bg-teal-50 px-3 py-1.5 text-xs font-medium text-brand-teal-dark">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-teal-dark opacity-25" />
        <span className="relative inline-flex size-2 rounded-full bg-brand-teal-dark" />
      </span>
      Compacting conversation context...
    </div>
  );
}

function FirstTokenLoader() {
  return (
    <div className="flex h-6 items-center">
      <span className="relative flex size-3">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-teal-dark opacity-25" />
        <span className="relative inline-flex size-3 animate-pulse rounded-full bg-brand-teal-dark shadow-[0_0_18px_rgba(20,184,166,0.55)]" />
      </span>
    </div>
  );
}

function MessageBubble({ message, tools }: { message: Message; tools: ToolTimelineItem[] }) {
  const isUser = message.role === "user";

  return (
    <div className={isUser ? "flex justify-end" : "flex justify-start"}>
      <div
        className={
          isUser
            ? "max-w-2xl rounded-2xl rounded-tr-sm bg-brand-button px-4 py-3 text-sm leading-6 text-white"
            : "max-w-2xl rounded-2xl rounded-tl-sm border border-gray-200 bg-white px-4 py-3 text-sm leading-6 text-brand-text-dark shadow-sm"
        }
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <>
            {message.reasoning ? <ThinkingBlock content={message.reasoning} /> : null}
            {message.partial || message.cancelled ? <StoppedIndicator reason={message.cancellationReason} /> : null}
            <ChatToolTimeline tools={tools} />
            <MarkdownContent content={message.content} />
          </>
        )}
      </div>
    </div>
  );
}

function StoppedIndicator({ reason }: { reason?: string }) {
  return (
    <div className="mb-3 inline-flex items-center rounded-full bg-gray-100 px-2.5 py-1 text-xs font-medium text-brand-text-light">
      Stopped{reason ? `: ${reason}` : ""}
    </div>
  );
}

function groupToolRunsByTurn(toolRuns: ConversationToolRun[]): Map<string, ToolTimelineItem[]> {
  const grouped = new Map<string, ToolTimelineItem[]>();
  for (const run of toolRuns) {
    const tools = grouped.get(run.turnId) ?? [];
    tools.push(toolRunToTimelineItem(run));
    grouped.set(run.turnId, tools);
  }
  return grouped;
}

function ThinkingBlock({ content, defaultOpen = false }: { content: string; defaultOpen?: boolean }) {
  return (
    <details className="group mb-3 rounded-xl bg-gray-50 px-3 py-2 text-brand-text-light" open={defaultOpen || undefined}>
      <summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-medium uppercase tracking-wide text-brand-teal-dark">
        <ChevronDown className="size-3 transition-transform group-open:rotate-180" />
        Thinking
      </summary>
      <p className="mt-2 whitespace-pre-wrap">{content}</p>
    </details>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        code: ({ className, children }) => {
          const isBlock = typeof className === "string" && className.startsWith("language-");
          if (isBlock) {
            return <code className={className}>{children}</code>;
          }
          return <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[0.9em] text-brand-text-dark">{children}</code>;
        },
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        strong: ({ children }) => <strong className="font-semibold text-brand-text-dark">{children}</strong>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = extractCodeText(children).replace(/\n$/, "");
  const language = extractCodeLanguage(children) ?? "code";

  const copyCode = async () => {
    if (!code) {
      return;
    }
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_400);
  };

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-gray-800 bg-gray-950 shadow-sm last:mb-0">
      <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-2">
        <span className="font-mono text-xs text-gray-300">{language}</span>
        <button
          type="button"
          onClick={copyCode}
          className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-gray-300 transition hover:bg-white/10 hover:text-white"
          aria-label="Copy code"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-[34rem] overflow-auto p-4 font-mono text-[13px] leading-6 text-gray-100">
        <code className="whitespace-pre text-gray-100">{code}</code>
      </pre>
    </div>
  );
}

function extractCodeLanguage(children: ReactNode): string | undefined {
  if (!isValidElement(children)) {
    return undefined;
  }
  const className = (children.props as { className?: string }).className;
  const match = className?.match(/language-([^\s]+)/);
  return match?.[1];
}

function extractCodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(extractCodeText).join("");
  }
  if (isValidElement(node)) {
    return extractCodeText((node.props as { children?: ReactNode }).children);
  }
  return "";
}
