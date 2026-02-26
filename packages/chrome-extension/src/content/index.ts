import { GuardianWidget } from "../widget/GuardianWidget";

const HOST_ID = "guardian-widget-host";

function init(): void {
  // Avoid double-injection (e.g. on SPA route changes that re-fire DOMContentLoaded)
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement("div");
  host.id = HOST_ID;
  // Remove all default styling so the host is invisible as a layout element
  host.style.cssText =
    "all:unset;display:block;position:fixed;z-index:2147483647;pointer-events:none;";

  document.body.appendChild(host);

  // Transfer pointer events to the inner Shadow DOM wrapper
  host.style.pointerEvents = "none";
  new GuardianWidget(host);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
