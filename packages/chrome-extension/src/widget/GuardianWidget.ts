import { GUARDIAN_SVG } from "./svg";
import { getWidgetStyles } from "./styles";

/**
 * GuardianWidget — a floating, animated mascot injected via Shadow DOM.
 *
 * The Shadow DOM isolates all styles from the host page, making the widget
 * safe to inject into any site (including Figma web).
 */
export class GuardianWidget {
  private readonly shadow: ShadowRoot;
  private readonly wrapper: HTMLDivElement;
  private isMinimized = false;

  constructor(host: HTMLElement) {
    this.shadow = host.attachShadow({ mode: "closed" });
    this.wrapper = this.createWrapper();
    this.mount();
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private createWrapper(): HTMLDivElement {
    const wrapper = document.createElement("div");
    wrapper.className = "wrapper";
    wrapper.setAttribute("role", "button");
    wrapper.setAttribute("aria-label", "DS AI Guardian — click to toggle");
    wrapper.setAttribute("tabindex", "0");
    wrapper.setAttribute("title", "DS AI Guardian");

    const mascot = document.createElement("div");
    mascot.className = "mascot";
    mascot.innerHTML = GUARDIAN_SVG;
    wrapper.appendChild(mascot);

    return wrapper;
  }

  private mount(): void {
    const style = document.createElement("style");
    style.textContent = getWidgetStyles();

    this.wrapper.addEventListener("click", this.handleClick);
    this.wrapper.addEventListener("keydown", this.handleKeyDown);

    this.shadow.appendChild(style);
    this.shadow.appendChild(this.wrapper);
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  private readonly handleClick = (): void => {
    this.isMinimized = !this.isMinimized;
    this.wrapper.classList.toggle("minimized", this.isMinimized);
    this.wrapper.setAttribute(
      "aria-label",
      this.isMinimized
        ? "DS AI Guardian (minimized) — click to expand"
        : "DS AI Guardian — click to minimize"
    );
  };

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      this.handleClick();
    }
  };

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Programmatically remove the widget from the DOM. */
  destroy(): void {
    this.wrapper.removeEventListener("click", this.handleClick);
    this.wrapper.removeEventListener("keydown", this.handleKeyDown);
    this.shadow.host.remove();
  }
}
