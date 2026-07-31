#!/usr/bin/env node
import { main } from "../dist/index.js";

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`soil: ${String(error)}\n`);
    process.exitCode = 1;
  },
);
