#!/usr/bin/env node
/**
 * Drives buzz-agent, the ACP agent crate from block/buzz, over stdio with
 * the soil MCP server attached, and proves the round trip the buzz
 * integration claims: one agent session saves the project's working state
 * through soil_save, then a completely fresh agent process loads it back
 * through soil_load. Only the store on disk survives between the two.
 *
 * The driver is the ACP client. It speaks the three request methods
 * buzz-agent implements (initialize, session/new, session/prompt) as
 * newline-delimited JSON-RPC 2.0 on the agent's stdin and stdout, and it
 * collects the session/update notifications the agent emits. The soil MCP
 * server is passed in session/new exactly as a buzz harness passes it:
 *
 *   mcpServers: [{ name, command, args, env: [{ name, value }] }]
 *
 * Modes, chosen with --model:
 *   stand-in     (default) spawn examples/buzz/model-stand-in.mjs, a
 *                scripted OpenAI-compatible endpoint. Keyless; what CI runs.
 *   claude-shim  spawn examples/buzz/claude-shim.mjs, a real model behind a
 *                headless Claude Code session. Local only.
 *   env          use the provider variables already in the environment
 *                (BUZZ_AGENT_PROVIDER and friends) untouched.
 *
 * Usage: node examples/buzz/acp-driver.mjs --agent /path/to/buzz-agent [--model stand-in]
 *
 * Exits non-zero unless every assertion holds.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SOIL_MCP_BIN = join(REPO_ROOT, "packages", "mcp", "bin", "soil-mcp.js");

/** Phrases the driver asserts survive the round trip. The stand-in writes
 * them, and in claude-shim mode the model is instructed to record them
 * word for word, so both modes meet the same bar. */
const DECISION_PHRASES = ["stdio-only", "no-args"];
const PROJECT_ID = "buzz-session-continuity";

const SAVE_PROMPT = [
  `You are finishing a work session on the project "${PROJECT_ID}".`,
  "Project brief, all facts current as of this session:",
  "- Goal: keep an agent session's working state loadable across buzz session resets by saving a Soil handover from inside the session.",
  "- The agent runs under buzz's ACP harness; MCP servers are attached per session in session/new.",
  '- Locked decision, record it word for word: "Soil attaches over the stdio-only transport because buzz-agent advertises no http and no sse MCP capability."',
  '- Locked decision, record it word for word: "Under buzz-acp the soil server is wrapped in a no-args script because the BUZZ_ACP_MCP_COMMAND slot passes a bare command without arguments."',
  "- Current task: prove the save and load round trip from inside a real agent session.",
  "- Next step: a fresh session loads this handover and confirms the decisions survived.",
  `Task: save. Call the tool soil__soil_save exactly once, with projectId "${PROJECT_ID}", a short title, and every section you can fill honestly from this brief; leave out a section you cannot fill.`,
  "The sections argument is an object whose keys are among: projectIdentity, decisions, workflow, architecture, constraints, rejectedPaths, executiveSummary, currentTask, latestUserIntent, sessionDelta, blockers, nextSteps, openQuestions, sessionActivity, restoreInstructions, provenanceMap, safetySummary. Each value is a prose string. (This list is spelled out here because buzz-agent replaces any tool input schema larger than 4096 bytes with an empty object, so the schema itself will not tell you.)",
  "After the tool result arrives, reply with one line that contains the load code from the result.",
].join("\n");

const LOAD_PROMPT = [
  `A previous session of the project "${PROJECT_ID}" saved its working state as a Soil handover.`,
  "Task: load. Call the tool soil__soil_load exactly once, with no arguments, to fetch the latest handover.",
  "After the tool result arrives, reply with one line stating the project id and quoting the locked decision about the transport.",
].join("\n");

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`PASS ${message}`);
}

/** Start a model backend script and resolve its 127.0.0.1 port. */
function startBackend(script) {
  const child = spawn(process.execPath, [join(HERE, script)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolvePort, reject) => {
    let buffer = "";
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const match = /LISTENING (\d+)/.exec(buffer);
      if (match) resolvePort({ child, port: Number(match[1]) });
    });
    child.on("exit", (code) =>
      reject(new Error(`${script} exited early with code ${code}`)),
    );
  });
}

/** One buzz-agent process, spoken to as an ACP client. */
class Agent {
  constructor(agentPath, env) {
    this.child = spawn(agentPath, [], {
      env,
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.nextId = 1;
    this.pending = new Map();
    this.updates = [];
    this.buffer = "";
    this.child.stdout.on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer += chunk.toString("utf8");
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error)
          reject(new Error(`agent error: ${JSON.stringify(message.error)}`));
        else resolve(message.result);
      } else if (message.method === "session/update") {
        this.updates.push(message.params);
      }
    }
  }

  request(method, params, timeoutMs) {
    const id = this.nextId++;
    const frame = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    this.child.stdin.write(frame + "\n");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`${method} timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  stop() {
    this.child.stdin.end();
    this.child.kill("SIGTERM");
  }
}

/** Collect the text content of completed tool calls, keyed by tool title. */
function completedToolCalls(updates) {
  const titles = new Map();
  const results = [];
  for (const params of updates) {
    const update = params.update ?? {};
    if (update.sessionUpdate === "tool_call") {
      titles.set(update.toolCallId, update.title);
    } else if (
      update.sessionUpdate === "tool_call_update" &&
      update.status === "completed"
    ) {
      const texts = [];
      for (const item of update.content ?? []) {
        const inner = item?.content;
        if (inner?.type === "text") texts.push(inner.text);
      }
      results.push({
        title: titles.get(update.toolCallId) ?? "",
        text: texts.join("\n"),
      });
    }
  }
  return results;
}

/** Find the stored handover document in the scratch store. */
function readStoredHandover(soilHome) {
  const documents = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry.endsWith(".json") && entry !== "index.json") {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed.soilHandover) documents.push(parsed);
      }
    }
  };
  walk(soilHome);
  return documents;
}

async function runSession(agentPath, env, mcpServers, cwd, prompt, timeoutMs) {
  const agent = new Agent(agentPath, env);
  try {
    const init = await agent.request(
      "initialize",
      { protocolVersion: 1, clientCapabilities: {} },
      15_000,
    );
    const session = await agent.request(
      "session/new",
      { cwd, mcpServers },
      60_000,
    );
    if (!session.sessionId)
      throw new Error("session/new returned no sessionId");
    const outcome = await agent.request(
      "session/prompt",
      {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: prompt }],
      },
      timeoutMs,
    );
    return {
      init,
      sessionId: session.sessionId,
      stopReason: outcome.stopReason,
      toolCalls: completedToolCalls(agent.updates),
    };
  } finally {
    agent.stop();
  }
}

async function main() {
  const args = process.argv.slice(2);
  const readArg = (flag, fallback) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : fallback;
  };
  const agentPath = readArg("--agent");
  const mode = readArg("--model", "stand-in");
  if (!agentPath)
    fail(
      "usage: acp-driver.mjs --agent <buzz-agent> [--model stand-in|claude-shim|env]",
    );

  const promptTimeout = mode === "stand-in" ? 120_000 : 1_800_000;
  let backend;
  const env = { ...process.env };
  if (mode === "stand-in") {
    backend = await startBackend("model-stand-in.mjs");
    Object.assign(env, {
      BUZZ_AGENT_PROVIDER: "openai",
      OPENAI_COMPAT_API_KEY: "stand-in-not-a-key",
      OPENAI_COMPAT_MODEL: "stand-in",
      OPENAI_COMPAT_BASE_URL: `http://127.0.0.1:${backend.port}`,
      OPENAI_COMPAT_API: "chat",
    });
  } else if (mode === "claude-shim") {
    backend = await startBackend("claude-shim.mjs");
    Object.assign(env, {
      BUZZ_AGENT_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "local-shim-not-a-key",
      ANTHROPIC_MODEL: "claude-behind-local-shim",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${backend.port}`,
    });
  } else if (mode !== "env") {
    fail(`unknown --model mode: ${mode}`);
  }
  env.BUZZ_AGENT_SYSTEM_PROMPT =
    "You are an agent inside a test harness session. Follow the user's instructions exactly, use the available tools when instructed, and keep final replies to one line.";

  const soilHome = mkdtempSync(join(tmpdir(), "soil-buzz-store-"));
  const workDir = mkdtempSync(join(tmpdir(), "soil-buzz-work-"));
  const mcpServers = [
    {
      name: "soil",
      command: process.execPath,
      args: [SOIL_MCP_BIN],
      env: [{ name: "SOIL_HOME", value: soilHome }],
    },
  ];

  try {
    // Session A: a real buzz-agent process saves the working state.
    const saveRun = await runSession(
      agentPath,
      env,
      mcpServers,
      workDir,
      SAVE_PROMPT,
      promptTimeout,
    );
    const capabilities = saveRun.init?.agentCapabilities?.mcpCapabilities;
    pass(
      `initialize: agent ${saveRun.init?.agentInfo?.name ?? "unknown"} advertises mcpCapabilities ${JSON.stringify(capabilities)}`,
    );
    pass(
      `session/new accepted the soil MCP server (session ${saveRun.sessionId})`,
    );
    const saveCall = saveRun.toolCalls.find(
      (c) => c.title === "soil__soil_save",
    );
    if (!saveCall)
      fail("session A never completed a soil__soil_save tool call");
    if (!saveCall.text.includes("Saved locally as"))
      fail(`soil_save result has no save receipt: ${saveCall.text}`);
    const code = /#\d+/.exec(saveCall.text)?.[0];
    if (!code) fail(`no load code in the save receipt: ${saveCall.text}`);
    if (saveRun.stopReason !== "end_turn")
      fail(`session A stopReason was ${saveRun.stopReason}`);
    pass(`session A: soil__soil_save completed with load code ${code}`);

    // The store: the save is a real file with the decisions verbatim.
    const documents = readStoredHandover(soilHome);
    if (documents.length !== 1)
      fail(`expected 1 stored handover, found ${documents.length}`);
    const decisions = documents[0]?.sections?.decisions?.summary ?? "";
    for (const phrase of DECISION_PHRASES) {
      if (!decisions.includes(phrase))
        fail(
          `stored decisions section lost the phrase "${phrase}": ${decisions}`,
        );
    }
    if (documents[0].projectId !== PROJECT_ID)
      fail(`stored projectId is ${documents[0].projectId}`);
    pass(
      `store: one handover for ${PROJECT_ID}, decisions carry ${DECISION_PHRASES.map((p) => `"${p}"`).join(" and ")}`,
    );

    // Session B: a completely fresh agent process loads it back.
    const loadRun = await runSession(
      agentPath,
      env,
      mcpServers,
      workDir,
      LOAD_PROMPT,
      promptTimeout,
    );
    const loadCall = loadRun.toolCalls.find(
      (c) => c.title === "soil__soil_load",
    );
    if (!loadCall)
      fail("session B never completed a soil__soil_load tool call");
    for (const needle of [PROJECT_ID, ...DECISION_PHRASES]) {
      if (!loadCall.text.includes(needle))
        fail(`restore prompt lost "${needle}"`);
    }
    if (loadRun.stopReason !== "end_turn")
      fail(`session B stopReason was ${loadRun.stopReason}`);
    pass(
      `session B: fresh process, soil__soil_load returned the restore prompt with the project id and both decisions`,
    );
    console.log(`OK buzz-agent round trip complete in mode ${mode}`);
  } finally {
    backend?.child.kill("SIGTERM");
  }
}

main().catch((error) => fail(String(error?.stack ?? error)));
