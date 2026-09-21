import type { Plugin } from "vite";
import type { OutputBundle, OutputChunk } from "rollup";

const HEAVY_STARTUP_MODULE_MARKERS = [
  "/node_modules/exceljs/",
  "/node_modules/@fortune-sheet/",
  "/node_modules/xlsx/",
  "/node_modules/xlsx-js-style/",
  "/node_modules/jspdf/",
  "/node_modules/jspdf-autotable/",
  "/node_modules/html2canvas/",
  "/node_modules/recharts/",
  "/node_modules/d3-",
  "/node_modules/victory-vendor/",
  "/client/src/components/ChatWidget.tsx",
  "/client/src/components/UserNotesPanel.tsx",
  "/client/src/components/DateJumpDialog.tsx",
  "/client/src/components/KeyboardShortcuts.tsx",
  "/client/src/components/RemoteSupportRuntime.tsx",
  "/client/src/components/ApplicationInterfaceTranslator.tsx",
  "/client/src/i18n/applicationTranslations.ar.ts",
  "/client/src/i18n/applicationTranslations.fr.ts",
] as const;

const AUTHENTICATED_SHELL_MARKERS = [
  "/client/src/app/PosShell.tsx",
  "/client/src/app/PropertiesShell.tsx",
  "/client/src/app/FactoryShell.tsx",
  "/client/src/app/ErpShell.tsx",
] as const;

function normalize(value: string): string {
  return value.replaceAll("\\", "/");
}

function outputChunks(bundle: OutputBundle): OutputChunk[] {
  return Object.values(bundle).filter((item): item is OutputChunk => item.type === "chunk");
}

function staticClosure(start: OutputChunk, byFileName: Map<string, OutputChunk>): OutputChunk[] {
  const result: OutputChunk[] = [];
  const visited = new Set<string>();
  const pending = [start];

  while (pending.length > 0) {
    const chunk = pending.pop();
    if (!chunk || visited.has(chunk.fileName)) continue;
    visited.add(chunk.fileName);
    result.push(chunk);

    for (const importedFile of chunk.imports) {
      const importedChunk = byFileName.get(importedFile);
      if (importedChunk) pending.push(importedChunk);
    }
  }

  return result;
}

function moduleViolations(chunks: OutputChunk[]): string[] {
  const violations = new Set<string>();
  for (const chunk of chunks) {
    for (const moduleId of Object.keys(chunk.modules)) {
      const normalizedId = normalize(moduleId);
      for (const marker of HEAVY_STARTUP_MODULE_MARKERS) {
        if (normalizedId.includes(marker)) {
          violations.add(`${chunk.fileName}: ${normalizedId}`);
          break;
        }
      }
    }
  }
  return [...violations].sort();
}

function graphBytes(chunks: OutputChunk[]): number {
  return chunks.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.code, "utf8"), 0);
}

function kib(bytes: number): number {
  return Math.round((bytes / 1024) * 10) / 10;
}

export function initialChunkAuditPlugin(): Plugin {
  return {
    name: "erp-wave2-initial-chunk-audit",
    apply: "build",
    generateBundle(_options, bundle) {
      const chunks = outputChunks(bundle);
      const byFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
      const targets: Array<{ label: string; chunk: OutputChunk }> = [];

      for (const chunk of chunks) {
        if (chunk.isEntry) targets.push({ label: `entry:${chunk.name}`, chunk });

        const moduleIds = Object.keys(chunk.modules).map(normalize);
        for (const marker of AUTHENTICATED_SHELL_MARKERS) {
          if (moduleIds.some((id) => id.includes(marker))) {
            targets.push({ label: `shell:${marker.split("/").pop()?.replace(".tsx", "") ?? chunk.name}`, chunk });
          }
        }
      }

      const report = targets.map(({ label, chunk }) => {
        const graph = staticClosure(chunk, byFileName);
        return {
          label,
          entryFile: chunk.fileName,
          staticChunkCount: graph.length,
          staticJsKiB: kib(graphBytes(graph)),
          violations: moduleViolations(graph),
        };
      });

      const violations = report.flatMap((item) => item.violations.map((violation) => `${item.label} -> ${violation}`));
      if (violations.length > 0) {
        this.error(
          [
            "[wave2] Heavy/deferred code leaked into a startup static graph:",
            ...violations.map((item) => `  - ${item}`),
          ].join("\n")
        );
      }

      for (const item of report) {
        this.info(
          `[wave2] ${item.label} static graph: ${item.staticChunkCount} chunk(s), ~${item.staticJsKiB} KiB JS`
        );
      }

      this.emitFile({
        type: "asset",
        fileName: "wave2-initial-chunk-audit.json",
        source: JSON.stringify({ generatedAt: new Date().toISOString(), report }, null, 2),
      });
    },
  };
}
