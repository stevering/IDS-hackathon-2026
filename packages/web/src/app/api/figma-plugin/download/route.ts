import { NextResponse } from "next/server";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

export async function GET() {
  const publicDir = join(process.cwd(), "public", "plugin");
  const zipPath = join(publicDir, "guardian-desktop-plugin-beta.zip");
  const versionPath = join(publicDir, "version.json");

  if (!existsSync(zipPath)) {
    return NextResponse.json({ error: "Plugin not available" }, { status: 404 });
  }

  let version = "beta";
  try {
    const info = JSON.parse(readFileSync(versionPath, "utf8"));
    if (info.version) version = info.version;
  } catch { /* use default */ }

  const zip = readFileSync(zipPath);
  return new NextResponse(zip, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="guardian-desktop-plugin-${version}.zip"`,
      "Content-Length": String(zip.length),
    },
  });
}
