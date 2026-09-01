/**
 * Print the real shape of any type from an installed SDK, using the TypeScript compiler API.
 *
 * `tsc` only prints the first member of a large union, and node_modules is not always readable, so
 * this is how the SDK event unions and option bags in this repo were verified rather than guessed.
 *
 *   node --experimental-strip-types spikes/probe-type.ts '<type expression>' [propertyFilterRegex]
 */
import ts from "typescript";
import { writeFileSync } from "node:fs";

const entry = new URL("./.union-probe.ts", import.meta.url).pathname;
const target = process.argv[2] ?? "AgentSessionEvent";
const filter = process.argv[3];
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
    .filter((symbol) => !filter || new RegExp(filter, "i").test(symbol.name))
    .map((symbol) => {
      const optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0 ? "?" : "";
      return `${symbol.name}${optional}: ${checker.typeToString(checker.getTypeOfSymbol(symbol))}`;
    });
  console.log(`${tagType}`);
  for (const field of fields) console.log(`    ${field}`);
}
