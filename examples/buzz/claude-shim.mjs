#!/usr/bin/env node
/**
 * A local-only Anthropic-Messages-compatible endpoint backed by a headless
 * Claude Code session, so buzz-agent can run with a real model on a machine
 * that has the `claude` CLI logged in but no raw API key in the
 * environment.
 *
 * For every request from buzz-agent this shim renders the system prompt,
 * the tool catalog and the conversation into one prompt, runs
 * `claude -p --output-format json`, and maps the model's JSON decision back
 * into the Messages API response shape buzz-agent parses. The model makes
 * every decision: which tool to call, with what input, and when to stop.
 * The shim is transport, not judgment.
 *
 * This file exists for the live local test recorded in
 * compatibility/reports/buzz-agent.md. It is not used in continuous
 * integration, which runs keyless against model-stand-in.mjs.
 *
 * Prints "LISTENING <port>" on stdout once it accepts connections.
 */

import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "soil-buzz-shim-"));
let toolUseCounter = 0;

function renderContent(content) {
  if (typeof content === "string") return content;
  const parts = [];
  for (const block of content ?? []) {
    if (block.type === "text") parts.push(block.text);
    else if (block.type === "tool_use")
      parts.push(
        `[called tool ${block.name} with input ${JSON.stringify(block.input)}]`,
      );
    else if (block.type === "tool_result")
      parts.push(`[tool result]\n${renderContent(block.content)}`);
  }
  return parts.join("\n");
}

function buildPrompt(request) {
  const lines = [];
  lines.push(
    "You are the model inside an autonomous agent loop (an ACP agent with MCP tools).",
    "Below are the agent's system prompt, the tool catalog, and the conversation so far.",
    "Decide the single next step. Do not use any tools of your own; only answer.",
    "",
    "Reply with exactly one JSON object and nothing else. No code fences, no prose around it:",
    '  {"tool_use": {"name": "<tool name>", "input": { ... }}}  to call one tool',
    '  {"final": "<assistant reply>"}  when the task is complete',
    "",
    "== agent system prompt ==",
    typeof request.system === "string"
      ? request.system
      : renderContent(request.system),
    "",
    "== tools ==",
  );
  for (const tool of request.tools ?? []) {
    lines.push(
      `- ${tool.name}: ${tool.description}`,
      `  input schema: ${JSON.stringify(tool.input_schema)}`,
    );
  }
  lines.push("", "== conversation ==");
  for (const message of request.messages ?? []) {
    lines.push(
      `${message.role.toUpperCase()}:`,
      renderContent(message.content),
      "",
    );
  }
  lines.push("== end of conversation ==", "", "Your JSON decision:");
  return lines.join("\n");
}

function callClaude(prompt) {
  const result = spawnSync("claude", ["-p", "--output-format", "json"], {
    input: prompt,
    cwd: workDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 480_000,
  });
  if (result.status !== 0) {
    throw new Error(
      `claude -p exited ${result.status}: ${(result.stderr ?? "").slice(0, 2000)}`,
    );
  }
  const output = JSON.parse(result.stdout);
  console.error(
    `[claude-shim] call done: ${output.duration_ms} ms, cost ${output.total_cost_usd} USD`,
  );
  return String(output.result ?? "");
}

function parseDecision(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // Fall through: treat the whole reply as a final answer.
    }
  }
  return { final: text };
}

function toMessagesResponse(decision) {
  if (decision.tool_use?.name) {
    toolUseCounter += 1;
    return {
      type: "message",
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        {
          type: "tool_use",
          id: `toolu_shim_${toolUseCounter}`,
          name: decision.tool_use.name,
          input: decision.tool_use.input ?? {},
        },
      ],
    };
  }
  return {
    type: "message",
    role: "assistant",
    stop_reason: "end_turn",
    content: [{ type: "text", text: String(decision.final ?? "") }],
  };
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    try {
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const decision = parseDecision(callClaude(buildPrompt(request)));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(toMessagesResponse(decision)));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { type: "shim_error", message: String(error) },
        }),
      );
    }
  });
});

server.listen(0, "127.0.0.1", () => {
  console.log(`LISTENING ${server.address().port}`);
});
