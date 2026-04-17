export function fixUnpairedMarkdown(text: string): string {
  let result = text;

  const withoutCodeBlocks = result.replace(/```[\s\S]*?```/g, "");
  const backtickCount = (withoutCodeBlocks.match(/`/g) || []).length;
  if (backtickCount % 2 !== 0) {
    result += "`";
  }

  const withoutCode = result.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "");
  const boldCount = (withoutCode.match(/\*\*/g) || []).length;
  if (boldCount % 2 !== 0) {
    result += "**";
  }

  return result;
}

export function cleanOrphanedTags(text: string): string {
  let cleaned = text;

  const detailsOpens = [...cleaned.matchAll(/<!-- DETAILS_START -->/g)];
  const detailsCloses = [...cleaned.matchAll(/<!-- DETAILS_END -->/g)].map(m => m.index!);

  for (const match of detailsOpens) {
    const openIdx = match.index!;
    const hasMatchingClose = detailsCloses.some(closeIdx => closeIdx > openIdx);
    if (!hasMatchingClose) {
      cleaned = cleaned.replace(/<!-- DETAILS_START -->/, "");
    }
  }

  const detailsOpensAfterClean = [...cleaned.matchAll(/<!-- DETAILS_START -->/g)].map(m => m.index!);
  const detailsClosesAfterClean = [...cleaned.matchAll(/<!-- DETAILS_END -->/g)];

  for (const match of detailsClosesAfterClean) {
    const closeIdx = match.index!;
    const hasMatchingOpen = detailsOpensAfterClean.some(openIdx => openIdx < closeIdx);
    if (!hasMatchingOpen) {
      cleaned = cleaned.replace(/<!-- DETAILS_END -->/, "");
    }
  }

  const qcmOpens = [...cleaned.matchAll(/<!-- QCM_START -->/g)];
  const qcmCloses = [...cleaned.matchAll(/<!-- QCM_END -->/g)].map(m => m.index!);

  for (const match of qcmOpens) {
    const openIdx = match.index!;
    const hasMatchingClose = qcmCloses.some(closeIdx => closeIdx > openIdx);
    if (!hasMatchingClose) {
      cleaned = cleaned.replace(/<!-- QCM_START -->[\s\S]*$/, "");
    }
  }

  const qcmOpensAfterClean = [...cleaned.matchAll(/<!-- QCM_START -->/g)].map(m => m.index!);
  const qcmClosesAfterClean = [...cleaned.matchAll(/<!-- QCM_END -->/g)];

  for (const match of qcmClosesAfterClean) {
    const closeIdx = match.index!;
    const hasMatchingOpen = qcmOpensAfterClean.some(openIdx => openIdx < closeIdx);
    if (!hasMatchingOpen) {
      cleaned = cleaned.replace(/<!-- QCM_END -->/, "");
    }
  }

  return cleaned.trim();
}
