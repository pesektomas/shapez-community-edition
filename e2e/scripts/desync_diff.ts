// Prints the first difference between two state dumps (written by failing
// determinism tests to test-results/desync/).
// Usage: npm run desync:diff -- test-results/desync/<name>-a.json test-results/desync/<name>-b.json
import { readFileSync } from "node:fs";
import { findFirstDifference } from "../helpers/game.ts";

const [fileA, fileB] = process.argv.slice(2);
if (!fileA || !fileB) {
    console.error("Usage: npm run desync:diff -- <a.json> <b.json>");
    process.exit(2);
}

const a = JSON.parse(readFileSync(fileA, "utf-8"));
const b = JSON.parse(readFileSync(fileB, "utf-8"));
const diff = findFirstDifference(a, b);
if (!diff) {
    console.log("No difference");
    process.exit(0);
}
console.log("First difference:", diff);

// Show the whole entity which differs, it usually tells what went wrong
const match = diff.match(/^\$\.dump\.entities\.(\d+)/);
if (match) {
    const index = Number(match[1]);
    console.log("\nEntity A:", JSON.stringify(a.dump.entities[index], null, 1));
    console.log("\nEntity B:", JSON.stringify(b.dump.entities[index], null, 1));
}
process.exit(1);
