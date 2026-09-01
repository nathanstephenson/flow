/**
 * Enumerate pi's AgentSessionEvent union with the TypeScript compiler API.
 *
 * node_modules is unreadable in this environment and `tsc` only prints the first member of a large
 * union, so the compiler API is the reliable way to see the real shape before fixing our schema.
 */
import ts from "typescript";
import { writeFileSync } from "node:fs";

const entry = new URL("./.union-probe.ts", import.meta.url).pathname;
const target = process.argv[2] ?? "AgentSessionEvent";
writeFileSync(
  entry,
  `import type * as pi from "@earendil-works/pi-coding-agent";\nexport declare const probe: ${target};\n`,
);

const program = ts.createProgram([entry], {
  strict: true,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2023,
  skipLibCheck: true,
  noEmit: true,
  baseUrl: "/workspace/GoodHarness",
});
const checker = program.getTypeChecker();
const source = program.getSourceFile(entry);
if (!source) throw new Error("probe source missing");

let probeType: ts.Type | undefined;
source.forEachChild((node) => {
  if (ts.isVariableStatement(node)) {
    const declaration = node.declarationList.declarations[0];
    if (declaration) probeType = checker.getTypeAtLocation(declaration);
  }
});
if (!probeType) throw new Error("probe type missing");

const members = probeType.isUnion() ? probeType.types : [probeType];
console.log(`${target} -> ${members.length} member(s)\n`);

for (const member of members) {
  const tag = member.getProperty("type");
  const tagType = tag ? checker.typeToString(checker.getTypeOfSymbol(tag)) : "?";
  const fields = member
    .getProperties()
    .filter((symbol) => symbol.name !== "type")
    .map((symbol) => {
      const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
      return `${symbol.name}${optional}: ${checker.typeToString(checker.getTypeOfSymbol(symbol))}`;
    });
  console.log(`${tagType}`);
  for (const field of fields) console.log(`    ${field}`);
}
