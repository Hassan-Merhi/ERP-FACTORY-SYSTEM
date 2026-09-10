import fs from "node:fs";

function replaceOne(path, before, after, label) {
  const source = fs.readFileSync(path, "utf8");
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected one anchor, found ${count}`);
  fs.writeFileSync(path, source.replace(before, after));
}

replaceOne(
  "client/src/pages/factory/factorycontainerloadingscan/ProformaProgressPanel.tsx",
  '<TableCell className="text-xs text-right font-mono py-1.5">{line.loaded}</TableCell>',
  '<TableCell className="text-xs text-right font-mono py-1.5"><span>{line.loaded}</span></TableCell>',
  "factory progress loaded wrapper"
);
replaceOne(
  "client/src/pages/factory/factorycontainerloadingscan/ProformaProgressPanel.tsx",
  "              const remaining = line.quantity - line.loaded;",
  "              const remaining = line.remaining;",
  "factory progress authoritative remaining"
);
replaceOne(
  "client/src/pages/containerloadingscan/LoadingControlsPanel.tsx",
  `                  >\n                    {line.loaded}\n                  </span>`,
  `                  >{line.loaded}</span>`,
  "erp progress loaded wrapper"
);
replaceOne(
  "tests/setup.ts",
  '  "custload",\n]);',
  '  "custload",\n  "phase4cap",\n]);',
  "factory test company prefix"
);
