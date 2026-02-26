/**
 * Background service worker (Manifest V3).
 * Handles extension lifecycle events.
 * Future: MCP server communication will be wired here.
 */

chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[Guardian] Extension installed — reason: ${details.reason}`);
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[Guardian] Browser started");
});

export {};
