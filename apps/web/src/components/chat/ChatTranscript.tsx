"use client";

import type { ConversationActivityStep, ConversationPartialTurn, ConversationToolRun, Message, MessageAttachment } from "@socrates/contracts";
import { Check, ChevronDown, Copy, SquareTerminal } from "lucide-react";
import { isValidElement, useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { socratesApiBaseUrl } from "@/lib/api";
import { ChatToolTimeline } from "./ChatToolTimeline";
import type { PendingApproval, ToolTimelineItem } from "./ToolTimelineTypes";
import { toolRunToTimelineItem } from "./ToolTimelineTypes";

interface ChatTranscriptProps {
  messages: Message[];
  toolRuns?: ConversationToolRun[];
  partialTurns?: ConversationPartialTurn[];
  activitySteps?: ConversationActivityStep[];
  liveSteps?: LiveActivityStep[];
  approvals?: PendingApproval[];
  settledLiveTurns?: Record<string, LiveActivityStep[]>;
  anchorMessageId?: string | null;
  isStreaming?: boolean;
  isCompacting?: boolean;
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
}

export type LiveActivityStep = {
  key: string;
  turnId?: string;
  modelCallId?: string;
  stepIndex: number;
  reasoning: string;
  answer: string;
  tools: ToolTimelineItem[];
};

export function ChatTranscript({
  messages,
  toolRuns = [],
  partialTurns = [],
  activitySteps = [],
  liveSteps = [],
  approvals = [],
  settledLiveTurns = {},
  anchorMessageId,
  isStreaming,
  isCompacting,
  onApprovalDecision,
}: ChatTranscriptProps) {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const scrolledAnchorRef = useRef<string | null>(null);
  const hasLiveActivity = liveSteps.some((step) => step.reasoning || step.answer || step.tools.length > 0);
  const isWaitingForFirstToken = Boolean(isStreaming && !isCompacting && !hasLiveActivity);
  const historicalToolsByTurn = groupToolRunsByTurn(toolRuns);
  const historicalStepsByTurn = groupActivityStepsByTurn(activitySteps, toolRuns);
  const liveToolIds = new Set(liveSteps.flatMap((step) => step.tools.map((tool) => tool.toolCallId)));
  const liveTurnIds = new Set(liveSteps.map((step) => step.turnId).filter(Boolean));
  const assistantTurnIds = new Set(
    messages.filter((message) => message.role === "assistant" && message.turnId).map((message) => message.turnId as string),
  );
  const partialTurnsByTurn = new Map(partialTurns.map((turn) => [turn.turnId, turn]));

  useEffect(() => {
    if (!anchorMessageId || scrolledAnchorRef.current === anchorMessageId) {
      return;
    }
    const container = scrollContainerRef.current;
    const target = container?.querySelector<HTMLElement>(`[data-message-id="${cssAttributeValue(anchorMessageId)}"]`);
    if (!container || !target) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const containerRect = container.getBoundingClientRect();
      const targetRect = target.getBoundingClientRect();
      const top = container.scrollTop + targetRect.top - containerRect.top - 18;
      container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
      scrolledAnchorRef.current = anchorMessageId;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [anchorMessageId, messages.length]);

  return (
    <div ref={scrollContainerRef} className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
      <div className="mx-auto flex min-w-0 w-full max-w-4xl flex-col gap-5">
        {messages.map((message) => {
          const tools = message.role === "assistant" && message.turnId ? historicalToolsByTurn.get(message.turnId) ?? [] : [];
          const steps = message.role === "assistant" && message.turnId ? historicalStepsByTurn.get(message.turnId) ?? [] : [];
          const assistantSettledSteps =
            message.role === "assistant" && message.turnId ? settledLiveTurns[message.turnId] ?? [] : [];
          const shouldRenderIncompleteTurn =
            message.role === "user" && message.turnId && !assistantTurnIds.has(message.turnId) && !liveTurnIds.has(message.turnId);
          const incompleteTurn = shouldRenderIncompleteTurn ? partialTurnsByTurn.get(message.turnId as string) : undefined;
          const incompleteTools = shouldRenderIncompleteTurn ? historicalToolsByTurn.get(message.turnId as string) ?? [] : [];
          const settledSteps = shouldRenderIncompleteTurn ? settledLiveTurns[message.turnId as string] ?? [] : [];

          return (
            <div key={message.id} className="contents">
              <MessageBubble message={message} tools={tools} steps={steps} settledSteps={assistantSettledSteps} />
              {shouldRenderIncompleteTurn ? (
                <IncompleteTurnBubble turn={incompleteTurn} tools={incompleteTools} liveSteps={settledSteps} />
              ) : null}
            </div>
          );
        })}
        {(hasLiveActivity || isStreaming || isCompacting) && (
          <div className="flex min-w-0 justify-start">
            <div className="min-w-0 w-full max-w-3xl text-sm leading-6 text-brand-text-dark">
              {liveSteps.map((step, index) => (
                <ActivityStepView
                  key={step.key}
                  reasoning={step.reasoning}
                  answer={step.answer}
                  tools={step.tools}
                  approvals={approvalsForLiveStep(step, approvals, liveToolIds, index === liveSteps.length - 1)}
                  defaultOpen
                  onApprovalDecision={onApprovalDecision}
                />
              ))}
              {isCompacting ? <CompactionLoader /> : null}
              {isWaitingForFirstToken ? <FirstTokenLoader /> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function IncompleteTurnBubble({
  turn,
  tools,
  liveSteps = [],
}: {
  turn?: ConversationPartialTurn;
  tools: ToolTimelineItem[];
  liveSteps?: LiveActivityStep[];
}) {
  if (!turn && tools.length === 0 && liveSteps.length === 0) {
    return null;
  }

  const hasPartialText = Boolean(turn?.answer || turn?.reasoning || liveSteps.some((step) => step.reasoning || step.answer));
  const label =
    turn?.status === "running"
      ? "Interrupted turn"
      : turn?.status === "failed"
        ? "Stopped: turn failed before final answer"
        : "Stopped before final answer";

  return (
    <div className="flex min-w-0 justify-start">
      <div className="min-w-0 w-full max-w-3xl rounded-xl rounded-tl-sm border border-amber-100 bg-amber-50/40 px-4 py-3 text-sm leading-6 text-brand-text-dark">
        <StoppedIndicator reason={label} />
        {liveSteps.length > 0 ? (
          <AssistantActivityStream steps={liveSteps} fallbackAnswer={turn?.answer} />
        ) : (
          <>
            {turn?.reasoning ? <ThinkingBlock content={turn.reasoning} /> : null}
            <ChatToolTimeline tools={tools} />
            {turn?.answer ? <MarkdownContent content={turn.answer} /> : null}
          </>
        )}
        {!hasPartialText ? <p className="text-brand-text-light">No assistant text was streamed before this turn stopped.</p> : null}
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

function MessageBubble({
  message,
  tools,
  steps,
  settledSteps,
}: {
  message: Message;
  tools: ToolTimelineItem[];
  steps: HistoricalActivityStep[];
  settledSteps: LiveActivityStep[];
}) {
  const isUser = message.role === "user";
  const hasStepAnswers = steps.some((step) => step.answer);

  return (
    <div data-message-id={message.id} className={isUser ? "flex min-w-0 justify-end" : "flex min-w-0 justify-start"}>
      <div
        className={
          isUser
            ? "min-w-0 max-w-2xl rounded-xl rounded-tr-sm bg-brand-button px-4 py-3 text-sm leading-6 text-white"
            : "min-w-0 w-full max-w-3xl text-sm leading-6 text-brand-text-dark"
        }
      >
        {isUser ? (
          <>
            {message.content ? <p className="whitespace-pre-wrap">{message.content}</p> : null}
            <AttachmentGrid attachments={message.attachments ?? []} />
          </>
        ) : (
          <>
            {message.partial || message.cancelled ? <StoppedIndicator reason={message.cancellationReason} /> : null}
            {steps.length > 0 ? (
              <AssistantActivityStream
                steps={steps.map((step) => ({
                  key: step.modelCallId,
                  reasoning: step.reasoning ?? "",
                  answer: step.answer ?? "",
                  tools: step.tools,
                }))}
                fallbackAnswer={hasStepAnswers ? "" : message.content}
              />
            ) : settledSteps.length > 0 ? (
              <AssistantActivityStream steps={settledSteps} fallbackAnswer={message.content} />
            ) : (
              <div className="space-y-4">
                {message.reasoning ? <ThinkingBlock content={message.reasoning} /> : null}
                <ChatToolTimeline tools={tools} />
                <MarkdownContent content={message.content} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type HistoricalActivityStep = ConversationActivityStep & { tools: ToolTimelineItem[] };

function ActivityStepView({
  reasoning,
  answer,
  tools,
  approvals,
  defaultOpen = false,
  onApprovalDecision,
}: {
  reasoning: string;
  answer: string;
  tools: ToolTimelineItem[];
  approvals?: PendingApproval[];
  defaultOpen?: boolean;
  onApprovalDecision?: (approvalId: string, decision: "approved" | "rejected") => void;
}) {
  if (!reasoning && !answer && tools.length === 0) {
    return null;
  }
  return (
    <div className="space-y-3">
      {reasoning ? <ThinkingBlock content={reasoning} defaultOpen={defaultOpen} /> : null}
      {answer ? <MarkdownContent content={answer} /> : null}
      <ChatToolTimeline tools={tools} approvals={approvals} onApprovalDecision={onApprovalDecision} />
    </div>
  );
}

function AssistantActivityStream({
  steps,
  fallbackAnswer,
}: {
  steps: Array<{ key: string; reasoning: string; answer: string; tools: ToolTimelineItem[] }>;
  fallbackAnswer?: string;
}) {
  const answer = steps
    .map((step) => step.answer.trim())
    .filter(Boolean)
    .join("\n\n") || fallbackAnswer || "";
  const hasWork = steps.some((step) => step.reasoning || step.tools.length > 0);
  return (
    <div className="space-y-4">
      {hasWork ? <AssistantWorkGroup steps={steps} /> : null}
      {answer ? <MarkdownContent content={answer} /> : null}
    </div>
  );
}

function AssistantWorkGroup({
  steps,
}: {
  steps: Array<{ key: string; reasoning: string; answer: string; tools: ToolTimelineItem[] }>;
}) {
  const tools = steps.flatMap((step) => step.tools);
  const hasActiveWork = tools.some((tool) => tool.phase === "streaming" || tool.status === "running" || tool.status === "awaiting_approval");
  const hasFailedWork = tools.some((tool) => tool.status === "failed" || tool.status === "rejected" || tool.status === "cancelled");
  const [isOpen, setIsOpen] = useState(hasActiveWork || hasFailedWork);
  const shouldShowDetails = isOpen || hasActiveWork;
  const summary = summarizeWorkGroup(steps);

  return (
    <div className="border-y border-gray-100 py-2">
      <button
        type="button"
        className="group flex w-full items-center gap-2 rounded-md py-1.5 text-left text-sm text-brand-text-light hover:text-brand-text-dark"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={shouldShowDetails}
      >
        <SquareTerminal className="size-4 shrink-0 text-brand-text-light" />
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <ChevronDown className={`size-4 shrink-0 transition-transform ${shouldShowDetails ? "rotate-180" : ""}`} />
      </button>
      {shouldShowDetails ? (
        <div className="space-y-3 pb-1 pt-2">
          {steps.map((step) => (
            <div key={step.key} className="space-y-2">
              {step.reasoning ? <ThinkingBlock content={step.reasoning} /> : null}
              <ChatToolTimeline tools={step.tools} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentGrid({ attachments }: { attachments: MessageAttachment[] }) {
  if (attachments.length === 0) {
    return null;
  }
  return (
    <div className="mt-2 grid grid-cols-2 gap-2">
      {attachments.map((attachment) => (
        <a
          key={attachment.id}
          href={attachmentUrl(attachment)}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-lg border border-white/30 bg-white/10"
        >
          <img src={attachmentUrl(attachment)} alt={attachment.fileName} className="max-h-56 w-full object-cover" />
        </a>
      ))}
    </div>
  );
}

const attachmentUrl = (attachment: MessageAttachment): string =>
  attachment.url?.startsWith("/api/") ? `${socratesApiBaseUrl()}${attachment.url}` : attachment.url ?? attachment.uri;

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

function groupActivityStepsByTurn(
  activitySteps: ConversationActivityStep[],
  toolRuns: ConversationToolRun[],
): Map<string, HistoricalActivityStep[]> {
  const toolsById = new Map(toolRuns.map((run) => [run.toolCallId, toolRunToTimelineItem(run)]));
  const grouped = new Map<string, HistoricalActivityStep[]>();
  for (const step of activitySteps) {
    const steps = grouped.get(step.turnId) ?? [];
    steps.push({
      ...step,
      tools: step.toolCallIds.map((id) => toolsById.get(id)).filter((tool): tool is ToolTimelineItem => Boolean(tool)),
    });
    grouped.set(
      step.turnId,
      steps.sort((left, right) => left.stepIndex - right.stepIndex),
    );
  }
  return grouped;
}

const approvalsForLiveStep = (
  step: LiveActivityStep,
  approvals: PendingApproval[],
  liveToolIds: Set<string>,
  isLastStep: boolean,
): PendingApproval[] => {
  const stepToolIds = new Set(step.tools.map((tool) => tool.toolCallId));
  return approvals.filter((approval) => {
    if (!approval.toolCallId) {
      return isLastStep;
    }
    if (stepToolIds.has(approval.toolCallId)) {
      return true;
    }
    return isLastStep && !liveToolIds.has(approval.toolCallId);
  });
};

function ThinkingBlock({ content, defaultOpen = false }: { content: string; defaultOpen?: boolean }) {
  return (
    <details className="group rounded-md bg-gray-50 px-3 py-2 text-sm text-brand-text-light" open={defaultOpen || undefined}>
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

const summarizeWorkGroup = (steps: Array<{ reasoning: string; tools: ToolTimelineItem[] }>): string => {
  const toolCount = steps.reduce((sum, step) => sum + step.tools.length, 0);
  return toolCount > 0 ? `Ran ${toolCount} ${toolCount === 1 ? "tool" : "tools"}` : "Ran tools";
};

const cssAttributeValue = (value: string): string => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

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
    <div className="mb-4 max-w-full overflow-hidden rounded-xl border border-gray-800 bg-gray-950 shadow-sm last:mb-0">
      <div className="flex min-w-0 items-center justify-between border-b border-white/10 bg-white/5 px-4 py-2">
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
      <pre className="max-h-[34rem] max-w-full overflow-auto p-4 font-mono text-[13px] leading-6 text-gray-100">
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
