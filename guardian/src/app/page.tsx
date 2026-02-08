"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useRef, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

type TextSegment = { type: "text"; content: string };
type ImageSegment = { type: "image"; src: string; complete: boolean };
type Segment = TextSegment | ImageSegment;

type ThinkingSegment = { kind: "thinking"; text: string };
type ContentSegment = { kind: "content"; text: string };
type DetailsSegment = { kind: "details"; text: string; streaming: boolean };
type StructuredSegment = ThinkingSegment | ContentSegment | DetailsSegment;

function ThinkingBlock({ text, isLast, isStreaming }: { text: string; isLast: boolean; isStreaming: boolean }) {
  const [open, setOpen] = useState(false);
  const isActive = isLast && isStreaming;

  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-md transition-colors w-full text-left ${
          isActive
            ? "bg-violet-500/10 border border-violet-500/20 text-violet-300"
            : "bg-white/5 border border-white/5 text-white/40 hover:bg-white/10"
        }`}
      >
        {isActive ? (
          <svg className="animate-spin h-3 w-3 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="currentColor">
            <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
          </svg>
        )}
        <span className="font-medium">{isActive ? "Thinking..." : "Thought"}</span>
        {!isActive && !open && <span className="truncate opacity-60">{text.slice(0, 80)}{text.length > 80 ? "…" : ""}</span>}
      </button>
      {(open || isActive) && (
        <div className={`mt-1 ml-5 px-3 py-2 rounded text-xs leading-relaxed border-l-2 ${
          isActive ? "border-violet-500/30 text-violet-200/70" : "border-white/10 text-white/40"
        }`}>
          {text}
        </div>
      )}
    </div>
  );
}

function DetailsBlock({ text, isStreaming }: { text: string; isStreaming: boolean }) {
  const [open, setOpen] = useState(false);
  const detailsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && isStreaming && detailsEndRef.current) {
      detailsEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [open, isStreaming, text]);

  return (
    <div className="mt-3">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs px-3 py-2 rounded-md bg-blue-500/10 border border-blue-500/20 text-blue-300 hover:bg-blue-500/20 transition-colors"
      >
        {isStreaming && !open ? (
          <svg className="animate-spin h-3 w-3 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        ) : (
          <svg className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="currentColor">
            <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
          </svg>
        )}
        <span className="font-medium">{open ? "Hide details" : "More details"}</span>
        {isStreaming && !open && <span className="text-blue-400/60 text-[10px] ml-1">streaming…</span>}
      </button>
      {open && (
        <div className="mt-2 px-3 py-3 rounded-md bg-white/[0.03] border border-white/5 text-sm overflow-x-auto markdown-body">
          <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{text}</ReactMarkdown>
          <div ref={detailsEndRef} />
        </div>
      )}
    </div>
  );
}

function parseStructuredContent(text: string, isStreamingMsg: boolean = false): StructuredSegment[] {
  const segments: StructuredSegment[] = [];
  const thinkingRegex = /<thinking>([\s\S]*?)<\/thinking>/g;
  const detailsRegex = /(?:```\s*)?<!-- DETAILS_START -->([\s\S]*?)<!-- DETAILS_END -->(?:\s*```)?/g;

  const thinkingBlocks: { index: number; length: number; text: string }[] = [];
  const detailsBlocks: { index: number; length: number; text: string; streaming: boolean }[] = [];

  let match;
  while ((match = thinkingRegex.exec(text)) !== null) {
    thinkingBlocks.push({ index: match.index, length: match[0].length, text: match[1].trim() });
  }
  while ((match = detailsRegex.exec(text)) !== null) {
    detailsBlocks.push({ index: match.index, length: match[0].length, text: match[1].trim(), streaming: false });
  }

  if (isStreamingMsg) {
    const openTag = "<!-- DETAILS_START -->";
    const allCompleteEnds = [...text.matchAll(/<!-- DETAILS_END -->/g)].map(m => m.index!);
    const lastOpenIdx = text.lastIndexOf(openTag);
    if (lastOpenIdx !== -1) {
      const hasMatchingClose = allCompleteEnds.some(endIdx => endIdx > lastOpenIdx);
      if (!hasMatchingClose) {
        const contentStart = lastOpenIdx + openTag.length;
        const partialText = text.slice(contentStart).replace(/^```\s*/, "").trim();
        detailsBlocks.push({ index: lastOpenIdx, length: text.length - lastOpenIdx, text: partialText, streaming: true });
      }
    }
  }

  const allBlocks = [
    ...thinkingBlocks.map(b => ({ ...b, kind: "thinking" as const, streaming: false })),
    ...detailsBlocks.map(b => ({ ...b, kind: "details" as const })),
  ].sort((a, b) => a.index - b.index);

  if (allBlocks.length === 0) {
    if (text.trim()) segments.push({ kind: "content", text });
    return segments;
  }

  let cursor = 0;
  for (const block of allBlocks) {
    if (block.index > cursor) {
      const content = text.slice(cursor, block.index).trim();
      if (content) segments.push({ kind: "content", text: content });
    }
    if (block.kind === "details") {
      segments.push({ kind: "details", text: block.text, streaming: block.streaming });
    } else {
      segments.push({ kind: block.kind, text: block.text });
    }
    cursor = block.index + block.length;
  }
  if (cursor < text.length) {
    const remaining = text.slice(cursor).trim();
    if (remaining) segments.push({ kind: "content", text: remaining });
  }

  return segments;
}

function ToolCallBlock({ toolName, input, output, isError }: { toolName: string; input?: Record<string, unknown>; output?: unknown; isError?: boolean }) {
  const [open, setOpen] = useState(false);

  const outputText = (() => {
    if (!output) return null;
    if (typeof output === "string") return output;
    const o = output as { content?: { type: string; text: string }[] };
    if (o.content && Array.isArray(o.content)) {
      return o.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    }
    return JSON.stringify(output, null, 2);
  })();

  return (
    <div className="my-2">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-md transition-colors w-full text-left ${
          isError
            ? "bg-red-500/5 border border-red-500/15 text-red-300/70 hover:bg-red-500/10"
            : "bg-white/5 border border-white/5 text-white/50 hover:bg-white/10"
        }`}
      >
        <svg className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} viewBox="0 0 24 24" fill="currentColor">
          <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6z" />
        </svg>
        <span className="text-amber-400/70">🔧 Tool:</span>
        <span className="font-medium">{toolName}</span>
        {isError ? (
          <span className="text-red-400/70">✗</span>
        ) : (
          <span className="text-emerald-400/70">✓</span>
        )}
        {!open && input && (
          <span className="truncate opacity-50 font-mono text-[10px] ml-1">
            {Object.entries(input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ").slice(0, 60)}
          </span>
        )}
      </button>
      {open && (
        <div className="mt-1 ml-5 space-y-2">
          {input && (
            <div className="px-3 py-2 rounded text-xs leading-relaxed border-l-2 border-amber-500/20">
              <span className="text-white/30 font-medium block mb-1">Input:</span>
              <pre className="text-amber-200/50 font-mono whitespace-pre-wrap break-all">{JSON.stringify(input, null, 2)}</pre>
            </div>
          )}
          {outputText && (
            <div className={`px-3 py-2 rounded text-xs leading-relaxed border-l-2 ${isError ? "border-red-500/20" : "border-emerald-500/20"}`}>
              <span className="text-white/30 font-medium block mb-1">Output{isError ? " (error)" : ""}:</span>
              <pre className={`font-mono whitespace-pre-wrap break-all ${isError ? "text-red-300/50" : "text-emerald-200/50"}`}>{outputText}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ToolCallProgress({ toolName }: { toolName: string }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const start = Date.now();
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const timeStr = minutes > 0
    ? `${minutes}m ${seconds.toString().padStart(2, "0")}s`
    : `${seconds}s`;

  const isStalled = elapsed >= 15;

  return (
    <div className={`my-2 px-3 py-2 rounded text-xs font-mono flex items-center gap-2 ${
      isStalled ? "bg-amber-500/10 border border-amber-500/20 text-amber-300/70" : "bg-white/5 text-white/50"
    }`}>
      <svg className="animate-spin h-3.5 w-3.5 text-amber-400/70 shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
      </svg>
      <span className="text-amber-400/70">🔧 Tool:</span>{" "}
      {toolName}
      {isStalled && <span className="text-amber-400/60 text-[10px]">slow response…</span>}
      <span className={`ml-auto tabular-nums ${isStalled ? "text-amber-400/50" : "text-white/30"}`}>{timeStr}</span>
    </div>
  );
}

function parseTextWithImages(text: string, isStreaming: boolean): Segment[] {
  const regex = /(data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]*)/g;
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    const src = match[1];
    const isLast = regex.lastIndex >= text.length || text.slice(regex.lastIndex).trim() === "";
    const complete = !(isStreaming && isLast);
    segments.push({ type: "image", src, complete });
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    segments.push({ type: "text", content: text.slice(lastIndex) });
  }

  return segments;
}

export default function Home() {
  const [figmaMcpUrl, setFigmaMcpUrl] = useState("http://127.0.0.1:3845/mcp");
  const [figmaAccessToken, setFigmaAccessToken] = useState("");
  const [codeProjectPath, setCodeProjectPath] = useState("http://127.0.0.1:64342/sse");//"http://[::1]:3846/sse");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [figmaOAuth, setFigmaOAuth] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScroll = useRef(true);

  const figmaMcpUrlRef = useRef(figmaMcpUrl);
  figmaMcpUrlRef.current = figmaMcpUrl;
  const figmaAccessTokenRef = useRef(figmaAccessToken);
  figmaAccessTokenRef.current = figmaAccessToken;
  const codeProjectPathRef = useRef(codeProjectPath);
  codeProjectPathRef.current = codeProjectPath;
  const figmaOAuthRef = useRef(figmaOAuth);
  figmaOAuthRef.current = figmaOAuth;

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: () => ({ figmaMcpUrl: figmaOAuthRef.current ? "https://mcp.figma.com/mcp" : figmaMcpUrlRef.current, figmaAccessToken: figmaAccessTokenRef.current, codeProjectPath: codeProjectPathRef.current, figmaOAuth: figmaOAuthRef.current }),
      }),
    [],
  );

  const { messages, sendMessage, status, error } = useChat({ transport });

  const isLoading = status === "submitted" || status === "streaming";

  const handleScroll = () => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const threshold = 40;
    shouldAutoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  useEffect(() => {
    fetch("/api/auth/figma/status")
      .then((r) => r.json())
      .then((d) => setFigmaOAuth(d.connected))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (shouldAutoScroll.current) {
      const el = scrollContainerRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [messages]);

  useEffect(() => {
    if (!isLoading) {
      inputRef.current?.focus();
    }
  }, [isLoading]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    shouldAutoScroll.current = true;
    sendMessage({ text: input });
    setInput("");
  };

  const figmaConnected = figmaOAuth || figmaAccessToken.trim().length > 0 || figmaMcpUrl.trim().length > 0;
  const codeConnected = codeProjectPath.trim().length > 0;

  return (
    <div className="relative flex h-screen bg-[#0a0a0a] text-white overflow-hidden">
      <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
        <div className="wave-bg-layer wave-bg-1" />
        <div className="wave-bg-layer wave-bg-2" />
        <div className="wave-bg-layer wave-bg-3" />
      </div>
      {settingsOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 md:hidden"
          onClick={() => setSettingsOpen(false)}
        />
      )}
      <div
        className={`${settingsOpen ? "w-80 translate-x-0" : "w-0 -translate-x-full md:translate-x-0"} fixed md:relative z-50 md:z-auto h-full transition-all duration-200 overflow-hidden glass-sidebar`}
      >
        <div className="p-4 w-80">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">
            MCP Connections
          </h2>

          <div className="space-y-4">
            <div>
              <label className="block text-xs text-white/50 mb-1">
                Figma MCP URL
              </label>
              <input
                type="url"
                value={figmaMcpUrl}
                onChange={(e) => setFigmaMcpUrl(e.target.value)}
                placeholder="http://127.0.0.1:3845/mcp"
                className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
              />
              <div className="flex items-center gap-1.5 mt-1.5">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${figmaConnected ? "bg-emerald-400" : "bg-white/20"}`}
                />
                <span className="text-xs text-white/40">
                  {figmaConnected ? "URL configured" : "Not configured"}
                </span>
              </div>
            </div>

            <div>
              <label className="block text-xs text-white/50 mb-1">
                Figma Authentication
              </label>
              {figmaOAuth ? (
                <div className="flex items-center gap-2">
                  <div className="flex-1 flex items-center gap-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-md px-3 py-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    <span className="text-xs text-emerald-300">Connected via OAuth</span>
                  </div>
                  <button
                    onClick={() => {
                      fetch("/api/auth/figma/status", { method: "DELETE" }).then(() => setFigmaOAuth(false));
                    }}
                    className="px-2 py-2 text-xs text-red-400 hover:bg-red-500/10 rounded-md transition-colors"
                  >
                    Disconnect
                  </button>
                </div>
              ) : (
                <a
                  href="/api/auth/figma"
                  className="block w-full text-center bg-[#a259ff]/20 border border-[#a259ff]/30 hover:bg-[#a259ff]/30 rounded-md px-3 py-2 text-sm text-[#a259ff] transition-colors"
                >
                  Sign in with Figma
                </a>
              )}
            </div>

            <div>
              <label className="block text-xs text-white/50 mb-1">
                Figma Access Token (legacy)
              </label>
              <input
                type="password"
                value={figmaAccessToken}
                onChange={(e) => setFigmaAccessToken(e.target.value)}
                placeholder="figd_..."
                className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
              />
              <span className="text-xs text-white/30 mt-1 block">
                Fallback if OAuth not used. Also reads FIGMA_ACCESS_TOKEN from .env.local
              </span>
            </div>

            <div>
              <label className="block text-xs text-white/50 mb-1">
                Code Editor MCP Url
              </label>
              <input
                type="text"
                value={codeProjectPath}
                onChange={(e) => setCodeProjectPath(e.target.value)}
                placeholder="http://127.0.0.1:64342/sse"
                className="w-full bg-white/5 border border-white/10 rounded-md px-3 py-2 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
              />
              <div className="flex items-center gap-1.5 mt-1.5">
                <div
                  className={`w-1.5 h-1.5 rounded-full ${codeConnected ? "bg-emerald-400" : "bg-white/20"}`}
                />
                <span className="text-xs text-white/40">
                  {codeConnected ? "Path configured" : "Not configured"}
                </span>
              </div>
            </div>
          </div>

          <div className="mt-6 p-3 bg-white/5 rounded-md">
            <p className="text-xs text-white/40 leading-relaxed">
              Paste your Figma MCP SSE/HTTP URL and set the Code MCP SSE/HTTP URL for the code
              project you want to inspect.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0 relative z-10">
        <header className="flex items-center justify-between px-3 sm:px-4 py-3 glass-header">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              onClick={() => setSettingsOpen(!settingsOpen)}
              className="p-2 rounded-md hover:bg-white/5 transition-colors shrink-0"
              title="Toggle settings"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold truncate">DS AI Guardian</h1>
              <p className="text-xs text-white/40 hidden sm:block">
                [Figma ↔ Code] Design System drift detector
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            <div
              className={`w-2 h-2 rounded-full ${figmaConnected ? "bg-emerald-400" : "bg-white/20"}`}
              title={`Figma MCP: ${figmaConnected ? "configured" : "not configured"}`}
            />
            <span className="text-xs text-white/30 hidden sm:inline">Figma</span>
            <div
              className={`w-2 h-2 rounded-full ml-1 sm:ml-2 ${codeConnected ? "bg-emerald-400" : "bg-white/20"}`}
              title={`Code MCP: ${codeConnected ? "configured" : "not configured"}`}
            />
            <span className="text-xs text-white/30 hidden sm:inline">Code</span>
          </div>
        </header>

        <div ref={scrollContainerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 sm:py-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center px-4">
              <div className="text-4xl mb-4">🛡️</div>
              <h2 className="text-lg font-semibold mb-2">
                Welcome to DS AI Guardian
              </h2>
              <p className="text-sm text-white/40 max-w-md mb-6">
                I can compare your Figma design system components with their
                code implementation to detect property and variant drift.
              </p>
              <div className="space-y-2 text-sm text-white/30">
                <p>Try asking:</p>
                <button
                  onClick={() => sendMessage({ text: "Check the Button component" })}
                  className="block mx-auto px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 transition-colors"
                >
                  &quot;Check the Button component&quot;
                </button>
                <button
                  onClick={() => sendMessage({ text: "List all components available in Figma" })}
                  className="block mx-auto px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 transition-colors"
                >
                  &quot;List all components available in Figma&quot;
                </button>
              </div>
            </div>
          )}

          {messages.map((m) => (
            <div
              key={m.id}
              className={`mb-4 ${m.role === "user" ? "flex justify-end" : ""}`}
            >
              <div
                className={`max-w-full sm:max-w-[80%] rounded-lg px-3 sm:px-4 py-2.5 sm:py-3 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "glass-msg-user"
                    : "glass-msg-ai"
                }`}
              >
                {m.parts?.map((part, i) => {
                  if (part.type === "text") {
                    const isLastMsg = m === messages[messages.length - 1];
                    const structuredSegments = parseStructuredContent(part.text, isLoading && isLastMsg);

                    return (
                      <div key={i}>
                        {structuredSegments.map((structSeg, sj) => {
                          if (structSeg.kind === "thinking") {
                            return <ThinkingBlock key={sj} text={structSeg.text} isLast={isLastMsg} isStreaming={isLoading} />;
                          }
                          if (structSeg.kind === "details") {
                            return <DetailsBlock key={sj} text={structSeg.text} isStreaming={structSeg.streaming} />;
                          }
                          
                          // content kind
                          const imageSegments = parseTextWithImages(structSeg.text, isLoading && isLastMsg);
                          return (
                            <div key={sj} className="markdown-body overflow-x-auto">
                              {imageSegments.map((seg, j) => {
                                if (seg.type === "image") {
                                  if (!seg.complete) {
                                    return (
                                      <div key={j} className="my-3 flex flex-col items-center justify-center w-full max-w-64 h-48 bg-white/5 border border-white/10 rounded-lg">
                                        <svg className="animate-spin h-8 w-8 text-white/30 mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                                        </svg>
                                        <span className="text-xs text-white/30">Loading image…</span>
                                      </div>
                                    );
                                  }
                                  return (
                                    <img
                                      key={j}
                                      src={seg.src}
                                      alt="Generated image"
                                      className="my-3 max-w-full rounded-lg border border-white/10"
                                    />
                                  );
                                }
                                return (
                                  <ReactMarkdown key={j} remarkPlugins={[remarkGfm, remarkBreaks]}>
                                    {seg.content}
                                  </ReactMarkdown>
                                );
                              })}
                            </div>
                          );
                        })}
                      </div>
                    );
                  }
                  if (part.type === "dynamic-tool") {
                    const p = part as { type: string; toolName: string; state: string; input?: Record<string, unknown>; output?: { content?: { type: string; text: string }[]; structuredContent?: unknown; isError?: boolean } };
                    if (p.state === "output-available") {
                      return (
                        <ToolCallBlock
                          key={i}
                          toolName={p.toolName}
                          input={p.input}
                          output={p.output}
                          isError={p.output?.isError}
                        />
                      );
                    }
                    return <ToolCallProgress key={i} toolName={p.toolName} />;
                  }
                  return null;
                })}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="mb-4">
              <div className="max-w-full sm:max-w-[80%] rounded-lg px-3 sm:px-4 py-3 glass-msg-ai">
                <div className="flex items-center gap-2 text-sm text-white/40">
                  <div className="animate-pulse">●</div>
                  Thinking...
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400 break-words">
              Error: {error.message}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <form
          onSubmit={onSubmit}
          className="px-3 sm:px-4 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] glass-input-bar"
        >
          <div className="flex gap-2">
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Guardian to check a component..."
              className={`flex-1 min-w-0 bg-white/5 border border-white/10 rounded-lg px-3 sm:px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30 ${isLoading ? "opacity-50" : ""}`}
              readOnly={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="px-3 sm:px-4 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-white/5 disabled:text-white/20 rounded-lg text-sm font-medium transition-colors shrink-0"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}