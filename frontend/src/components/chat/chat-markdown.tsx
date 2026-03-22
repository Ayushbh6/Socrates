"use client";

import { useMemo, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { cn } from "@/lib/utils";

type ChatMarkdownProps = {
  content: string;
};

function parseCodeMeta(meta: string) {
  const normalized = meta.trim();
  if (!normalized) {
    return { title: null as string | null };
  }

  const quotedTitle = normalized.match(/title=(?:"([^"]+)"|'([^']+)')/);
  if (quotedTitle) {
    return { title: quotedTitle[1] ?? quotedTitle[2] ?? null };
  }

  const bareTitle = normalized.split(/\s+/)[0];
  return { title: bareTitle || null };
}

function CodeBlock({
  children,
  className,
  node,
}: {
  children?: React.ReactNode;
  className?: string;
  node?: {
    data?: {
      meta?: string;
    };
  };
}) {
  const [copied, setCopied] = useState(false);
  const rawCode = String(children ?? "").replace(/\n$/, "");
  const language = className?.match(/language-([\w-]+)/)?.[1] ?? "text";
  const title = parseCodeMeta(node?.data?.meta ?? "").title;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(rawCode);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="my-5 overflow-hidden rounded-2xl border border-white/8 bg-[#0d131d] shadow-[0_18px_44px_rgba(0,0,0,0.28)]">
      <div className="flex items-center justify-between gap-3 border-b border-white/6 bg-white/[0.04] px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="font-label text-[10px] uppercase tracking-[0.18em] text-[#8acfe1]">
            {language}
          </span>
          {title ? (
            <span className="truncate text-xs text-[#a8b8ce]">{title}</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={() => {
            void handleCopy();
          }}
          className="inline-flex items-center gap-1.5 rounded-full border border-white/8 bg-white/[0.03] px-2.5 py-1 text-[11px] text-[#cfe6ff] transition-colors hover:bg-white/[0.08]"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="overflow-x-auto">
        <SyntaxHighlighter
          language={language}
          style={oneDark}
          customStyle={{
            background: "transparent",
            fontSize: "0.84rem",
            lineHeight: "1.7",
            margin: 0,
            padding: "1rem 1.1rem",
          }}
          codeTagProps={{
            style: {
              fontFamily:
                "'SFMono-Regular', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
            },
          }}
          wrapLongLines={false}
        >
          {rawCode}
        </SyntaxHighlighter>
      </div>
    </div>
  );
}

export function ChatMarkdown({ content }: ChatMarkdownProps) {
  const components = useMemo<Components>(
    () => ({
      h1: ({ children }) => (
        <h1 className="mt-7 mb-3 text-[1.55rem] font-semibold tracking-tight text-white first:mt-0">
          {children}
        </h1>
      ),
      h2: ({ children }) => (
        <h2 className="mt-6 mb-3 text-[1.22rem] font-semibold tracking-tight text-[#f6fbff] first:mt-0">
          {children}
        </h2>
      ),
      h3: ({ children }) => (
        <h3 className="mt-5 mb-2 text-base font-semibold tracking-tight text-[#eef5ff] first:mt-0">
          {children}
        </h3>
      ),
      p: ({ children }) => (
        <p className="my-3 text-sm leading-7 tracking-[0.01em] text-[#e7eef9] first:mt-0 last:mb-0 sm:text-[15px]">
          {children}
        </p>
      ),
      strong: ({ children }) => (
        <strong className="font-semibold text-white">{children}</strong>
      ),
      em: ({ children }) => (
        <em className="text-[#dce8f7] italic">{children}</em>
      ),
      ul: ({ children }) => (
        <ul className="my-3 list-disc space-y-2 pl-6 text-sm leading-7 text-[#e7eef9] sm:text-[15px]">
          {children}
        </ul>
      ),
      ol: ({ children }) => (
        <ol className="my-3 list-decimal space-y-2 pl-6 text-sm leading-7 text-[#e7eef9] sm:text-[15px]">
          {children}
        </ol>
      ),
      li: ({ children }) => <li className="pl-1">{children}</li>,
      blockquote: ({ children }) => (
        <blockquote className="my-5 border-l-2 border-[#83dff2]/55 bg-[#83dff2]/[0.06] px-4 py-3 text-sm leading-7 text-[#d5e6f7] italic">
          {children}
        </blockquote>
      ),
      a: ({ children, href }) => (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-[#83dff2] underline decoration-[#83dff2]/45 underline-offset-4 transition-colors hover:text-[#b8f1ff]"
        >
          <span>{children}</span>
          <ExternalLink className="size-3.5" />
        </a>
      ),
      hr: () => <hr className="my-6 border-white/8" />,
      table: ({ children }) => (
        <div className="my-5 overflow-x-auto rounded-2xl border border-white/8 bg-black/10">
          <table className="min-w-full border-collapse text-left text-sm text-[#e7eef9]">
            {children}
          </table>
        </div>
      ),
      thead: ({ children }) => (
        <thead className="bg-white/[0.04] text-[11px] uppercase tracking-[0.14em] text-[#8acfe1]">
          {children}
        </thead>
      ),
      th: ({ children }) => (
        <th className="border-b border-white/8 px-4 py-3 font-medium">{children}</th>
      ),
      td: ({ children }) => (
        <td className="border-b border-white/[0.05] px-4 py-3 align-top last:border-b-0">
          {children}
        </td>
      ),
      code: ({ children, className, node, ...props }) => {
        const isInline = !className;
        if (isInline) {
          return (
            <code
              {...props}
              className={cn(
                "rounded-md border border-white/8 bg-white/[0.06] px-1.5 py-0.5 font-mono text-[0.82em] text-[#b7f0ff]",
                className
              )}
            >
              {children}
            </code>
          );
        }

        return (
          <CodeBlock className={className} node={node as never}>
            {children}
          </CodeBlock>
        );
      },
    }),
    []
  );

  return (
    <div className="prose prose-invert max-w-none">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
