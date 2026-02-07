"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { useState, useRef, useEffect, useMemo } from "react";

export default function Home() {
  const [figmaMcpUrl, setFigmaMcpUrl] = useState("http://127.0.0.1:3845/sse");
  const [codeProjectPath, setCodeProjectPath] = useState("http://[::1]:3846/sse");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [input, setInput] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "/api/chat",
        body: { figmaMcpUrl, codeProjectPath },
      }),
    [figmaMcpUrl, codeProjectPath],
  );

  const { messages, sendMessage, status, error } = useChat({ transport });

  const isLoading = status === "submitted" || status === "streaming";

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    sendMessage({ text: input });
    setInput("");
  };

  const figmaConnected = figmaMcpUrl.trim().length > 0;
  const codeConnected = codeProjectPath.trim().length > 0;

  return (
    <div className="flex h-screen bg-[#0a0a0a] text-white">
      <div
        className={`${settingsOpen ? "w-80" : "w-0"} transition-all duration-200 overflow-hidden border-r border-white/10 bg-[#111]`}
      >
        <div className="p-4 w-80">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider mb-4">
            MCP Connections
          </h2>

          <div className="space-y-4">
            <div>
              <label className="block text-xs text-white/50 mb-1">
                Figma MCP (SSE URL)
              </label>
              <input
                type="url"
                value={figmaMcpUrl}
                onChange={(e) => setFigmaMcpUrl(e.target.value)}
                placeholder="http://localhost:3333/sse"
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
                Code Project Path (local)
              </label>
              <input
                type="text"
                value={codeProjectPath}
                onChange={(e) => setCodeProjectPath(e.target.value)}
                placeholder="/Users/you/projects/my-design-system"
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
              Paste your Figma MCP SSE URL and set the local path to the code
              project you want to inspect. Guardian will spawn a filesystem MCP
              server automatically.
            </p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <header className="flex items-center justify-between px-4 py-3 border-b border-white/10">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setSettingsOpen(!settingsOpen)}
              className="p-2 rounded-md hover:bg-white/5 transition-colors"
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
            <div>
              <h1 className="text-sm font-semibold">DS AI Guardian</h1>
              <p className="text-xs text-white/40">
                Figma ↔ Code drift detector
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div
              className={`w-2 h-2 rounded-full ${figmaConnected ? "bg-emerald-400" : "bg-white/20"}`}
              title={`Figma MCP: ${figmaConnected ? "configured" : "not configured"}`}
            />
            <span className="text-xs text-white/30">Figma</span>
            <div
              className={`w-2 h-2 rounded-full ml-2 ${codeConnected ? "bg-emerald-400" : "bg-white/20"}`}
              title={`Code MCP: ${codeConnected ? "configured" : "not configured"}`}
            />
            <span className="text-xs text-white/30">Code</span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-6">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
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
                  "Check the Button component"
                </button>
                <button
                  onClick={() => sendMessage({ text: "List all components available in Figma" })}
                  className="block mx-auto px-3 py-1.5 rounded-md bg-white/5 hover:bg-white/10 transition-colors"
                >
                  "List all components available in Figma"
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
                className={`max-w-[80%] rounded-lg px-4 py-3 text-sm leading-relaxed ${
                  m.role === "user"
                    ? "bg-blue-600/20 border border-blue-500/20"
                    : "bg-white/5 border border-white/5"
                }`}
              >
                {m.parts?.map((part, i) => {
                  if (part.type === "text") {
                    return (
                      <div key={i} className="whitespace-pre-wrap">
                        {part.text}
                      </div>
                    );
                  }
                  if (part.type === "dynamic-tool") {
                    return (
                      <div
                        key={i}
                        className="my-2 px-3 py-2 bg-white/5 rounded text-xs font-mono text-white/50"
                      >
                        <span className="text-amber-400/70">🔧 Tool:</span>{" "}
                        {part.toolName}
                        {part.state === "output-available" && (
                          <span className="text-emerald-400/70"> ✓</span>
                        )}
                      </div>
                    );
                  }
                  return null;
                })}
              </div>
            </div>
          ))}

          {isLoading && (
            <div className="mb-4">
              <div className="max-w-[80%] rounded-lg px-4 py-3 bg-white/5 border border-white/5">
                <div className="flex items-center gap-2 text-sm text-white/40">
                  <div className="animate-pulse">●</div>
                  Thinking...
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
              Error: {error.message}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        <form
          onSubmit={onSubmit}
          className="px-4 py-3 border-t border-white/10"
        >
          <div className="flex gap-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask Guardian to check a component..."
              className="flex-1 bg-white/5 border border-white/10 rounded-lg px-4 py-3 text-sm text-white placeholder:text-white/20 focus:outline-none focus:border-white/30"
              disabled={isLoading}
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="px-4 py-3 bg-blue-600 hover:bg-blue-500 disabled:bg-white/5 disabled:text-white/20 rounded-lg text-sm font-medium transition-colors"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}