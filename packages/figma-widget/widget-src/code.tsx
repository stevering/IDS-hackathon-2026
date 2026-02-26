/// <reference types="@figma/widget-typings" />

const { widget } = figma;
const { AutoLayout, SVG, Text } = widget;

// Shield_v2.svg inline — le personnage Guardian
const SHIELD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128">
  <path d="M 81 34 A 42 42 0 1 0 81 94"
        fill="none" stroke="#6D28D9" stroke-width="19" stroke-linecap="round"/>
  <path d="M 72 80 L 93 80"
        fill="none" stroke="#6D28D9" stroke-width="15" stroke-linecap="round"/>
  <path d="M 76 37 A 37 37 0 1 0 76 91"
        fill="none" stroke="#A78BFA" stroke-width="5" stroke-linecap="round" opacity="0.45"/>
  <ellipse cx="21" cy="27" rx="10" ry="13" fill="#6D28D9"/>
  <ellipse cx="21" cy="28" rx="6" ry="8" fill="#DDD6FE" opacity="0.75"/>
  <path d="M 31 44 Q 40 40 49 43"
        fill="none" stroke="#4C1D95" stroke-width="2.5" stroke-linecap="round"/>
  <path d="M 55 43 Q 64 40 73 44"
        fill="none" stroke="#4C1D95" stroke-width="2.5" stroke-linecap="round"/>
  <ellipse cx="40" cy="52" rx="8" ry="9" fill="white"/>
  <ellipse cx="64" cy="52" rx="8" ry="9" fill="white"/>
  <ellipse cx="40" cy="53.5" rx="5.5" ry="6.5" fill="#2E1065"/>
  <ellipse cx="64" cy="53.5" rx="5.5" ry="6.5" fill="#2E1065"/>
  <circle cx="42" cy="51" r="2.2" fill="white"/>
  <circle cx="66" cy="51" r="2.2" fill="white"/>
  <circle cx="38.5" cy="55" r="1" fill="white" opacity="0.6"/>
  <circle cx="62.5" cy="55" r="1" fill="white" opacity="0.6"/>
  <path d="M 32 64 Q 52 78 72 64"
        fill="none" stroke="#4C1D95" stroke-width="3.5" stroke-linecap="round"/>
  <ellipse cx="29" cy="63" rx="8" ry="4.5" fill="#C4B5FD" opacity="0.55"/>
  <ellipse cx="75" cy="63" rx="8" ry="4.5" fill="#C4B5FD" opacity="0.55"/>
  <path d="M 87 73 L 88.3 77.7 L 93 79 L 88.3 80.3 L 87 85 L 85.7 80.3 L 81 79 L 85.7 77.7 Z"
        fill="white" opacity="0.92"/>
  <ellipse cx="14" cy="67" rx="6" ry="9" fill="#6D28D9" transform="rotate(-25 14 67)"/>
  <ellipse cx="90" cy="97" rx="6" ry="9" fill="#6D28D9" transform="rotate(15 90 97)"/>
</svg>`;

function GuardianWidget() {
  return (
    <AutoLayout
      name="Guardian"
      direction="vertical"
      horizontalAlignItems="center"
      verticalAlignItems="center"
      padding={{ top: 16, bottom: 12, left: 20, right: 20 }}
      spacing={6}
      cornerRadius={20}
      fill="#F5F3FF"
      stroke="#DDD6FE"
      strokeWidth={2}
      // Clic → ouvre l'UI du plugin Guardian (même ui.html, même manifest)
      // __html__ dans le manifest combiné = packages/figma-plugin/ui.html
      // figma.openPlugin() n'existe pas en contexte widget — on passe par showUI directement
      onClick={() =>
        new Promise<void>((resolve) => {
          figma.showUI(__html__, { width: 400, height: 800, title: 'Guardian' });
          figma.ui.onmessage = (msg: { type?: string }) => {
            if (msg?.type === 'close' || msg?.type === 'CLOSE') {
              figma.closePlugin();
              resolve();
            }
          };
        })
      }
    >
      {/* Mascotte Guardian */}
      <SVG src={SHIELD_SVG} width={80} height={80} />

      {/* Label */}
      <Text
        fontSize={13}
        fontWeight="bold"
        fill="#4C1D95"
        fontFamily="Inter"
        letterSpacing={0.5}
      >
        Guardian
      </Text>

      {/* Hint */}
      <AutoLayout
        direction="horizontal"
        horizontalAlignItems="center"
        verticalAlignItems="center"
        spacing={4}
        padding={{ top: 3, bottom: 3, left: 10, right: 10 }}
        cornerRadius={10}
        fill={{ r: 1, g: 1, b: 1, a: 0.65 }}
      >
        <Text fontSize={8} fill="#A78BFA" fontFamily="Inter">
          ○ tap to open
        </Text>
      </AutoLayout>
    </AutoLayout>
  );
}

// try-catch : widget.register est no-op en mode plugin mais peut lever
// une exception dans certaines versions du runtime Figma
try {
  widget.register(GuardianWidget);
} catch (_) { /* mode plugin — registration ignorée */ }
