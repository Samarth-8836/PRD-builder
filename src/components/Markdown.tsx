"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface MarkdownProps {
  children: string;
}

export function Markdown({ children }: MarkdownProps) {
  return (
    <div className="markdown-body text-sm leading-relaxed text-neutral-200">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 mt-5 text-xl font-semibold text-neutral-100">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="mb-2 mt-5 border-b border-neutral-800 pb-1 text-base font-semibold uppercase tracking-wider text-neutral-300">
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 mt-4 text-sm font-semibold text-neutral-200">{children}</h3>
          ),
          p: ({ children }) => <p className="mb-3 text-neutral-200">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-3 list-disc space-y-1 pl-5 text-neutral-200">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-decimal space-y-1 pl-5 text-neutral-200">{children}</ol>
          ),
          li: ({ children }) => <li className="text-neutral-200">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-neutral-100">{children}</strong>
          ),
          em: ({ children }) => <em className="italic text-neutral-300">{children}</em>,
          code: ({ children }) => (
            <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-xs text-neutral-100">
              {children}
            </code>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              className="text-blue-400 underline hover:text-blue-300"
              target="_blank"
              rel="noreferrer"
            >
              {children}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
