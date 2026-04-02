"use client";

import { useState, useEffect } from "react";

type VersionInfo = { version: string; date: string; filename: string };

export default function InstallPage() {
  const [version, setVersion] = useState<VersionInfo | null>(null);

  useEffect(() => {
    fetch("/plugin/version.json")
      .then((r) => r.json())
      .then(setVersion)
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-bold text-white mb-2">
        Install Guardian Plugin
      </h1>
      <p className="text-white/50 mb-10">
        Private beta &mdash; Figma Desktop only
      </p>

      {/* Download */}
      <div className="rounded-xl border border-white/10 bg-white/5 backdrop-blur-lg p-6 mb-10">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-white">
              Guardian Desktop Plugin Beta
            </h2>
            {version && (
              <p className="text-sm text-white/40 mt-1">
                v{version.version} &middot; {version.date}
              </p>
            )}
          </div>
          <a
            href="/api/figma-plugin/download"
            className="rounded-lg bg-blue-600 hover:bg-blue-500 px-5 py-2.5 text-sm font-medium text-white transition-colors"
          >
            Download .zip
          </a>
        </div>
      </div>

      {/* Steps */}
      <h2 className="text-xl font-semibold text-white mb-6">
        Installation steps
      </h2>
      <ol className="space-y-6 text-white/80">
        <Step n={1} title="Download and unzip">
          Click the button above to download the zip. Extract it to a folder on
          your computer (e.g.{" "}
          <code className="text-xs bg-white/10 rounded px-1.5 py-0.5">
            ~/Documents/guardian-plugin/
          </code>
          ).
        </Step>

        <Step n={2} title="Open Figma Desktop">
          The plugin requires <strong>Figma Desktop</strong> (not the browser).
          Make sure you have it installed.
        </Step>

        <Step n={3} title="Import the plugin">
          In Figma Desktop, go to{" "}
          <strong>
            Menu &rarr; Plugins &rarr; Development &rarr; Import plugin from
            manifest&hellip;
          </strong>{" "}
          and select the{" "}
          <code className="text-xs bg-white/10 rounded px-1.5 py-0.5">
            manifest.json
          </code>{" "}
          file from the unzipped folder.
        </Step>

        <Step n={4} title="Run the plugin">
          Open any Figma file, then go to{" "}
          <strong>
            Plugins &rarr; Development &rarr; Guardian Desktop Plugin Beta
          </strong>
          . The plugin will load and connect to Guardian.
        </Step>

        <Step n={5} title="Log in">
          If you don&apos;t have a Guardian account yet,{" "}
          <a href="/signup" className="text-blue-400 underline">
            sign up here
          </a>
          . Then log in from the plugin.
        </Step>
      </ol>

      {/* Notes */}
      <div className="mt-12 rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-5 text-sm text-yellow-200/80">
        <strong className="text-yellow-200">Note:</strong> This is a development
        plugin. It appears under &ldquo;Development&rdquo; in the Plugins menu,
        not in the regular plugin list. This is normal for the beta.
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex gap-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-blue-600/20 text-sm font-bold text-blue-400">
        {n}
      </span>
      <div>
        <p className="font-semibold text-white">{title}</p>
        <p className="mt-1 text-sm leading-relaxed">{children}</p>
      </div>
    </li>
  );
}
